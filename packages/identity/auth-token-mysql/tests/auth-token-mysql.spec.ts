import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { authenticationRequestId, credentialId, tokenFamilyId, userId } from '@deepseek-ai/dsh-auth'
import AuthTokenMysql, { AUTH_TOKEN_MYSQL_SCHEMA_VERSION } from '../src/index.ts'
import { FakeMysql } from './fake-mysql.ts'

class FixedAuthTokenMysql extends AuthTokenMysql {
  private sequence = 0
  clock = 1_000
  protected override now(): number { return this.clock }
  protected override generateId(kind: 'family' | 'refresh'): string { return `${kind}-${String(++this.sequence)}` }
  protected override generateRefreshSecret(): string { return `dsh_rt_secret-${String(++this.sequence)}` }
}

const contexts: Context[] = []
const signal = new AbortController().signal
const requestId = authenticationRequestId('request-1')
const principal = { kind: 'user' as const, id: userId('user-1') }

afterEach(async () => Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose())))

async function setup(mysql = new FakeMysql()): Promise<{ mysql: FakeMysql; authTokens: FixedAuthTokenMysql }> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('mysql', mysql.asService())
  await ctx.plugin(FixedAuthTokenMysql)
  return { mysql, authTokens: ctx.authTokens as FixedAuthTokenMysql }
}

describe('AuthTokenMysql', () => {
  it('initializes, verifies, and claims both Provider-owned tables', async () => {
    const mysql = new FakeMysql()
    await setup(mysql)
    expect(AUTH_TOKEN_MYSQL_SCHEMA_VERSION).toBe(1)
    expect(mysql).toMatchObject({ schemaVersion: 1, familyTableExists: true, credentialTableExists: true })
    expect(mysql.queries).toContainEqual(expect.stringContaining('digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin'))

    const existing = new FakeMysql()
    existing.schemaVersion = 1
    existing.familyTableExists = true
    existing.credentialTableExists = true
    await expect(setup(existing)).resolves.toMatchObject({ mysql: existing })
  })

  it('rejects incompatible, unversioned, and incomplete schema state without driver details', async () => {
    const incompatible = new FakeMysql()
    incompatible.schemaVersion = 2
    await expect(setup(incompatible)).rejects.toMatchObject({
      code: 'provider-unavailable', message: 'auth-token-mysql: schema initialization failed',
    })

    const unversioned = new FakeMysql()
    unversioned.familyTableExists = true
    await expect(setup(unversioned)).rejects.toMatchObject({ code: 'provider-unavailable' })

    const incomplete = new FakeMysql()
    incomplete.schemaVersion = 1
    incomplete.familyTableExists = true
    await expect(setup(incomplete)).rejects.toMatchObject({ code: 'provider-unavailable' })

    const failed = new FakeMysql()
    failed.failNext = new Error('password=secret CREATE TABLE')
    const error = await setup(failed).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'provider-unavailable', message: 'auth-token-mysql: schema initialization failed' })
    expect(JSON.stringify(error)).not.toContain('password=secret')
  })

  it('rolls back create failures and maps storage diagnostics to a stable safe error', async () => {
    const { mysql, authTokens } = await setup()
    mysql.failNext = new Error('SELECT digest FROM secret_table password=hidden')
    const error = await authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 }).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'provider-unavailable', message: 'auth-token-mysql: storage operation failed' })
    expect(JSON.stringify(error)).not.toContain('secret_table')
    expect(mysql.families.size).toBe(0)

    mysql.rejectNextConnection = new Error('pool password=hidden')
    const poolError = await authTokens.inspect({ requestId, signal, target: { kind: 'principal', principal } })
      .catch((cause: unknown) => cause)
    expect(poolError).toMatchObject({ code: 'provider-unavailable', message: 'auth-token-mysql: storage operation failed' })
    expect(JSON.stringify(poolError)).not.toContain('password=hidden')
  })

  it('maps rollback failure and impossible locked-update outcomes without exposing their causes', async () => {
    const rollbackMysql = new FakeMysql()
    const rollbackHarness = await setup(rollbackMysql)
    rollbackMysql.failNext = new Error('insert failed with digest')
    rollbackMysql.rollbackFailure = new Error('rollback password=hidden')
    await expect(rollbackHarness.authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 }))
      .rejects.toMatchObject({ code: 'provider-unavailable', message: 'auth-token-mysql: transaction rollback failed' })

    const { mysql, authTokens } = await setup()
    const issued = await authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
    mysql.zeroNextUpdate = true
    authTokens.clock = 1_100
    await expect(authTokens.rotate({ requestId, signal, refreshToken: issued.refreshToken.value }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
    expect((await authTokens.inspect({
      requestId, signal, target: { kind: 'token-family', tokenFamilyId: issued.family.tokenFamilyId },
    })).families[0]).toMatchObject({ revision: 1, status: 'active' })
  })

  it('rejects orphaned and malformed durable records through safe categories', async () => {
    const { mysql, authTokens } = await setup()
    const orphanSecret = 'dsh_rt_orphan'
    mysql.credentials.set('orphan', {
      credential_id: 'orphan', token_family_id: 'missing-family',
      digest: createHash('sha256').update(orphanSecret).digest('hex'), status: 'active',
      issued_at: 1_000, expires_at: 2_000, rotated_at: null, replaced_by: null, revoked_at: null,
    })
    await expect(authTokens.rotate({ requestId, signal, refreshToken: orphanSecret }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
    expect((await authTokens.inspect({
      requestId, signal, target: { kind: 'credential', credentialId: credentialId('orphan') },
    })).families).toEqual([])

    const issued = await authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
    await expect(authTokens.inspect({
      requestId, signal, target: { kind: 'credential', credentialId: issued.refreshToken.credentialId },
    })).resolves.toMatchObject({ families: [{ tokenFamilyId: issued.family.tokenFamilyId }] })
    const family = mysql.families.get(issued.family.tokenFamilyId)!
    family.created_at = 'not-an-integer'
    await expect(authTokens.inspect({
      requestId, signal, target: { kind: 'token-family', tokenFamilyId: issued.family.tokenFamilyId },
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('returns empty exact-target results and idempotently preserves revoked families', async () => {
    const { authTokens } = await setup()
    await expect(authTokens.revoke({
      requestId, signal, target: { kind: 'credential', credentialId: credentialId('missing') },
    })).resolves.toBeUndefined()
    await expect(authTokens.revoke({
      requestId, signal, target: { kind: 'token-family', tokenFamilyId: tokenFamilyId('missing') },
    })).resolves.toBeUndefined()
    expect((await authTokens.inspect({ requestId, signal, target: { kind: 'principal', principal } })).families).toEqual([])
  })

  it('decodes every principal kind and BIGINT string from durable rows', async () => {
    const { mysql, authTokens } = await setup()
    mysql.families.set('service-family', {
      token_family_id: 'service-family', principal_kind: 'service-account', principal_id: 'service-1',
      status: 'active', created_at: '1000', updated_at: '1000', expires_at: '2000', revision: '1',
      revoked_at: null, revocation_reason: null,
    })
    mysql.families.set('local-family', {
      token_family_id: 'local-family', principal_kind: 'local', principal_id: 'local-1',
      status: 'active', created_at: 1_001, updated_at: 1_001, expires_at: 2_000, revision: 1,
      revoked_at: null, revocation_reason: null,
    })
    await expect(authTokens.inspect({
      requestId, signal, target: { kind: 'token-family', tokenFamilyId: tokenFamilyId('service-family') },
    })).resolves.toMatchObject({ families: [{ principal: { kind: 'service-account', id: 'service-1' } }] })
    await expect(authTokens.inspect({
      requestId, signal, target: { kind: 'token-family', tokenFamilyId: tokenFamilyId('local-family') },
    })).resolves.toMatchObject({ families: [{ principal: { kind: 'local', id: 'local-1' } }] })
  })

  it('rejects locked credential relation changes and impossible update counts atomically', async () => {
    for (const mutation of ['hidden', 'digest', 'family'] as const) {
      const { mysql, authTokens } = await setup()
      const issued = await authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
      if (mutation === 'hidden') mysql.hideNextLockedCredential = true
      else if (mutation === 'digest') mysql.mutateNextLockedCredentialDigest = 'f'.repeat(64)
      else mysql.mutateNextLockedCredentialFamily = 'other-family'
      authTokens.clock = 1_100
      await expect(authTokens.rotate({ requestId, signal, refreshToken: issued.refreshToken.value }))
        .rejects.toMatchObject({ code: 'provider-unavailable' })
    }

    const { mysql, authTokens } = await setup()
    const issued = await authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
    mysql.zeroUpdateCountdown = 2
    authTokens.clock = 1_100
    await expect(authTokens.rotate({ requestId, signal, refreshToken: issued.refreshToken.value }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('rejects revoked credentials and family-only expiry', async () => {
    const revokedHarness = await setup()
    const revoked = await revokedHarness.authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
    revokedHarness.mysql.credentials.get(revoked.refreshToken.credentialId)!.status = 'revoked'
    revokedHarness.mysql.credentials.get(revoked.refreshToken.credentialId)!.revoked_at = 1_050
    revokedHarness.authTokens.clock = 1_100
    await expect(revokedHarness.authTokens.rotate({
      requestId, signal, refreshToken: revoked.refreshToken.value,
    })).rejects.toMatchObject({ code: 'token-family-revoked' })

    const expiryHarness = await setup()
    const expired = await expiryHarness.authTokens.issueFamily({ requestId, signal, principal, expiresAt: 1_100 })
    expiryHarness.mysql.credentials.get(expired.refreshToken.credentialId)!.expires_at = 1_200
    expiryHarness.authTokens.clock = 1_100
    await expect(expiryHarness.authTokens.rotate({
      requestId, signal, refreshToken: expired.refreshToken.value,
    })).rejects.toMatchObject({ code: 'refresh-token-expired' })
  })

  it('rejects changed credential revoke targets and failed family revocation updates', async () => {
    const changedHarness = await setup()
    const changed = await changedHarness.authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
    changedHarness.mysql.mutateNextLockedCredentialFamily = 'other-family'
    await expect(changedHarness.authTokens.revoke({
      requestId, signal, target: { kind: 'credential', credentialId: changed.refreshToken.credentialId },
    })).rejects.toMatchObject({ code: 'provider-unavailable' })

    const failedHarness = await setup()
    const failed = await failedHarness.authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
    failedHarness.mysql.zeroNextUpdate = true
    await expect(failedHarness.authTokens.revoke({
      requestId, signal, target: { kind: 'token-family', tokenFamilyId: failed.family.tokenFamilyId },
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })
})
