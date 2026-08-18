import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import Mysql, { type MysqlConnection } from '../src/index.ts'

const createPool = vi.hoisted(() => vi.fn())

vi.mock('mysql2/promise', () => ({ createPool }))

const CONFIG = {
  host: 'mysql.internal',
  user: 'dsh',
  password: 'test-only',
  database: 'harness',
}

interface FakeConnection {
  destroy: ReturnType<typeof vi.fn>
  ping: ReturnType<typeof vi.fn>
  prepare: ReturnType<typeof vi.fn>
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
}

interface FakePool {
  getConnection: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

let connection: FakeConnection
let pool: FakePool
const contexts: Context[] = []

beforeEach(() => {
  connection = {
    destroy: vi.fn(),
    ping: vi.fn().mockResolvedValue(undefined),
    prepare: vi.fn(),
    query: vi.fn().mockResolvedValue([[], []]),
    release: vi.fn(),
    reset: vi.fn().mockResolvedValue(undefined),
  }
  pool = {
    getConnection: vi.fn().mockResolvedValue(connection),
    end: vi.fn().mockResolvedValue(undefined),
  }
  createPool.mockReset().mockReturnValue(pool)
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
})

async function boot(): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']> }> {
  const ctx = new Context()
  contexts.push(ctx)
  const fiber = ctx.plugin(Mysql, CONFIG)
  await fiber
  return { ctx, fiber }
}

describe('Mysql', () => {
  it('builds the configured pool, verifies startup, and returns callback results', async () => {
    const { ctx, fiber } = await boot()

    expect(createPool).toHaveBeenCalledWith({
      host: CONFIG.host,
      port: 3306,
      user: CONFIG.user,
      password: CONFIG.password,
      database: CONFIG.database,
      connectionLimit: 10,
      connectTimeout: 10_000,
    })
    expect(connection.ping).toHaveBeenCalledOnce()
    expect(connection.reset).toHaveBeenCalledOnce()
    expect(connection.query).toHaveBeenCalledOnce()
    expect(connection.query).toHaveBeenCalledWith('USE ??', [CONFIG.database])
    expect(connection.release).toHaveBeenCalledOnce()
    expect(connection.ping.mock.invocationCallOrder[0])
      .toBeLessThan(connection.reset.mock.invocationCallOrder[0]!)
    expect(connection.reset.mock.invocationCallOrder[0])
      .toBeLessThan(connection.query.mock.invocationCallOrder[0]!)
    expect(connection.query.mock.invocationCallOrder[0])
      .toBeLessThan(connection.release.mock.invocationCallOrder[0]!)

    await expect(ctx.mysql.connection(async (leased) => {
      expect(leased).not.toBe(connection)
      return 'connected'
    })).resolves.toBe('connected')
    expect(connection.reset).toHaveBeenCalledTimes(2)
    expect(connection.query).toHaveBeenCalledTimes(2)
    expect(connection.release).toHaveBeenCalledTimes(2)

    await fiber.dispose()
    expect(pool.end).toHaveBeenCalledOnce()
  })

  it('forwards explicit pool settings', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const fiber = ctx.plugin(Mysql, {
      ...CONFIG,
      port: 3307,
      connectionLimit: 4,
      connectTimeoutMs: 2500,
    })
    await fiber

    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({
      port: 3307,
      connectionLimit: 4,
      connectTimeout: 2500,
    }))
  })

  it('accepts the largest timer-safe connection timeout', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Mysql, {
      ...CONFIG,
      connectTimeoutMs: MAX_TIMER_DELAY_MS,
    })

    expect(createPool).toHaveBeenCalledWith(expect.objectContaining({
      connectTimeout: MAX_TIMER_DELAY_MS,
    }))
  })

  it('rejects a connection timeout that Node would clamp to one millisecond', async () => {
    const ctx = new Context()
    contexts.push(ctx)

    await expect(ctx.plugin(Mysql, {
      ...CONFIG,
      connectTimeoutMs: MAX_TIMER_DELAY_MS + 1,
    })).rejects.toThrow(/connectTimeoutMs/)
    expect(createPool).not.toHaveBeenCalled()
  })

  it('releases the connection when a callback rejects', async () => {
    const { ctx } = await boot()

    await expect(ctx.mysql.connection(() => {
      throw new Error('query failed')
    })).rejects.toThrow('query failed')
    expect(connection.reset).toHaveBeenCalledTimes(2)
    expect(connection.release).toHaveBeenCalledTimes(2)
  })

  it('destroys a connection after a failed reset without replacing a callback result', async () => {
    const { ctx } = await boot()
    connection.reset.mockRejectedValueOnce(new Error('reset failed'))

    await expect(ctx.mysql.connection(() => 'committed result')).resolves.toBe('committed result')
    expect(connection.destroy).toHaveBeenCalledOnce()
    expect(connection.query).toHaveBeenCalledOnce()
    expect(connection.release).toHaveBeenCalledOnce()
  })

  it('destroys a connection when restoring the configured database fails', async () => {
    const { ctx } = await boot()
    connection.query.mockRejectedValueOnce(new Error('database unavailable'))

    await expect(ctx.mysql.connection(() => 'committed result')).resolves.toBe('committed result')
    expect(connection.reset).toHaveBeenCalledTimes(2)
    expect(connection.destroy).toHaveBeenCalledOnce()
    expect(connection.release).toHaveBeenCalledOnce()
  })

  it('destroys a connection after a failed reset without replacing a callback error', async () => {
    const { ctx } = await boot()
    const callbackError = new Error('query failed')
    connection.reset.mockRejectedValueOnce(new Error('reset failed'))

    await expect(ctx.mysql.connection(() => {
      throw callbackError
    })).rejects.toBe(callbackError)
    expect(connection.destroy).toHaveBeenCalledOnce()
    expect(connection.release).toHaveBeenCalledOnce()
  })

  it('propagates pool acquisition failures without releasing a missing connection', async () => {
    const { ctx } = await boot()
    pool.getConnection.mockRejectedValueOnce(new Error('pool unavailable'))

    await expect(ctx.mysql.connection(() => 'unreachable')).rejects.toThrow('pool unavailable')
    expect(connection.reset).toHaveBeenCalledOnce()
    expect(connection.release).toHaveBeenCalledOnce()
  })

  it('blocks pool lifecycle access and invalidates escaped lease values', async () => {
    const { ctx } = await boot()
    const statement = {
      close: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue([[], []]),
    }
    connection.prepare.mockResolvedValue(statement)
    let retainedQuery: (() => unknown) | undefined
    let retainedStatement: typeof statement | undefined

    let retained: MysqlConnection | undefined
    await ctx.mysql.connection(async (leased) => {
      const unsafe = leased as unknown as Record<PropertyKey, unknown>
      expect(() => unsafe.release).toThrow(/does not expose/)
      expect(() => unsafe.connection).toThrow(/does not expose/)
      retained = leased
      const query = leased.query as (sql: string) => unknown
      retainedQuery = () => query('SELECT 1')
      retainedStatement = await leased.prepare('SELECT ?') as typeof statement
    })

    expect(() => retained?.query('SELECT 1')).toThrow(/lease has settled/)
    expect(() => retainedQuery?.()).toThrow(/lease has settled/)
    expect(() => {
      retainedStatement?.execute([1])
    }).toThrow(/lease has settled/)
    expect(statement.execute).not.toHaveBeenCalled()
    await expect(ctx.mysql.connection(leased => leased)).rejects.toThrow(/lease has settled/)
  })

  it('drains admitted callbacks before closing and rejects work after disposal', async () => {
    const { ctx, fiber } = await boot()
    const service = ctx.mysql
    const entered = Promise.withResolvers<undefined>()
    const unblock = Promise.withResolvers<undefined>()
    const running = service.connection(async () => {
      entered.resolve(undefined)
      await unblock.promise
    })
    await entered.promise

    const disposing = fiber.dispose()
    await Promise.resolve()
    expect(pool.end).not.toHaveBeenCalled()
    await expect(service.connection(() => 'late')).rejects.toThrow(/closing or closed/)
    unblock.resolve(undefined)
    await running
    await disposing

    expect(pool.end).toHaveBeenCalledOnce()
    await expect(service.connection(() => 'late')).rejects.toThrow(/closing or closed/)
  })

  it('closes the pool when startup ping fails', async () => {
    connection.ping.mockRejectedValueOnce(new Error('authentication failed'))
    const ctx = new Context()
    contexts.push(ctx)

    await expect(ctx.plugin(Mysql, CONFIG)).rejects.toThrow('authentication failed')
    expect(connection.reset).toHaveBeenCalledOnce()
    expect(connection.release).toHaveBeenCalledOnce()
    expect(pool.end).toHaveBeenCalledOnce()
  })
})
