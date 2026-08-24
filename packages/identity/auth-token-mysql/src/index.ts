/** MySQL persistence Provider for opaque refresh-token families.
 * @module @deepseek-ai/dsh-auth-token-mysql
 */

import { Service } from '@deepseek-ai/cordis'
import {
  credentialId,
  localPrincipalId,
  serviceAccountId,
  tokenFamilyId,
  userId,
  type CredentialInspectTarget,
} from '@deepseek-ai/dsh-auth'
import AuthTokenService, {
  AuthTokenError,
  type AuthenticatedPrincipal,
  type AuthTokenInspectRequest,
  type CredentialId,
  type RefreshCredentialRecord,
  type RefreshTokenDigest,
  type RefreshTokenRotationCommit,
  type RefreshTokenRotationInput,
  type TokenFamilyCreateInput,
  type TokenFamilyId,
  type TokenFamilyMutationCommit,
  type TokenFamilyRecord,
  type TokenRevocationCommit,
  type TokenRevocationInput,
} from '@deepseek-ai/dsh-auth-token'
import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { initializeSchema } from './schema.ts'

export { AUTH_TOKEN_MYSQL_SCHEMA_VERSION } from './schema.ts'

interface FamilyRow extends RowDataPacket {
  token_family_id: string
  principal_kind: string
  principal_id: string
  status: string
  created_at: number | string
  updated_at: number | string
  expires_at: number | string
  revision: number | string
  revoked_at: number | string | null
  revocation_reason: string | null
}

interface CredentialRow extends RowDataPacket {
  credential_id: string
  token_family_id: string
  digest: string
  status: string
  issued_at: number | string
  expires_at: number | string
  rotated_at: number | string | null
  replaced_by: string | null
  revoked_at: number | string | null
}

type RevokedFamilyRecord = TokenFamilyRecord & Required<Pick<TokenFamilyRecord, 'revokedAt' | 'revocationReason'>>

const FAMILY_COLUMNS = `token_family_id, principal_kind, principal_id, status, created_at,
  updated_at, expires_at, revision, revoked_at, revocation_reason`
const CREDENTIAL_COLUMNS = `credential_id, token_family_id, digest, status, issued_at,
  expires_at, rotated_at, replaced_by, revoked_at`
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

function safeInteger(value: number | string, field: string): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw unavailable(`invalid stored ${field}`)
  return numeric
}

function nullableInteger(value: number | string | null, field: string): number | undefined {
  return value === null ? undefined : safeInteger(value, field)
}

function principal(kind: string, id: string): AuthenticatedPrincipal {
  switch (kind) {
    case 'user': return { kind, id: userId(id) }
    case 'service-account': return { kind, id: serviceAccountId(id) }
    case 'local': return { kind, id: localPrincipalId(id) }
    default: throw unavailable('invalid stored principal kind')
  }
}

function familyRecord(row: FamilyRow): TokenFamilyRecord {
  if (row.status !== 'active' && row.status !== 'revoked') throw unavailable('invalid stored family status')
  const common = {
    tokenFamilyId: tokenFamilyId(row.token_family_id),
    principal: principal(row.principal_kind, row.principal_id),
    createdAt: safeInteger(row.created_at, 'family created_at'),
    updatedAt: safeInteger(row.updated_at, 'family updated_at'),
    expiresAt: safeInteger(row.expires_at, 'family expires_at'),
    revision: safeInteger(row.revision, 'family revision'),
  }
  const revokedAt = nullableInteger(row.revoked_at, 'family revoked_at')
  if (common.updatedAt < common.createdAt || common.expiresAt <= common.createdAt || common.revision < 1) {
    throw unavailable('invalid stored token family chronology')
  }
  if (row.status === 'active') {
    if (revokedAt !== undefined || row.revocation_reason !== null) {
      throw unavailable('invalid stored active token family')
    }
    return { ...common, status: 'active' }
  }
  if (revokedAt === undefined || revokedAt < common.updatedAt
    || (row.revocation_reason !== 'requested' && row.revocation_reason !== 'refresh-token-reuse')) {
    throw unavailable('invalid stored revoked token family')
  }
  return { ...common, status: 'revoked', revokedAt, revocationReason: row.revocation_reason }
}

function credentialRecord(row: CredentialRow): RefreshCredentialRecord {
  if (!DIGEST_PATTERN.test(row.digest)) throw unavailable('invalid stored refresh digest')
  if (row.status !== 'active' && row.status !== 'rotated' && row.status !== 'revoked') {
    throw unavailable('invalid stored refresh credential status')
  }
  const credential = credentialId(row.credential_id)
  const family = tokenFamilyId(row.token_family_id)
  const issuedAt = safeInteger(row.issued_at, 'credential issued_at')
  const expiresAt = safeInteger(row.expires_at, 'credential expires_at')
  if (expiresAt <= issuedAt) throw unavailable('invalid stored refresh credential chronology')
  const rotatedAt = nullableInteger(row.rotated_at, 'credential rotated_at')
  const revokedAt = nullableInteger(row.revoked_at, 'credential revoked_at')
  const common = {
    credentialId: credential,
    tokenFamilyId: family,
    digest: row.digest as RefreshTokenDigest,
    issuedAt,
    expiresAt,
  }
  if (row.status === 'active') {
    if (rotatedAt !== undefined || row.replaced_by !== null || revokedAt !== undefined) {
      throw unavailable('invalid stored active refresh credential')
    }
    return { ...common, status: 'active' }
  }
  if (row.status === 'rotated') {
    if (rotatedAt === undefined || rotatedAt < issuedAt || row.replaced_by === null || revokedAt !== undefined) {
      throw unavailable('invalid stored rotated refresh credential')
    }
    return { ...common, status: 'rotated', rotatedAt, replacedBy: credentialId(row.replaced_by) }
  }
  if (revokedAt === undefined || revokedAt < issuedAt || rotatedAt !== undefined || row.replaced_by !== null) {
    throw unavailable('invalid stored revoked refresh credential')
  }
  return { ...common, status: 'revoked', revokedAt }
}

function unavailable(message: string): AuthTokenError {
  return new AuthTokenError('provider-unavailable', `auth-token-mysql: ${message}`)
}

function expected(code: 'invalid-input' | 'refresh-token-expired' | 'refresh-token-invalid' | 'token-family-revoked', message: string): AuthTokenError {
  return new AuthTokenError(code, `auth-token-mysql: ${message}`)
}

async function rollback(connection: MysqlConnection, cause: unknown): Promise<never> {
  try {
    await connection.rollback()
  } catch {
    throw unavailable('transaction rollback failed')
  }
  if (cause instanceof AuthTokenError) throw cause
  throw unavailable('storage operation failed')
}

async function transaction<T>(connection: MysqlConnection, callback: () => Promise<T>): Promise<T> {
  await connection.beginTransaction()
  try {
    const result = await callback()
    await connection.commit()
    return result
  } catch (cause) {
    return rollback(connection, cause)
  }
}

/** Durable `ctx.authTokens` Provider backed by the injected MySQL connection service. */
export class AuthTokenMysql extends AuthTokenService {
  static inject = ['mysql']

  /** Initialize and verify the Provider-owned schema before serving requests. */
  async [Service.init](): Promise<void> {
    try {
      await this.ctx.mysql.connection(initializeSchema)
    } catch {
      throw unavailable('schema initialization failed')
    }
  }

  protected createFamilyRecord(
    input: TokenFamilyCreateInput,
    prepare: () => Promise<void>,
  ): Promise<TokenFamilyCreateInput> {
    return this.storage(connection => transaction(connection, async () => {
      const family = input.family
      await connection.execute(
        `INSERT INTO dsh_auth_token_families
          (token_family_id, principal_kind, principal_id, status, created_at, updated_at, expires_at, revision,
           revoked_at, revocation_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        [family.tokenFamilyId, family.principal.kind, family.principal.id, family.status, family.createdAt,
          family.updatedAt, family.expiresAt, family.revision],
      )
      const credential = input.credential
      await connection.execute(
        `INSERT INTO dsh_auth_refresh_credentials
          (credential_id, token_family_id, digest, status, issued_at, expires_at, rotated_at, replaced_by, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
        [credential.credentialId, credential.tokenFamilyId, credential.digest, credential.status,
          credential.issuedAt, credential.expiresAt],
      )
      await prepare()
      return input
    }))
  }

  protected rotateFamilyRecord(
    input: RefreshTokenRotationInput,
    prepare: (candidate: RefreshTokenRotationCommit) => Promise<void>,
  ): Promise<RefreshTokenRotationCommit> {
    return this.storage(connection => transaction(connection, async () => {
      const initial = await this.credentialByDigest(connection, input.digest)
      if (initial === undefined) throw expected('refresh-token-invalid', 'refresh token is invalid')
      const previousFamily = await this.familyById(connection, initial.tokenFamilyId)
      if (previousFamily === undefined) throw unavailable('credential family is missing')
      const credential = await this.credentialById(connection, initial.credentialId, true)
      if (credential === undefined || credential.digest !== input.digest
        || credential.tokenFamilyId !== previousFamily.tokenFamilyId) {
        throw unavailable('locked credential relation changed')
      }
      if (previousFamily.status === 'revoked') throw expected('token-family-revoked', 'token family is revoked')
      if (input.time >= credential.expiresAt || input.time >= previousFamily.expiresAt) {
        throw expected('refresh-token-expired', 'refresh token is expired')
      }
      if (credential.status === 'rotated') {
        const currentFamily: RevokedFamilyRecord = {
          ...previousFamily,
          status: 'revoked',
          updatedAt: input.time,
          revision: previousFamily.revision + 1,
          revokedAt: input.time,
          revocationReason: 'refresh-token-reuse',
        }
        await this.revokeFamily(connection, currentFamily)
        await this.revokeActiveCredentials(connection, currentFamily.tokenFamilyId, input.time)
        return { kind: 'reused', previousFamily, currentFamily, reusedCredential: credential }
      }
      if (credential.status === 'revoked') throw expected('token-family-revoked', 'refresh credential is revoked')
      const consumedCredential: RefreshCredentialRecord = {
        ...credential,
        status: 'rotated',
        rotatedAt: input.time,
        replacedBy: input.replacementCredentialId,
      }
      const replacementCredential: RefreshCredentialRecord = {
        credentialId: input.replacementCredentialId,
        tokenFamilyId: previousFamily.tokenFamilyId,
        digest: input.replacementDigest,
        status: 'active',
        issuedAt: input.time,
        expiresAt: previousFamily.expiresAt,
      }
      const currentFamily: TokenFamilyRecord = {
        ...previousFamily,
        updatedAt: input.time,
        revision: previousFamily.revision + 1,
      }
      const [consumed] = await connection.execute<ResultSetHeader>(
        `UPDATE dsh_auth_refresh_credentials
         SET status = 'rotated', rotated_at = ?, replaced_by = ?
         WHERE credential_id = ? AND status = 'active'`,
        [input.time, input.replacementCredentialId, credential.credentialId],
      )
      if (consumed.affectedRows !== 1) throw unavailable('locked refresh credential was not consumed')
      await connection.execute(
        `INSERT INTO dsh_auth_refresh_credentials
          (credential_id, token_family_id, digest, status, issued_at, expires_at, rotated_at, replaced_by, revoked_at)
         VALUES (?, ?, ?, 'active', ?, ?, NULL, NULL, NULL)`,
        [replacementCredential.credentialId, replacementCredential.tokenFamilyId, replacementCredential.digest,
          replacementCredential.issuedAt, replacementCredential.expiresAt],
      )
      const [updated] = await connection.execute<ResultSetHeader>(
        'UPDATE dsh_auth_token_families SET updated_at = ?, revision = revision + 1 WHERE token_family_id = ? AND revision = ?',
        [input.time, previousFamily.tokenFamilyId, previousFamily.revision],
      )
      if (updated.affectedRows !== 1) throw unavailable('locked token family was not advanced')
      const commit: RefreshTokenRotationCommit = {
        kind: 'rotated', previousFamily, currentFamily, consumedCredential, replacementCredential,
      }
      await prepare(commit)
      return commit
    }))
  }

  protected inspectRecords(target: AuthTokenInspectRequest['target']): Promise<Readonly<{
    families: readonly TokenFamilyRecord[]
    credentials: readonly RefreshCredentialRecord[]
  }>> {
    return this.storage(connection => transaction(connection, async () => {
      const families = await this.familiesForTarget(connection, target, 'share')
      const credentials = await this.credentialsForFamilies(connection, families.map(value => value.tokenFamilyId))
      return { families, credentials }
    }))
  }

  protected revokeRecords(input: TokenRevocationInput): Promise<TokenRevocationCommit> {
    return this.storage(connection => transaction(connection, async () => {
      let matchedCredential: RefreshCredentialRecord | undefined
      let familyIds: readonly TokenFamilyId[]
      if (input.target.kind === 'credential') {
        const found = await this.credentialById(connection, input.target.credentialId, false)
        if (found === undefined) return { families: [] }
        familyIds = [found.tokenFamilyId]
      } else if (input.target.kind === 'token-family') {
        familyIds = [input.target.tokenFamilyId]
      } else {
        familyIds = (await this.familiesForTarget(connection, input.target)).map(value => value.tokenFamilyId)
      }
      const commits: TokenFamilyMutationCommit[] = []
      for (const familyId of familyIds) {
        const previous = await this.familyById(connection, familyId)
        if (previous === undefined) continue
        if (input.target.kind === 'credential') {
          const credential = await this.credentialById(connection, input.target.credentialId, true)
          if (credential === undefined || credential.tokenFamilyId !== previous.tokenFamilyId) {
            throw unavailable('credential target relation changed')
          }
          matchedCredential = credential
        }
        if (previous.status === 'revoked') {
          commits.push({ previous, current: previous })
          continue
        }
        const current: RevokedFamilyRecord = {
          ...previous,
          status: 'revoked',
          updatedAt: input.time,
          revision: previous.revision + 1,
          revokedAt: input.time,
          revocationReason: input.reason,
        }
        await this.revokeFamily(connection, current)
        await this.revokeActiveCredentials(connection, current.tokenFamilyId, input.time)
        commits.push({ previous, current })
      }
      return { families: commits, ...(matchedCredential === undefined ? {} : { matchedCredential }) }
    }))
  }

  private async storage<T>(callback: (connection: MysqlConnection) => Promise<T>): Promise<T> {
    try {
      return await this.ctx.mysql.connection(callback)
    } catch (cause) {
      if (cause instanceof AuthTokenError) throw cause
      throw unavailable('storage operation failed')
    }
  }

  private async familyById(
    connection: MysqlConnection,
    id: TokenFamilyId,
    mode: 'share' | 'update' = 'update',
  ): Promise<TokenFamilyRecord | undefined> {
    const suffix = mode === 'share' ? ' FOR SHARE' : ' FOR UPDATE'
    const [rows] = await connection.execute<FamilyRow[]>(
      `SELECT ${FAMILY_COLUMNS} FROM dsh_auth_token_families WHERE token_family_id = ?${suffix}`,
      [id],
    )
    return rows[0] === undefined ? undefined : familyRecord(rows[0])
  }

  private async credentialById(connection: MysqlConnection, id: CredentialId, lock: boolean): Promise<RefreshCredentialRecord | undefined> {
    const [rows] = await connection.execute<CredentialRow[]>(
      `SELECT ${CREDENTIAL_COLUMNS} FROM dsh_auth_refresh_credentials WHERE credential_id = ?${lock ? ' FOR UPDATE' : ''}`,
      [id],
    )
    return rows[0] === undefined ? undefined : credentialRecord(rows[0])
  }

  private async credentialByDigest(connection: MysqlConnection, digest: RefreshTokenDigest): Promise<RefreshCredentialRecord | undefined> {
    const [rows] = await connection.execute<CredentialRow[]>(
      `SELECT ${CREDENTIAL_COLUMNS} FROM dsh_auth_refresh_credentials WHERE digest = ?`,
      [digest],
    )
    return rows[0] === undefined ? undefined : credentialRecord(rows[0])
  }

  private async familiesForTarget(
    connection: MysqlConnection,
    target: CredentialInspectTarget,
    mode: 'share' | 'update' = 'update',
  ): Promise<TokenFamilyRecord[]> {
    if (target.kind === 'credential') {
      const credential = await this.credentialById(connection, target.credentialId, false)
      if (credential === undefined) return []
      const family = await this.familyById(connection, credential.tokenFamilyId, mode)
      return family === undefined ? [] : [family]
    }
    const clause = target.kind === 'token-family'
      ? { sql: 'token_family_id = ?', parameters: [target.tokenFamilyId] }
      : { sql: 'principal_kind = ? AND principal_id = ?', parameters: [target.principal.kind, target.principal.id] }
    const suffix = mode === 'share' ? ' FOR SHARE' : ' FOR UPDATE'
    const [rows] = await connection.execute<FamilyRow[]>(
      `SELECT ${FAMILY_COLUMNS} FROM dsh_auth_token_families WHERE ${clause.sql}
       ORDER BY token_family_id ASC${suffix}`,
      clause.parameters,
    )
    return rows.map(familyRecord)
  }

  private async credentialsForFamilies(
    connection: MysqlConnection,
    familyIds: readonly TokenFamilyId[],
  ): Promise<RefreshCredentialRecord[]> {
    if (familyIds.length === 0) return []
    const placeholders = familyIds.map(() => '?').join(', ')
    const [rows] = await connection.execute<CredentialRow[]>(
      `SELECT ${CREDENTIAL_COLUMNS} FROM dsh_auth_refresh_credentials
       WHERE token_family_id IN (${placeholders}) ORDER BY issued_at ASC, credential_id ASC`,
      [...familyIds],
    )
    return rows.map(credentialRecord)
  }

  private async revokeFamily(connection: MysqlConnection, family: RevokedFamilyRecord): Promise<void> {
    const [updated] = await connection.execute<ResultSetHeader>(
      `UPDATE dsh_auth_token_families
       SET status = 'revoked', updated_at = ?, revision = ?, revoked_at = ?, revocation_reason = ?
       WHERE token_family_id = ? AND status = 'active' AND revision = ?`,
      [family.updatedAt, family.revision, family.revokedAt, family.revocationReason,
        family.tokenFamilyId, family.revision - 1],
    )
    if (updated.affectedRows !== 1) throw unavailable('locked token family was not revoked')
  }

  private async revokeActiveCredentials(connection: MysqlConnection, familyId: TokenFamilyId, time: number): Promise<void> {
    await connection.execute(
      `UPDATE dsh_auth_refresh_credentials SET status = 'revoked', revoked_at = ?
       WHERE token_family_id = ? AND status = 'active'`,
      [time, familyId],
    )
  }
}

export default AuthTokenMysql
