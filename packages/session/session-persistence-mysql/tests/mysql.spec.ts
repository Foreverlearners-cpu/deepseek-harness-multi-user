import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Mysql from '@deepseek-ai/dsh-mysql'
import type { RowDataPacket } from 'mysql2'
import { UserId } from '@deepseek-ai/dsh-user'
import MysqlSessionPersistence from '../src/index.ts'
import type { Config as MysqlConfig } from '@deepseek-ai/dsh-mysql'
import { StubUsers } from './helpers/stub-users.ts'

const target = process.env.DSH_MYSQL_TEST_URL
let ctx: Context | undefined
let persistenceFiber: Awaited<ReturnType<Context['plugin']>> | undefined

interface CountRow extends RowDataPacket {
  count: number
}

afterEach(async () => {
  await persistenceFiber?.dispose()
  await ctx?.fiber.dispose()
  persistenceFiber = undefined
  ctx = undefined
})

function targetConfig(): MysqlConfig {
  const url = new URL(target!)
  if (url.protocol !== 'mysql:') throw new Error('DSH_MYSQL_TEST_URL must use the mysql: scheme')
  const database = decodeURIComponent(url.pathname.slice(1))
  if (database.length === 0) throw new Error('DSH_MYSQL_TEST_URL must name a database')
  return {
    host: url.hostname,
    ...(url.port === '' ? {} : { port: Number(url.port) }),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    connectionLimit: 2,
  }
}

/**
 * Create the user table and row the schemas reference through foreign keys.
 * The production `@deepseek-ai/dsh-user-mysql` provider owns this table; tests
 * use the in-memory {@link StubUsers} service, so the fixture materializes the
 * user in MySQL explicitly.
 */
async function ensureUserRow(ctx: Context, userId: string): Promise<void> {
  const now = Date.now()
  await ctx.mysql.connection(async (connection) => {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS dsh_users (
        user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        display_name VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
        status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        created_at BIGINT UNSIGNED NOT NULL,
        updated_at BIGINT UNSIGNED NOT NULL,
        revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id),
        KEY users_status_updated (status, updated_at, user_id),
        CHECK (status IN ('active', 'disabled', 'deleted'))
      ) ENGINE = InnoDB
    `)
    await connection.query(
      `INSERT IGNORE INTO dsh_users (user_id, display_name, status, created_at, updated_at, revision)
       VALUES (?, NULL, 'active', ?, ?, 0)`,
      [userId, now, now],
    )
  })
}

async function boot(userId = `mysql-user-${Date.now()}-${Math.random().toString(16).slice(2)}`): Promise<{ id: SessionId; userId: string }> {
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Mysql, targetConfig())
  await ensureUserRow(ctx, userId)
  await ctx.plugin(StubUsers, { active: userId })
  persistenceFiber = await ctx.plugin(MysqlSessionPersistence, { ownerUserId: userId })
  const id = SessionId(`mysql-session-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  return { id, userId }
}

describe.skipIf(target === undefined)('MySQL session persistence', () => {
  it('round-trips events and packs a consecutive chunk run', async () => {
    const { id } = await boot()
    const session = ctx!.sessions.create(id)
    session.append('turn/start', { turn: 1 })
    session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'a' },
    })
    session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'b' },
    })
    session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'c' },
    })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx!.sessions.flush(session)

    const loaded = await ctx!.sessionPersistence.load(id)
    expect(loaded.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4])
    expect(loaded.events[2]).toMatchObject({
      type: 'assistant/chunk',
      data: { chunk: { type: 'text-delta', text: 'b' } },
    })

    const [rows] = await ctx!.mysql.connection(connection => connection.query<CountRow[]>(
      'SELECT COUNT(*) AS count FROM dsh_session_persistence_records WHERE session_id = ?',
      [id],
    ))
    expect(Number(rows[0]?.count)).toBe(3)
  })

  it('does not expose another user through the configured runtime', async () => {
    const { id } = await boot()
    const session = ctx!.sessions.create(id)
    session.append('turn/start', { turn: 1 })
    await ctx!.sessions.flush(session)

    const otherCtx = new Context()
    await otherCtx.plugin(SessionStore)
    await otherCtx.plugin(Mysql, targetConfig())
    const otherUserId = `mysql-other-user-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await otherCtx.plugin(StubUsers, { active: otherUserId })
    const otherFiber = await otherCtx.plugin(MysqlSessionPersistence, { ownerUserId: otherUserId })
    try {
      await expect(otherCtx.sessionPersistence.load(SessionId(id))).rejects.toThrow(/not found/)
      await expect(otherCtx.sessionPersistence.append(SessionId(id), [
        {
          type: 'turn/end',
          seq: 1,
          time: Date.now(),
          data: { turn: 1, reason: { kind: 'completed' } },
        },
      ])).rejects.toThrow(/not found/)
      expect(await otherCtx.sessionPersistence.list()).toEqual([])
    } finally {
      await otherFiber.dispose()
      await otherCtx.fiber.dispose()
    }
  })

  it('rejects provider startup for a disabled owner user', async () => {
    const { userId } = await boot()
    await ctx!.users.disable(UserId(userId))
    await persistenceFiber!.dispose()
    persistenceFiber = undefined
    await ctx!.fiber.dispose()
    ctx = undefined

    const disabledCtx = new Context()
    await disabledCtx.plugin(SessionStore)
    await disabledCtx.plugin(Mysql, targetConfig())
    await disabledCtx.plugin(StubUsers, { disabled: userId })
    await expect(disabledCtx.plugin(MysqlSessionPersistence, { ownerUserId: userId }))
      .rejects.toThrow(/not active/)
    await disabledCtx.fiber.dispose()
  })
})
