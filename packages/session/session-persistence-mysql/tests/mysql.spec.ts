import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import Mysql from '@deepseek-ai/dsh-mysql'
import type { RowDataPacket } from 'mysql2'
import { UserId } from '@deepseek-ai/dsh-user'
import MysqlUserService from '@deepseek-ai/dsh-user-mysql'
import MysqlSessionPersistence from '../src/index.ts'
import type { Config as MysqlConfig } from '@deepseek-ai/dsh-mysql'

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

async function boot(userId = `mysql-user-${Date.now()}-${Math.random().toString(16).slice(2)}`): Promise<{ id: SessionId; userId: string }> {
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(Mysql, targetConfig())
  await ctx.plugin(MysqlUserService, { bootstrapUserId: userId })
  persistenceFiber = await ctx.plugin(MysqlSessionPersistence, { ownerUserId: userId })
  const id = SessionId(`mysql-session-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  return { id, userId }
}

describe.skipIf(target === undefined)('MySQL session persistence', () => {
  it('round-trips events and packs a consecutive chunk run', async () => {
    const { id, userId } = await boot()
    const session = ctx!.sessions.create(id, { meta: { userId: UserId(userId) } })
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
    const { id, userId } = await boot()
    const session = ctx!.sessions.create(id, { meta: { userId: UserId(userId) } })
    session.append('turn/start', { turn: 1 })
    await ctx!.sessions.flush(session)

    const otherCtx = new Context()
    await otherCtx.plugin(SessionStore)
    await otherCtx.plugin(Mysql, targetConfig())
    const otherUserId = `mysql-other-user-${Date.now()}-${Math.random().toString(16).slice(2)}`
    await otherCtx.plugin(MysqlUserService, { bootstrapUserId: otherUserId })
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

  it('rejects ownerless headers and disabled-user provider startup', async () => {
    const { id, userId } = await boot()
    expect(() => ctx!.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: Date.now(),
    })).toThrow(/must declare a user owner/)
    await ctx!.users.disable(UserId(userId))
    await persistenceFiber!.dispose()
    persistenceFiber = undefined
    await ctx!.fiber.dispose()
    ctx = undefined

    const disabledCtx = new Context()
    await disabledCtx.plugin(SessionStore)
    await disabledCtx.plugin(Mysql, targetConfig())
    await disabledCtx.plugin(MysqlUserService)
    await expect(disabledCtx.plugin(MysqlSessionPersistence, { ownerUserId: userId }))
      .rejects.toThrow(/not active/)
    await disabledCtx.fiber.dispose()
  })
})
