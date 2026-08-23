import { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { UserId } from '@deepseek-ai/dsh-user'
import { afterEach, describe, expect, it } from 'vitest'
import MysqlUserService from '../src/index.ts'
import type { Config } from '../src/index.ts'

/** Minimal driver-shaped connection used to exercise provider behavior without MySQL. */
class FakeConnection {
  readonly operations: string[] = []
  readonly users = new Map<string, {
    id: string
    displayName: string | null
    status: 'active' | 'disabled' | 'deleted'
    createdAt: number
    updatedAt: number
    revision: number
  }>()

  duplicate = false

  async beginTransaction(): Promise<void> {
    this.operations.push('begin')
  }

  async commit(): Promise<void> {
    this.operations.push('commit')
  }

  async rollback(): Promise<void> {
    this.operations.push('rollback')
  }

  async query(sql: string, params: unknown[] = []): Promise<[unknown, unknown?]> {
    if (sql.includes('information_schema.columns')) return [[], undefined]
    if (sql.includes('dsh_user_persistence_state')) {
      if (sql.trimStart().startsWith('SELECT')) return [[{ schema_version: 2 }], undefined]
      return [[], undefined]
    }
    if (sql.includes('INSERT INTO dsh_users')) {
      if (this.duplicate) {
        throw Object.assign(new Error('duplicate entry'), { code: 'ER_DUP_ENTRY' })
      }
      const [id, displayName] = params as [string, string | null]
      const now = Date.now()
      this.users.set(id, { id, displayName, status: 'active', createdAt: now, updatedAt: now, revision: 0 })
      return [[], undefined]
    }
    if (sql.includes('UPDATE dsh_users')) {
      const [now, id] = params as [number, string]
      const row = this.users.get(id)
      if (!row) return [{ affectedRows: 0 }, undefined]
      this.users.set(id, { ...row, status: 'disabled', updatedAt: now, revision: row.revision + 1 })
      return [{ affectedRows: 1 }, undefined]
    }
    if (sql.includes('ORDER BY created_at')) {
      const rows = [...this.users.values()].map(row => ({
        user_id: row.id,
        display_name: row.displayName,
        status: row.status,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        revision: row.revision,
      }))
      return [rows, undefined]
    }
    if (sql.includes('WHERE user_id = ?')) {
      const [id] = params as [string]
      const row = this.users.get(id)
      return [
        row ? [{
          user_id: row.id,
          display_name: row.displayName,
          status: row.status,
          created_at: row.createdAt,
          updated_at: row.updatedAt,
          revision: row.revision,
        }] : [],
        undefined,
      ]
    }
    return [[], undefined]
  }
}

/** Cordis service stand-in for `ctx.mysql` exposing only the upstream `connection` lease. */
class FakeMysql extends Service {
  constructor(ctx: Context, config: { lease: FakeConnection }) {
    super(ctx, 'mysql')
    this.lease = config.lease
  }

  readonly lease: FakeConnection

  connection<T>(callback: (connection: FakeConnection) => T | Promise<T>): Promise<T> {
    return Promise.resolve(callback(this.lease))
  }
}

const contexts: Context[] = []

async function boot(config: Config = {}): Promise<{ ctx: Context; connection: FakeConnection }> {
  const ctx = new Context()
  contexts.push(ctx)
  const connection = new FakeConnection()
  await ctx.plugin(FakeMysql, { lease: connection })
  await ctx.plugin(MysqlUserService, config)
  return { ctx, connection }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
  }
})

describe('MysqlUserService provider behavior', () => {
  it('creates a user inside one transaction and commits', async () => {
    const { ctx, connection } = await boot()
    const id = UserId('alice')
    const created = await ctx.users.create({ id, displayName: 'Alice' })
    expect(created).toMatchObject({ id, displayName: 'Alice', status: 'active', revision: 0 })
    expect(connection.operations).toEqual(['begin', 'commit'])
  })

  it('rolls back and rejects when the insert fails', async () => {
    const { ctx, connection } = await boot()
    connection.duplicate = true
    const id = UserId('alice')
    await expect(ctx.users.create({ id })).rejects.toThrow(/already exists/)
    expect(connection.operations).toContain('begin')
    expect(connection.operations).toContain('rollback')
    expect(connection.operations).not.toContain('commit')
  })

  it('reads a user and reports absence', async () => {
    const { ctx } = await boot()
    const id = UserId('alice')
    await ctx.users.create({ id })
    await expect(ctx.users.get(id)).resolves.toMatchObject({ id, status: 'active' })
    await expect(ctx.users.get(UserId('nobody'))).resolves.toBeUndefined()
  })

  it('requireActive rejects missing and disabled users', async () => {
    const { ctx } = await boot()
    const id = UserId('alice')
    await ctx.users.create({ id })
    await ctx.users.disable(id)
    await expect(ctx.users.requireActive(UserId('nobody'))).rejects.toThrow(/not found/)
    await expect(ctx.users.requireActive(id)).rejects.toThrow(/not active/)
  })

  it('lists visible users in creation order', async () => {
    const { ctx } = await boot()
    await ctx.users.create({ id: UserId('alice') })
    await ctx.users.create({ id: UserId('bob') })
    const listed = await ctx.users.list()
    expect(listed.map(user => user.id)).toEqual(['alice', 'bob'])
  })

  it('bootstraps an active user during startup when configured', async () => {
    const { ctx } = await boot({ bootstrapUserId: 'dev', bootstrapDisplayName: 'Dev User' })
    await expect(ctx.users.get(UserId('dev'))).resolves.toMatchObject({
      id: 'dev',
      displayName: 'Dev User',
      status: 'active',
    })
  })

  it('rejects invalid bootstrap identifiers and display names', async () => {
    for (const config of [{ bootstrapUserId: 'bad id' }, { bootstrapDisplayName: '' }]) {
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(FakeMysql, { lease: new FakeConnection() })
      expect(() => new MysqlUserService(ctx, config)).toThrow()
    }
  })
})
