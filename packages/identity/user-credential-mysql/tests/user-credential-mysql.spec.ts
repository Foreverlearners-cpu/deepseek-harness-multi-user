import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MAX_LOGIN_IDENTIFIERS, UserCredentialError, type UserId } from '@deepseek-ai/dsh-user-credential'
import UserCredentialMysqlService, { USER_CREDENTIAL_MYSQL_SCHEMA_VERSION } from '../src/index.ts'
import {
  createPasswordVerifier,
  PASSWORD_VERIFIER_VERSION,
  SCRYPT_BLOCK_SIZE,
  SCRYPT_COST,
  SCRYPT_KEY_BYTES,
  SCRYPT_PARALLELIZATION,
  SCRYPT_SALT_BYTES,
  verifyPasswordVerifier,
} from '../src/password.ts'
import { FakeMysql, type FakeCredentialRow } from './fake-mysql.ts'

const contexts: Context[] = []
const userId = (value: string): UserId => value as UserId

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => context.fiber.dispose()))
})

async function setup(mysql = new FakeMysql()): Promise<{
  ctx: Context
  mysql: FakeMysql
  credentials: UserCredentialMysqlService
}> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('mysql', mysql.asService())
  await ctx.plugin(UserCredentialMysqlService)
  return { ctx, mysql, credentials: ctx.userCredentials as UserCredentialMysqlService }
}

function bareRow(id = 'user-1'): FakeCredentialRow {
  return {
    user_id: id,
    revision: 1,
    password_version: null,
    password_cost: null,
    password_block_size: null,
    password_parallelization: null,
    password_salt: null,
    password_derived_key: null,
    password_changed_at: null,
    updated_at: 1,
  }
}

describe('UserCredentialMysqlService', () => {
  it('initializes and verifies the utf8mb4 schema version', async () => {
    expect(USER_CREDENTIAL_MYSQL_SCHEMA_VERSION).toBe(1)
    const mysql = new FakeMysql()
    await setup(mysql)
    expect(mysql.schemaVersion).toBe(1)
    expect(mysql.credentialTableExists).toBe(true)
    expect(mysql.identifierTableExists).toBe(true)
    expect(mysql.queries).toContainEqual(expect.stringContaining(
      'normalized_value VARCHAR(320) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
    ))

    const existing = new FakeMysql()
    existing.schemaVersion = USER_CREDENTIAL_MYSQL_SCHEMA_VERSION
    existing.credentialTableExists = true
    existing.identifierTableExists = true
    await expect(setup(existing)).resolves.toMatchObject({ mysql: existing })
  })

  it('rejects incompatible, incomplete, and unversioned credential schemas', async () => {
    const incompatible = new FakeMysql()
    incompatible.schemaVersion = 2
    await expect(setup(incompatible)).rejects.toThrow(/incompatible schema version/)

    const incomplete = new FakeMysql()
    incomplete.schemaVersion = USER_CREDENTIAL_MYSQL_SCHEMA_VERSION
    incomplete.credentialTableExists = true
    await expect(setup(incomplete)).rejects.toThrow(/tables are incomplete/)

    const unversioned = new FakeMysql()
    unversioned.identifierTableExists = true
    await expect(setup(unversioned)).rejects.toThrow(/unversioned credential table/)
  })

  it('normalizes Unicode identifiers deterministically and rejects empty normalized values', async () => {
    const { credentials } = await setup()
    await expect(credentials.normalize({ kind: 'username', value: '  ＡLICE  ' }))
      .resolves.toEqual({ kind: 'username', value: 'alice' })
    await expect(credentials.normalize({ kind: 'username', value: '  ' }))
      .rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('uses versioned random-salt scrypt verifiers and rejects unsupported fields', async () => {
    const first = await createPasswordVerifier('same-password')
    const second = await createPasswordVerifier('same-password')
    expect(first).toMatchObject({
      version: PASSWORD_VERIFIER_VERSION,
      cost: SCRYPT_COST,
      blockSize: SCRYPT_BLOCK_SIZE,
      parallelization: SCRYPT_PARALLELIZATION,
    })
    expect(first.salt).toHaveLength(SCRYPT_SALT_BYTES)
    expect(first.derivedKey).toHaveLength(SCRYPT_KEY_BYTES)
    expect(first.salt.equals(second.salt)).toBe(false)
    await expect(verifyPasswordVerifier('same-password', first)).resolves.toBe(true)
    await expect(verifyPasswordVerifier('wrong-password', first)).resolves.toBe(false)
    await expect(verifyPasswordVerifier('same-password', { ...first, version: 2 })).rejects.toThrow(/unsupported/)
    await expect(verifyPasswordVerifier('same-password', { ...first, salt: Buffer.alloc(1) })).rejects.toThrow(/unsupported/)
    await expect(verifyPasswordVerifier('same-password', { ...first, derivedKey: Buffer.alloc(1) })).rejects.toThrow(/unsupported/)
  })

  it('never persists raw passwords and uses a dummy verifier for absent or disabled state', async () => {
    const { mysql, credentials } = await setup()
    const id = userId('user-1')
    await credentials.setPassword({ userId: id, expectedRevision: 0, password: 'plain-secret' })
    const stored = mysql.credentials.get(id)!
    expect(JSON.stringify(stored)).not.toContain('plain-secret')
    expect(stored.password_salt).toBeInstanceOf(Buffer)
    expect(stored.password_derived_key).toBeInstanceOf(Buffer)
    await expect(credentials.verifyPassword({ userId: userId('missing'), password: 'plain-secret' })).resolves.toBe(false)
    const disabled = await credentials.disablePassword({ userId: id, expectedRevision: 1 })
    await expect(credentials.verifyPassword({ userId: id, password: 'plain-secret' })).resolves.toBe(false)
    expect(disabled.passwordEnabled).toBe(false)
    expect(mysql.credentials.get(id)).toMatchObject({ password_salt: null, password_derived_key: null })
  })

  it('maps driver failures without exposing SQL diagnostics', async () => {
    const { mysql, credentials } = await setup()
    mysql.failNext = new Error('password=secret SELECT password_derived_key')
    await expect(credentials.get(userId('user-1'))).rejects.toMatchObject({
      code: 'provider-unavailable',
      message: 'user-credential: credential Provider failed',
    })
  })

  it('rolls back failed mutations and maps rollback failure', async () => {
    const { mysql, credentials } = await setup()
    const added = await credentials.addIdentifier({ userId: userId('user-1'), expectedRevision: 0, kind: 'email', value: 'one@example.com' })
    mysql.failSql = 'DELETE FROM dsh_user_login_identifiers'
    await expect(credentials.removeIdentifier({ userId: added.userId, expectedRevision: added.revision, kind: 'email', value: 'one@example.com' }))
      .rejects.toBeInstanceOf(UserCredentialError)
    expect(await credentials.get(added.userId)).toEqual(added)

    mysql.rollbackFailure = new Error('rollback connection lost')
    await expect(credentials.removeIdentifier({ userId: added.userId, expectedRevision: added.revision + 1, kind: 'email', value: 'one@example.com' }))
      .rejects.toMatchObject({ code: 'provider-unavailable', message: 'user-credential: credential Provider failed' })
  })

  it('classifies missing aggregates, stale revisions, and duplicate races', async () => {
    const { mysql, credentials } = await setup()
    await expect(credentials.removeIdentifier({ userId: userId('missing'), expectedRevision: 1, kind: 'email', value: 'a@example.com' }))
      .rejects.toMatchObject({ code: 'credential-not-found' })

    const added = await credentials.addIdentifier({ userId: userId('user-1'), expectedRevision: 0, kind: 'email', value: 'a@example.com' })
    await expect(credentials.setPassword({ userId: added.userId, expectedRevision: 0, password: 'secret' }))
      .rejects.toMatchObject({ code: 'revision-conflict' })

    mysql.duplicateNextCredential = true
    await expect(credentials.setPassword({ userId: userId('user-2'), expectedRevision: 0, password: 'secret' }))
      .rejects.toMatchObject({ code: 'revision-conflict' })

    mysql.duplicateNextIdentifier = true
    await expect(credentials.addIdentifier({ userId: userId('user-3'), expectedRevision: 0, kind: 'email', value: 'b@example.com' }))
      .rejects.toMatchObject({ code: 'identifier-conflict' })
  })

  it('enforces the aggregate identifier bound', async () => {
    const { credentials } = await setup()
    const id = userId('user-1')
    let revision = 0
    for (let index = 0; index < MAX_LOGIN_IDENTIFIERS; index += 1) {
      const current = await credentials.addIdentifier({ userId: id, expectedRevision: revision, kind: 'username', value: `user-${String(index)}` })
      revision = current.revision
    }
    await expect(credentials.addIdentifier({ userId: id, expectedRevision: revision, kind: 'username', value: 'overflow' }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('maps non-duplicate insert failures and disabled password changes', async () => {
    const { mysql, credentials } = await setup()
    mysql.failSql = 'INSERT INTO dsh_user_credentials'
    await expect(credentials.setPassword({ userId: userId('user-1'), expectedRevision: 0, password: 'secret' }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.failSql = 'INSERT INTO dsh_user_login_identifiers'
    await expect(credentials.addIdentifier({ userId: userId('user-2'), expectedRevision: 0, kind: 'email', value: 'a@example.com' }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })

    const added = await credentials.addIdentifier({ userId: userId('user-3'), expectedRevision: 0, kind: 'email', value: 'b@example.com' })
    await expect(credentials.changePassword({ userId: added.userId, expectedRevision: added.revision, currentPassword: 'old', newPassword: 'new' }))
      .rejects.toMatchObject({ code: 'password-not-set' })
  })

  it('handles string numerics, negative numerics, and a missing locked verifier row', async () => {
    const { mysql, credentials } = await setup()
    const row = bareRow()
    row.revision = '1'
    row.updated_at = '2'
    mysql.credentials.set(row.user_id, row)
    await expect(credentials.get(userId(row.user_id))).resolves.toMatchObject({ revision: 1, updatedAt: 2 })

    row.updated_at = -1
    await expect(credentials.get(userId(row.user_id))).rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.credentials.clear()
    await credentials.setPassword({ userId: userId('user-2'), expectedRevision: 0, password: 'old' })
    mysql.hideNextPostUpdate = true
    await expect(credentials.changePassword({ userId: userId('user-2'), expectedRevision: 1, currentPassword: 'old', newPassword: 'new' }))
      .rejects.toMatchObject({ code: 'invalid-credential' })
  })

  it('rejects malformed database metadata and impossible update outcomes', async () => {
    const { mysql, credentials } = await setup()
    const malformed = bareRow()
    malformed.revision = Number.MAX_SAFE_INTEGER + 1
    mysql.credentials.set(malformed.user_id, malformed)
    await expect(credentials.get(userId(malformed.user_id))).rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.credentials.set('user-1', bareRow())
    const row = mysql.credentials.get('user-1')!
    row.password_version = 1
    await expect(credentials.get(userId('user-1'))).rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.credentials.set('user-1', bareRow())
    mysql.zeroNextRevisionUpdate = true
    await expect(credentials.addIdentifier({ userId: userId('user-1'), expectedRevision: 1, kind: 'email', value: 'zero@example.com' }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.hideNextPostUpdate = true
    await expect(credentials.addIdentifier({ userId: userId('user-1'), expectedRevision: 1, kind: 'email', value: 'gone@example.com' }))
      .rejects.toMatchObject({ code: 'provider-unavailable' })
  })
})
