import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import Redis from '../src/index.ts'
import type { Config } from '../src/index.ts'

const createClient = vi.hoisted(() => vi.fn())

vi.mock('@redis/client', () => ({ createClient }))

const CONFIG = {
  url: 'redis://dsh:test-only@redis.internal:6379/1',
}

type ErrorListener = (error: Error) => void
type ReadyListener = () => void
type ClientListener = ErrorListener | ReadyListener

interface FakeClient {
  isOpen: boolean
  isReady: boolean
  connect: ReturnType<typeof vi.fn>
  ping: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  off: ReturnType<typeof vi.fn>
}

let client: FakeClient
let errorListener: ErrorListener | undefined
let readyListener: ReadyListener | undefined
const contexts: Context[] = []

function makeClient(): FakeClient {
  const result: FakeClient = {
    isOpen: false,
    isReady: false,
    connect: vi.fn(async () => {
      result.isOpen = true
      result.isReady = true
      return result
    }),
    ping: vi.fn().mockResolvedValue('PONG'),
    close: vi.fn(async () => {
      result.isOpen = false
      result.isReady = false
    }),
    destroy: vi.fn(() => {
      result.isOpen = false
      result.isReady = false
    }),
    on: vi.fn((event: string, listener: ClientListener) => {
      if (event === 'error') errorListener = listener
      if (event === 'ready') readyListener = listener as ReadyListener
      return result
    }),
    off: vi.fn((event: string, listener: ClientListener) => {
      if (event === 'error' && errorListener === listener) errorListener = undefined
      if (event === 'ready' && readyListener === listener) readyListener = undefined
      return result
    }),
  }
  return result
}

beforeEach(() => {
  errorListener = undefined
  readyListener = undefined
  client = makeClient()
  createClient.mockReset().mockReturnValue(client)
})

afterEach(async () => {
  vi.useRealTimers()
  await Promise.allSettled(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
})

async function boot(config: Config = CONFIG): Promise<{ ctx: Context; fiber: ReturnType<Context['plugin']> }> {
  const ctx = new Context()
  contexts.push(ctx)
  const fiber = ctx.plugin(Redis, config)
  await fiber
  return { ctx, fiber }
}

describe('Redis', () => {
  it('builds the client, verifies startup, and returns callback results', async () => {
    const { ctx } = await boot()

    expect(createClient).toHaveBeenCalledWith({
      url: CONFIG.url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 10_000,
        reconnectStrategy: false,
      },
    })
    expect(client.connect).toHaveBeenCalledOnce()
    expect(client.ping).toHaveBeenCalledOnce()
    await expect(ctx.redis.withClient(async leased => leased.ping())).resolves.toBe('PONG')
    expect(client.ping).toHaveBeenCalledTimes(2)
  })

  it('reports one generic warning per unavailable interval', async () => {
    const { ctx } = await boot()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    errorListener?.(new Error('socket exposed no endpoint'))
    errorListener?.(new Error('same unavailable interval'))
    expect(warn).toHaveBeenCalledWith(
      'redis: connection error; commands fail while the client is unavailable',
    )
    expect(warn).toHaveBeenCalledTimes(1)

    readyListener?.()
    errorListener?.(new Error('later unavailable interval'))
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('forwards a rediss URL and explicit connection timeout', async () => {
    await boot({
      url: 'rediss://redis.internal:6380/2',
      connectTimeoutMs: 2500,
    })

    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      url: 'rediss://redis.internal:6380/2',
      socket: {
        connectTimeout: 2500,
        reconnectStrategy: false,
      },
    }))
  })

  it('accepts and forwards Node\'s maximum timer delay', async () => {
    await boot({ ...CONFIG, connectTimeoutMs: MAX_TIMER_DELAY_MS })

    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      socket: {
        connectTimeout: MAX_TIMER_DELAY_MS,
        reconnectStrategy: false,
      },
    }))
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['timer overflow', MAX_TIMER_DELAY_MS + 1],
  ])('rejects %s connection timeout before constructing a client', async (_name, connectTimeoutMs) => {
    const ctx = new Context()
    contexts.push(ctx)

    await expect(ctx.plugin(Redis, { ...CONFIG, connectTimeoutMs })).rejects.toThrow()
    expect(createClient).not.toHaveBeenCalled()
  })

  it.each([
    ['not a URL', /valid absolute redis: or rediss: URL/],
    ['http://redis.internal', /redis: or rediss: scheme/],
    ['redis:///1', /must name a host/],
  ])('rejects invalid target %s without constructing a client', async (url, message) => {
    const ctx = new Context()
    contexts.push(ctx)

    await expect(ctx.plugin(Redis, { url })).rejects.toThrow(message)
    expect(createClient).not.toHaveBeenCalled()
  })

  it('propagates callback failures', async () => {
    const { ctx } = await boot()

    await expect(ctx.redis.withClient(() => {
      throw new Error('command failed')
    })).rejects.toThrow('command failed')
  })

  it('rejects callbacks while the client is not ready', async () => {
    const { ctx } = await boot()
    client.isReady = false

    await expect(ctx.redis.withClient(() => 'unreachable')).rejects.toThrow(/unavailable or closing/)
  })

  it('drains concurrent callbacks, including a failure, before closing', async () => {
    const { ctx, fiber } = await boot()
    const service = ctx.redis
    const firstEntered = Promise.withResolvers<undefined>()
    const secondEntered = Promise.withResolvers<undefined>()
    const first = Promise.withResolvers<string>()
    const second = Promise.withResolvers<string>()
    const firstRunning = service.withClient(async () => {
      firstEntered.resolve(undefined)
      return first.promise
    })
    const secondRunning = service.withClient(async () => {
      secondEntered.resolve(undefined)
      return second.promise
    })
    await Promise.all([firstEntered.promise, secondEntered.promise])

    const disposing = fiber.dispose()
    await Promise.resolve()
    expect(client.close).not.toHaveBeenCalled()

    second.reject(new Error('concurrent command failed'))
    await expect(secondRunning).rejects.toThrow('concurrent command failed')
    expect(client.close).not.toHaveBeenCalled()

    first.resolve('done')
    await expect(firstRunning).resolves.toBe('done')
    await disposing

    expect(client.close).toHaveBeenCalledOnce()
    await expect(service.withClient(() => 'late')).rejects.toThrow(/unavailable or closing/)
  })

  it('closes the client when startup PING fails', async () => {
    client.ping.mockRejectedValueOnce(new Error('authentication failed'))
    const ctx = new Context()
    contexts.push(ctx)

    await expect(ctx.plugin(Redis, CONFIG)).rejects.toThrow('authentication failed')
    expect(client.close).toHaveBeenCalledOnce()
    expect(client.off).toHaveBeenCalledTimes(2)
  })

  it('removes its listeners when connection fails before the socket opens', async () => {
    client.connect.mockRejectedValueOnce(new Error('host unavailable'))
    const ctx = new Context()
    contexts.push(ctx)

    await expect(ctx.plugin(Redis, CONFIG)).rejects.toThrow('host unavailable')
    expect(client.close).not.toHaveBeenCalled()
    expect(client.off).toHaveBeenCalledTimes(2)
  })

  it('destroys a client whose startup exceeds the total timeout', async () => {
    vi.useFakeTimers()
    const connecting = Promise.withResolvers<FakeClient>()
    client.isOpen = true
    client.connect.mockReturnValue(connecting.promise)
    client.destroy.mockImplementation(() => {
      client.isOpen = false
      connecting.reject(new Error('connection destroyed'))
    })
    const ctx = new Context()
    contexts.push(ctx)

    const activation = ctx.plugin(Redis, { ...CONFIG, connectTimeoutMs: 25 })
    const rejected = expect(activation).rejects.toThrow('redis startup timed out after 25ms')
    await vi.advanceTimersByTimeAsync(25)
    await rejected

    expect(client.destroy).toHaveBeenCalledOnce()
    expect(client.close).not.toHaveBeenCalled()
    expect(client.off).toHaveBeenCalledTimes(2)
  })

  it('destroys a client whose startup PING exceeds the total timeout', async () => {
    vi.useFakeTimers()
    const pinging = Promise.withResolvers<string>()
    client.ping.mockReturnValue(pinging.promise)
    client.destroy.mockImplementation(() => {
      client.isOpen = false
      client.isReady = false
      pinging.reject(new Error('connection destroyed'))
    })
    const ctx = new Context()
    contexts.push(ctx)

    const activation = ctx.plugin(Redis, { ...CONFIG, connectTimeoutMs: 25 })
    const rejected = expect(activation).rejects.toThrow('redis startup timed out after 25ms')
    await vi.advanceTimersByTimeAsync(25)
    await rejected

    expect(client.connect).toHaveBeenCalledOnce()
    expect(client.ping).toHaveBeenCalledOnce()
    expect(client.destroy).toHaveBeenCalledOnce()
    expect(client.close).not.toHaveBeenCalled()
  })

  it('keeps connection-error handling attached until graceful close settles', async () => {
    const { ctx, fiber } = await boot()
    const closing = Promise.withResolvers<undefined>()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    client.close.mockReturnValueOnce(closing.promise)

    const disposing = fiber.dispose()
    await vi.waitFor(() => {
      expect(client.close).toHaveBeenCalledOnce()
    })

    expect(errorListener).toBeDefined()
    expect(readyListener).toBeDefined()
    errorListener?.(new Error('socket failed while closing'))
    expect(warn).toHaveBeenCalledWith(
      'redis: connection error; commands fail while the client is unavailable',
    )

    closing.resolve(undefined)
    await disposing
    expect(errorListener).toBeUndefined()
    expect(readyListener).toBeUndefined()
  })

  it('removes its listeners when graceful client close rejects', async () => {
    const { ctx, fiber } = await boot()
    const failure = new Error('close failed')
    const log = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    client.close.mockRejectedValueOnce(failure)

    await fiber.dispose()
    expect(log).toHaveBeenCalledWith(failure)
    expect(client.off).toHaveBeenCalledWith('error', expect.any(Function))
    expect(client.off).toHaveBeenCalledWith('ready', expect.any(Function))
    expect(errorListener).toBeUndefined()
    expect(readyListener).toBeUndefined()
  })
})
