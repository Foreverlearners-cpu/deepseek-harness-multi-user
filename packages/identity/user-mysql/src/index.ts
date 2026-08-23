/** MySQL provider for the `ctx.users` Service Definition. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { User, UserId, UserStatus, CreateUserInput } from '@deepseek-ai/dsh-user'
import { UserId as brandUserId, UserService as UserServiceBase } from '@deepseek-ai/dsh-user'
import type { ResultSetHeader } from 'mysql2'
import { ensureSchema, USERS_TABLE, type UserRow } from './schema.ts'

/** MySQL user provider configuration. */
export interface Config {
  /** Optional local-development user created during provider startup. */
  bootstrapUserId?: string
  /** Display name for the optional local-development bootstrap user. */
  bootstrapDisplayName?: string
}

function assertDisplayName(value: string | undefined): void {
  if (value !== undefined && (value.length === 0 || value.length > 128)) {
    throw new Error('displayName must contain 1-128 characters when provided')
  }
}

function mapUser(row: UserRow): User {
  return Object.freeze({
    id: brandUserId(row.user_id),
    ...row.display_name === null ? {} : { displayName: row.display_name },
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  })
}

function isDuplicate(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ER_DUP_ENTRY'
}

/** MySQL-backed user directory. */
export class MysqlUserService extends UserServiceBase {
  static inject = ['mysql']

  static Config: z<Config> = z.object({
    bootstrapUserId: z.string().min(1).max(128),
    bootstrapDisplayName: z.string().min(1).max(128),
  })

  override readonly name = 'users'

  private readonly ready: Promise<void>

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    if (config.bootstrapUserId !== undefined) brandUserId(config.bootstrapUserId)
    assertDisplayName(config.bootstrapDisplayName)
    this.ready = this.initialize()
  }

  async [Service.init](): Promise<void> {
    await this.ready
    if (this.config.bootstrapUserId !== undefined) {
      const id = brandUserId(this.config.bootstrapUserId)
      if (await this.get(id) === undefined) {
        await this.create({ id, ...this.config.bootstrapDisplayName === undefined ? {} : { displayName: this.config.bootstrapDisplayName } })
      }
    }
  }

  private async initialize(): Promise<void> {
    await this.ctx.mysql.connection(connection => ensureSchema(connection))
  }

  async create(input: CreateUserInput): Promise<User> {
    await this.ready
    const id = brandUserId(String(input.id))
    assertDisplayName(input.displayName)
    const now = Date.now()
    try {
      await this.ctx.mysql.connection(async (connection) => {
        await connection.beginTransaction()
        try {
          await connection.query(
            `INSERT INTO ${USERS_TABLE}
             (user_id, display_name, status, created_at, updated_at, revision)
             VALUES (?, ?, 'active', ?, ?, 0)`,
            [id, input.displayName ?? null, now, now],
          )
          await connection.commit()
        } catch (error: unknown) {
          try {
            await connection.rollback()
          } catch {
            // Preserve the insert error; the upstream lease still restores the connection.
          }
          throw error
        }
      })
    } catch (error: unknown) {
      if (isDuplicate(error)) throw new Error(`user "${id}" already exists`)
      throw error
    }
    const created = await this.get(id)
    if (created === undefined) throw new Error(`user "${id}" disappeared after creation`)
    return created
  }

  async get(id: UserId): Promise<User | undefined> {
    await this.ready
    const [rows] = await this.ctx.mysql.connection(connection => connection.query<UserRow[]>(
      `SELECT user_id, display_name, status, created_at, updated_at, revision
       FROM ${USERS_TABLE} WHERE user_id = ?`,
      [brandUserId(String(id))],
    ))
    const row = rows[0]
    return row === undefined ? undefined : mapUser(row)
  }

  async requireActive(id: UserId): Promise<User> {
    const user = await this.get(id)
    if (user === undefined) throw new Error(`user "${String(id)}" not found`)
    if (user.status !== 'active') throw new Error(`user "${String(id)}" is not active`)
    return user
  }

  async disable(id: UserId): Promise<void> {
    await this.ready
    const now = Date.now()
    const [result] = await this.ctx.mysql.connection(connection => connection.query<ResultSetHeader>(
      `UPDATE ${USERS_TABLE}
       SET status = 'disabled', revision = revision + 1, updated_at = ?
       WHERE user_id = ? AND status <> 'deleted'`,
      [now, brandUserId(String(id))],
    ))
    if (result.affectedRows === 0) throw new Error(`user "${String(id)}" not found`)
  }

  async list(): Promise<User[]> {
    await this.ready
    const [rows] = await this.ctx.mysql.connection(connection => connection.query<UserRow[]>(
      `SELECT user_id, display_name, status, created_at, updated_at, revision
       FROM ${USERS_TABLE} ORDER BY created_at, user_id`,
    ))
    return rows.map(mapUser)
  }
}

export type { UserStatus }
export default MysqlUserService
