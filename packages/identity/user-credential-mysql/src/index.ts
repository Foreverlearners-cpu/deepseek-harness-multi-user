/**
 * MySQL persistence Provider for login identifiers and password credentials.
 * @module @deepseek-ai/dsh-user-credential-mysql
 */

import { Service } from '@deepseek-ai/cordis'
import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import UserCredentialService, {
  MAX_LOGIN_IDENTIFIERS,
  UserCredentialError,
  type LoginIdentifier,
  type LoginIdentifierInput,
  type UserCredentialMutation,
  type UserCredentialMutationCommit,
  type UserCredentialRecord,
  type UserId,
} from '@deepseek-ai/dsh-user-credential'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import {
  createPasswordVerifier,
  type PasswordVerifier,
  verifyPasswordVerifier,
} from './password.ts'
import { initializeSchema } from './schema.ts'

export { USER_CREDENTIAL_MYSQL_SCHEMA_VERSION } from './schema.ts'

interface CredentialRow extends RowDataPacket {
  user_id: string
  revision: number | string
  password_version: number | string | null
  password_cost: number | string | null
  password_block_size: number | string | null
  password_parallelization: number | string | null
  password_salt: Buffer | null
  password_derived_key: Buffer | null
  password_changed_at: number | string | null
  updated_at: number | string
}

interface IdentifierRow extends RowDataPacket {
  user_id: string
  kind: string
  normalized_value: string
  created_at: number | string
}

const SELECT_CREDENTIAL = `user_id, revision, password_version, password_cost,
  password_block_size, password_parallelization, password_salt, password_derived_key,
  password_changed_at, updated_at`

function safeInteger(value: number | string, field: string): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error(`user-credential-mysql: invalid ${field}`)
  return numeric
}

function verifier(row: CredentialRow): PasswordVerifier | undefined {
  const fields = [
    row.password_version,
    row.password_cost,
    row.password_block_size,
    row.password_parallelization,
    row.password_salt,
    row.password_derived_key,
    row.password_changed_at,
  ]
  if (fields.every(value => value === null)) return undefined
  if (fields.some(value => value === null)) throw new Error('user-credential-mysql: incomplete password verifier')
  const [version, cost, blockSize, parallelization, salt, derivedKey] = fields as [
    number | string, number | string, number | string, number | string, Buffer, Buffer, number | string,
  ]
  return {
    version: safeInteger(version, 'password_version'),
    cost: safeInteger(cost, 'password_cost'),
    blockSize: safeInteger(blockSize, 'password_block_size'),
    parallelization: safeInteger(parallelization, 'password_parallelization'),
    salt,
    derivedKey,
  }
}

async function identifiers(connection: MysqlConnection, userId: UserId): Promise<IdentifierRow[]> {
  const [rows] = await connection.execute<IdentifierRow[]>(
    `SELECT user_id, kind, normalized_value, created_at FROM dsh_user_login_identifiers
     WHERE user_id = ? ORDER BY identifier_id ASC`,
    [userId],
  )
  return rows
}

async function credentialRecord(
  connection: MysqlConnection,
  row: CredentialRow,
): Promise<UserCredentialRecord> {
  const password = verifier(row)
  const identifierRows = await identifiers(connection, row.user_id as UserId)
  return {
    userId: row.user_id as UserId,
    revision: safeInteger(row.revision, 'revision'),
    identifiers: identifierRows.map(identifier => ({
      kind: identifier.kind,
      value: identifier.normalized_value,
      createdAt: safeInteger(identifier.created_at, 'created_at'),
    })),
    passwordEnabled: password !== undefined,
    updatedAt: safeInteger(row.updated_at, 'updated_at'),
    ...(row.password_changed_at === null
      ? {}
      : { passwordChangedAt: safeInteger(row.password_changed_at, 'password_changed_at') }),
  }
}

function isDuplicate(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ER_DUP_ENTRY'
}

async function rollback(connection: MysqlConnection, cause: unknown): Promise<never> {
  try {
    await connection.rollback()
  } catch (rollbackCause) {
    throw new UserCredentialError('provider-unavailable', 'user-credential-mysql: transaction rollback failed', {
      cause: new AggregateError([cause, rollbackCause]),
    })
  }
  throw cause
}

/** Durable `ctx.userCredentials` Provider backed by the injected MySQL service. */
export class UserCredentialMysqlService extends UserCredentialService {
  static inject = ['mysql']
  private dummyVerifier!: PasswordVerifier

  /** Initialize the schema and dummy verifier before serving requests. */
  async [Service.init](): Promise<void> {
    await this.ctx.mysql.connection(initializeSchema)
    this.dummyVerifier = await createPasswordVerifier('dsh-user-credential-dummy')
  }

  protected normalizeLoginIdentifier(input: LoginIdentifierInput): Promise<string> {
    const value = input.value.trim().normalize('NFKC').toLocaleLowerCase('en-US')
    if (value.length === 0) throw new UserCredentialError('invalid-input', 'user-credential-mysql: identifier is empty')
    return Promise.resolve(value)
  }

  protected async readCredentialRecord(userId: UserId): Promise<UserCredentialRecord | undefined> {
    return this.ctx.mysql.connection(async (connection) => {
      const [rows] = await connection.execute<CredentialRow[]>(
        `SELECT ${SELECT_CREDENTIAL} FROM dsh_user_credentials WHERE user_id = ?`,
        [userId],
      )
      const row = rows[0]
      return row === undefined ? undefined : credentialRecord(connection, row)
    })
  }

  protected async resolveLoginIdentifier(identifier: LoginIdentifier): Promise<UserId | undefined> {
    return this.ctx.mysql.connection(async (connection) => {
      const [rows] = await connection.execute<IdentifierRow[]>(
        `SELECT user_id, kind, normalized_value, created_at FROM dsh_user_login_identifiers
         WHERE kind = ? AND normalized_value = ?`,
        [identifier.kind, identifier.value],
      )
      return rows[0]?.user_id as UserId | undefined
    })
  }

  protected async mutateCredentialRecord(mutation: UserCredentialMutation): Promise<UserCredentialMutationCommit> {
    return this.ctx.mysql.connection(async (connection) => {
      await connection.beginTransaction()
      try {
        const [rows] = await connection.execute<CredentialRow[]>(
          `SELECT ${SELECT_CREDENTIAL} FROM dsh_user_credentials WHERE user_id = ? FOR UPDATE`,
          [mutation.userId],
        )
        const row = rows[0]
        if (row === undefined && mutation.expectedRevision !== 0) {
          throw new UserCredentialError('credential-not-found', 'user-credential-mysql: credential aggregate was not found')
        }
        if (row !== undefined && safeInteger(row.revision, 'revision') !== mutation.expectedRevision) {
          throw new UserCredentialError('revision-conflict', 'user-credential-mysql: credential revision changed')
        }
        const previous = row === undefined ? undefined : await credentialRecord(connection, row)
        const now = Math.max(Date.now(), previous?.updatedAt ?? 0)
        if (row === undefined) {
          try {
            await connection.execute(
              `INSERT INTO dsh_user_credentials (user_id, revision, updated_at)
               VALUES (?, 0, ?)`,
              [mutation.userId, now],
            )
          } catch (cause) {
            if (isDuplicate(cause)) throw new UserCredentialError('revision-conflict', 'user-credential-mysql: credential revision changed')
            throw cause
          }
        }

        await this.applyMutation(connection, mutation, previous, now)
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE dsh_user_credentials SET revision = revision + 1, updated_at = ?
           WHERE user_id = ? AND revision = ?`,
          [now, mutation.userId, mutation.expectedRevision],
        )
        if (result.affectedRows !== 1) throw new Error('user-credential-mysql: locked credential update affected no row')
        const [currentRows] = await connection.execute<CredentialRow[]>(
          `SELECT ${SELECT_CREDENTIAL} FROM dsh_user_credentials WHERE user_id = ?`,
          [mutation.userId],
        )
        const currentRow = currentRows[0]
        if (currentRow === undefined) throw new Error('user-credential-mysql: committed credential row disappeared')
        const current = await credentialRecord(connection, currentRow)
        await connection.commit()
        return { ...(previous === undefined ? {} : { previous }), current }
      } catch (cause) {
        return rollback(connection, cause)
      }
    })
  }

  protected async verifyPasswordSecret(userId: UserId | undefined, password: string): Promise<boolean> {
    if (userId === undefined) return verifyPasswordVerifier(password, this.dummyVerifier)
    return this.ctx.mysql.connection(async (connection) => {
      const [rows] = await connection.execute<CredentialRow[]>(
        `SELECT ${SELECT_CREDENTIAL} FROM dsh_user_credentials WHERE user_id = ?`,
        [userId],
      )
      const stored = rows[0] === undefined ? undefined : verifier(rows[0])
      return verifyPasswordVerifier(password, stored ?? this.dummyVerifier)
    })
  }

  private async applyMutation(
    connection: MysqlConnection,
    mutation: UserCredentialMutation,
    previous: UserCredentialRecord | undefined,
    now: number,
  ): Promise<void> {
    if (mutation.kind === 'identifier-add') {
      if ((previous?.identifiers.length ?? 0) >= MAX_LOGIN_IDENTIFIERS) {
        throw new UserCredentialError('invalid-input', `user-credential-mysql: at most ${String(MAX_LOGIN_IDENTIFIERS)} identifiers are allowed`)
      }
      try {
        await connection.execute(
          `INSERT INTO dsh_user_login_identifiers (user_id, kind, normalized_value, created_at)
           VALUES (?, ?, ?, ?)`,
          [mutation.userId, mutation.identifier.kind, mutation.identifier.value, now],
        )
      } catch (cause) {
        if (isDuplicate(cause)) throw new UserCredentialError('identifier-conflict', 'user-credential-mysql: identifier already exists')
        throw cause
      }
      return
    }
    if (mutation.kind === 'identifier-remove') {
      const [result] = await connection.execute<ResultSetHeader>(
        `DELETE FROM dsh_user_login_identifiers
         WHERE user_id = ? AND kind = ? AND normalized_value = ?`,
        [mutation.userId, mutation.identifier.kind, mutation.identifier.value],
      )
      if (result.affectedRows !== 1) {
        throw new UserCredentialError('identifier-not-found', 'user-credential-mysql: identifier was not found')
      }
      return
    }
    if (mutation.kind === 'password-disable') {
      if (previous?.passwordEnabled !== true) {
        throw new UserCredentialError('password-not-set', 'user-credential-mysql: password is disabled')
      }
      await this.storeVerifier(connection, mutation.userId, undefined, null)
      return
    }
    if (mutation.kind === 'password-change') {
      if (previous?.passwordEnabled !== true) {
        throw new UserCredentialError('password-not-set', 'user-credential-mysql: password is disabled')
      }
      const [rows] = await connection.execute<CredentialRow[]>(
        `SELECT ${SELECT_CREDENTIAL} FROM dsh_user_credentials WHERE user_id = ?`,
        [mutation.userId],
      )
      const stored = rows[0] === undefined ? undefined : verifier(rows[0])
      if (stored === undefined || !await verifyPasswordVerifier(mutation.currentPassword, stored)) {
        throw new UserCredentialError('invalid-credential', 'user-credential-mysql: current password is invalid')
      }
    }
    const next = await createPasswordVerifier(mutation.kind === 'password-set' ? mutation.password : mutation.newPassword)
    await this.storeVerifier(connection, mutation.userId, next, now)
  }

  private async storeVerifier(
    connection: MysqlConnection,
    userId: UserId,
    password: PasswordVerifier | undefined,
    changedAt: number | null,
  ): Promise<void> {
    await connection.execute(
      `UPDATE dsh_user_credentials SET password_version = ?, password_cost = ?,
       password_block_size = ?, password_parallelization = ?, password_salt = ?,
       password_derived_key = ?, password_changed_at = ? WHERE user_id = ?`,
      password === undefined
        ? [null, null, null, null, null, null, null, userId]
        : [password.version, password.cost, password.blockSize, password.parallelization,
          password.salt, password.derivedKey, changedAt, userId],
    )
  }
}

export default UserCredentialMysqlService
