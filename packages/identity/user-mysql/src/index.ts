/** MySQL persistence Provider for the human user directory.
 * @module @deepseek-ai/dsh-user-mysql
 */

import { Service } from '@deepseek-ai/cordis'
import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import UserDirectory, {
  UserDirectoryError,
  userId,
  type UserCreateRecordInput,
  type UserExtensions,
  type UserId,
  type UserListQuery,
  type UserMutation,
  type UserMutationCommit,
  type UserPage,
  type UserRecord,
  type UserStatus,
} from '@deepseek-ai/dsh-user'
import { randomUUID } from 'node:crypto'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { decodeCursor, encodeCursor } from './cursor.ts'
import { initializeSchema } from './schema.ts'

export { USER_MYSQL_SCHEMA_VERSION } from './schema.ts'

interface UserRow extends RowDataPacket {
  user_id: string
  display_name: string | null
  status: UserStatus
  created_at: number | string
  updated_at: number | string
  revision: number | string
  extensions: unknown
}

const SELECT_COLUMNS = 'user_id, display_name, status, created_at, updated_at, revision, extensions'

function safeInteger(value: number | string, field: string): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error(`user-mysql: invalid ${field}`)
  return numeric
}

function extensions(value: unknown): UserExtensions {
  if (typeof value !== 'string') return value as UserExtensions
  return JSON.parse(value) as UserExtensions
}

function record(row: UserRow): UserRecord {
  return {
    userId: userId(row.user_id),
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    status: row.status,
    createdAt: safeInteger(row.created_at, 'created_at'),
    updatedAt: safeInteger(row.updated_at, 'updated_at'),
    revision: safeInteger(row.revision, 'revision'),
    extensions: extensions(row.extensions),
  }
}

function conflict(previous: UserRecord, mutation: UserMutation): void {
  if (previous.revision !== mutation.expectedRevision) {
    throw new UserDirectoryError('revision-conflict', 'user-mysql: user revision changed')
  }
  if (previous.status === 'deleted') {
    throw new UserDirectoryError('user-deleted', 'user-mysql: user is deleted')
  }
  if (mutation.kind === 'profile') return
  const allowed = mutation.status === 'disabled'
    ? previous.status === 'active'
    : mutation.status === 'active'
      ? previous.status === 'disabled'
      : true
  if (!allowed) throw new UserDirectoryError('status-conflict', 'user-mysql: user status conflicts')
}

async function rollback(connection: MysqlConnection, cause: unknown): Promise<never> {
  try {
    await connection.rollback()
  } catch (rollbackCause) {
    throw new UserDirectoryError('provider-unavailable', 'user-mysql: transaction rollback failed', {
      cause: new AggregateError([cause, rollbackCause]),
    })
  }
  throw cause
}

/** Durable `ctx.users` Provider backed by the injected MySQL connection service. */
export class UserMysqlDirectory extends UserDirectory {
  static inject = ['mysql']

  /** Initialize and verify the Provider-owned schema before serving requests. */
  async [Service.init](): Promise<void> {
    await this.ctx.mysql.connection(initializeSchema)
  }

  protected async createRecord(input: UserCreateRecordInput): Promise<UserRecord> {
    const id = userId(randomUUID())
    const now = Date.now()
    await this.ctx.mysql.connection(async (connection) => {
      await connection.execute(
        `INSERT INTO dsh_users
          (user_id, display_name, status, created_at, updated_at, revision, extensions)
         VALUES (?, ?, 'active', ?, ?, 1, ?)`,
        [id, input.displayName ?? null, now, now, JSON.stringify(input.extensions)],
      )
    })
    return {
      userId: id,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      revision: 1,
      extensions: input.extensions,
    }
  }

  protected async readRecord(id: UserId): Promise<UserRecord | undefined> {
    return this.ctx.mysql.connection(async (connection) => {
      const [rows] = await connection.execute<UserRow[]>(
        `SELECT ${SELECT_COLUMNS} FROM dsh_users WHERE user_id = ?`,
        [id],
      )
      const row = rows[0]
      return row === undefined ? undefined : record(row)
    })
  }

  protected async mutateRecord(mutation: UserMutation): Promise<UserMutationCommit> {
    return this.ctx.mysql.connection(async (connection) => {
      await connection.beginTransaction()
      try {
        const [rows] = await connection.execute<UserRow[]>(
          `SELECT ${SELECT_COLUMNS} FROM dsh_users WHERE user_id = ? FOR UPDATE`,
          [mutation.userId],
        )
        const row = rows[0]
        if (row === undefined) throw new UserDirectoryError('user-not-found', 'user-mysql: user was not found')
        const previous = record(row)
        conflict(previous, mutation)
        const now = Math.max(Date.now(), previous.updatedAt)
        let result: ResultSetHeader
        if (mutation.kind === 'profile') {
          const nextName = Object.hasOwn(mutation.patch, 'displayName')
            ? mutation.patch.displayName ?? null
            : previous.displayName ?? null
          const nextExtensions = mutation.patch.extensions ?? previous.extensions
          ;[result] = await connection.execute<ResultSetHeader>(
            `UPDATE dsh_users SET display_name = ?, extensions = ?, updated_at = ?, revision = revision + 1
             WHERE user_id = ? AND revision = ?`,
            [nextName, JSON.stringify(nextExtensions), now, mutation.userId, mutation.expectedRevision],
          )
        } else {
          ;[result] = await connection.execute<ResultSetHeader>(
            `UPDATE dsh_users SET status = ?, updated_at = ?, revision = revision + 1
             WHERE user_id = ? AND revision = ?`,
            [mutation.status, now, mutation.userId, mutation.expectedRevision],
          )
        }
        if (result.affectedRows !== 1) throw new Error('user-mysql: locked user update affected no row')
        const [currentRows] = await connection.execute<UserRow[]>(
          `SELECT ${SELECT_COLUMNS} FROM dsh_users WHERE user_id = ?`,
          [mutation.userId],
        )
        const currentRow = currentRows[0]
        if (currentRow === undefined) throw new Error('user-mysql: committed user row disappeared')
        const current = record(currentRow)
        await connection.commit()
        return { previous, current }
      } catch (cause) {
        return rollback(connection, cause)
      }
    })
  }

  protected async listRecords(
    query: Required<Pick<UserListQuery, 'limit'>> & Omit<UserListQuery, 'limit'>,
  ): Promise<UserPage> {
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, query.status)
    const clauses: string[] = []
    const parameters: (number | string)[] = []
    if (query.status !== undefined) {
      clauses.push('status = ?')
      parameters.push(query.status)
    }
    if (after !== undefined) {
      clauses.push('user_id > ?')
      parameters.push(after)
    }
    parameters.push(query.limit + 1)
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    return this.ctx.mysql.connection(async (connection) => {
      const [rows] = await connection.execute<UserRow[]>(
        `SELECT ${SELECT_COLUMNS} FROM dsh_users${where} ORDER BY user_id ASC LIMIT ?`,
        parameters,
      )
      const hasMore = rows.length > query.limit
      const users = rows.slice(0, query.limit).map(record)
      const last = users.at(-1)
      return {
        users,
        ...(hasMore && last !== undefined ? { nextCursor: encodeCursor(last.userId, query.status) } : {}),
      }
    })
  }
}

export default UserMysqlDirectory
