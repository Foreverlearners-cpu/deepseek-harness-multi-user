import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { authenticationRequestId, credentialId, tokenFamilyId, userId } from '@deepseek-ai/dsh-auth'
import AuthTokenMysql, { AUTH_TOKEN_MYSQL_SCHEMA_VERSION } from '../src/index.ts'
import { FakeMysql, type FakeCredentialRow, type FakeFamilyRow } from './fake-mysql.ts'

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => { resolve = settle })
  return { promise, resolve }
}

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

  it('serializes concurrent schema initialization and rechecks state inside the advisory lock', async () => {
    const mysql = new FakeMysql()
    mysql.concurrentConnections = true
    const entered = deferred()
    const release = deferred()
    let first = true
    mysql.afterSchemaLock = async () => {
      if (!first) return
      first = false
      entered.resolve()
      await release.promise
    }
    const firstSetup = setup(mysql)
    await entered.promise
    let secondSettled = false
    const secondSetup = setup(mysql).finally(() => { secondSettled = true })
    await Promise.resolve()
    expect(secondSettled).toBe(false)
    release.resolve()
    await expect(Promise.all([firstSetup, secondSetup])).resolves.toHaveLength(2)
    expect(mysql.queries.filter(query => query.startsWith('CREATE TABLE dsh_auth_token_families'))).toHaveLength(1)
    expect(mysql.queries.filter(query => query.startsWith('CREATE TABLE dsh_auth_refresh_credentials'))).toHaveLength(1)
    expect(mysql.queries.filter(query => query.startsWith('SELECT RELEASE_LOCK('))).toHaveLength(2)
  })

  it('fails safe when the schema advisory lock cannot be acquired or released', async () => {
    const unavailable = new FakeMysql()
    unavailable.schemaLockResult = 0
    await expect(setup(unavailable)).rejects.toMatchObject({ code: 'provider-unavailable' })

    const releaseFailure = new FakeMysql()
    releaseFailure.schemaUnlockResult = null
    await expect(setup(releaseFailure)).rejects.toMatchObject({ code: 'provider-unavailable' })

    const combined = new FakeMysql()
    combined.schemaVersion = 2
    combined.schemaUnlockResult = 0
    await expect(setup(combined)).rejects.toMatchObject({ code: 'provider-unavailable' })
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

  it('returns family and credentials from one shared-lock snapshot', async () => {
    const { mysql, authTokens } = await setup()
    const issued = await authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
    const entered = deferred()
    const release = deferred()
    mysql.afterSharedFamilyRead = async () => {
      mysql.afterSharedFamilyRead = undefined
      entered.resolve()
      await release.promise
    }
    const inspection = authTokens.inspect({
      requestId, signal, target: { kind: 'token-family', tokenFamilyId: issued.family.tokenFamilyId },
    })
    await entered.promise
    authTokens.clock = 1_100
    let rotationSettled = false
    const rotation = authTokens.rotate({ requestId, signal, refreshToken: issued.refreshToken.value })
      .finally(() => { rotationSettled = true })
    await Promise.resolve()
    expect(rotationSettled).toBe(false)
    release.resolve()
    await expect(inspection).resolves.toMatchObject({
      families: [{ revision: 1 }],
      credentials: [{ status: 'active' }],
    })
    await expect(rotation).resolves.toMatchObject({ family: { revision: 2 } })
  })

  it('rejects malformed family and credential rows as provider-unavailable', async () => {
    const familyMutations: Array<(row: FakeFamilyRow) => void> = [
      (row) => { row.principal_kind = 'invalid' as never },
      (row) => { row.status = 'invalid' as never },
      (row) => { row.updated_at = 999 },
      (row) => { row.expires_at = 1_000 },
      (row) => { row.revision = 0 },
      (row) => { row.revoked_at = 1_100 },
      (row) => { row.revocation_reason = 'requested' },
      (row) => { row.status = 'revoked'; row.revoked_at = null; row.revocation_reason = 'requested' },
      (row) => { row.status = 'revoked'; row.revoked_at = 999; row.revocation_reason = 'requested' },
      (row) => { row.status = 'revoked'; row.revoked_at = 1_100; row.revocation_reason = 'invalid' as never },
    ]
    for (const mutate of familyMutations) {
      const { mysql, authTokens } = await setup()
      const issued = await authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
      mutate(mysql.families.get(issued.family.tokenFamilyId)!)
      await expect(authTokens.inspect({
        requestId, signal, target: { kind: 'token-family', tokenFamilyId: issued.family.tokenFamilyId },
      })).rejects.toMatchObject({ code: 'provider-unavailable' })
    }

    const malformedFamily = await setup()
    const familyIssue = await malformedFamily.authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
    malformedFamily.mysql.families.get(familyIssue.family.tokenFamilyId)!.token_family_id = ''
    await expect(malformedFamily.authTokens.inspect({
      requestId, signal, target: { kind: 'principal', principal },
    })).rejects.toMatchObject({ code: 'provider-unavailable' })

    const malformedPrincipal = await setup()
    const principalIssue = await malformedPrincipal.authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
    malformedPrincipal.mysql.families.get(principalIssue.family.tokenFamilyId)!.principal_id = ''
    await expect(malformedPrincipal.authTokens.inspect({
      requestId, signal, target: { kind: 'token-family', tokenFamilyId: principalIssue.family.tokenFamilyId },
    })).rejects.toMatchObject({ code: 'provider-unavailable' })

    const credentialMutations: Array<(row: FakeCredentialRow) => void> = [
      (row) => { row.token_family_id = '' },
      (row) => { row.digest = 'not-a-digest' },
      (row) => { row.status = 'invalid' as never },
      (row) => { row.expires_at = 1_000 },
      (row) => { row.rotated_at = 1_100 },
      (row) => { row.status = 'rotated'; row.rotated_at = null; row.replaced_by = 'replacement' },
      (row) => { row.status = 'rotated'; row.rotated_at = 999; row.replaced_by = 'replacement' },
      (row) => { row.status = 'rotated'; row.rotated_at = 1_100; row.replaced_by = '' },
      (row) => { row.status = 'rotated'; row.rotated_at = 1_100; row.replaced_by = 'replacement'; row.revoked_at = 1_100 },
      (row) => { row.status = 'revoked'; row.revoked_at = null },
      (row) => { row.status = 'revoked'; row.revoked_at = 999 },
      (row) => { row.status = 'revoked'; row.revoked_at = 1_100; row.replaced_by = 'replacement' },
    ]
    for (const mutate of credentialMutations) {
      const { mysql, authTokens } = await setup()
      const issued = await authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
      mutate(mysql.credentials.get(issued.refreshToken.credentialId)!)
      await expect(authTokens.inspect({
        requestId, signal, target: { kind: 'credential', credentialId: issued.refreshToken.credentialId },
      })).rejects.toMatchObject({ code: 'provider-unavailable' })
    }

    const malformedCredential = await setup()
    const credentialIssue = await malformedCredential.authTokens.issueFamily({
      requestId, signal, principal, expiresAt: 2_000,
    })
    malformedCredential.mysql.credentials.get(credentialIssue.refreshToken.credentialId)!.credential_id = ''
    await expect(malformedCredential.authTokens.inspect({
      requestId, signal, target: { kind: 'token-family', tokenFamilyId: credentialIssue.family.tokenFamilyId },
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
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
