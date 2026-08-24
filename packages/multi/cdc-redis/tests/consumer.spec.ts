import type { Context } from '@deepseek-ai/cordis'
import { encodeKey, type CdcEvent } from '@deepseek-ai/dsh-cdc'
import { apply, type Config } from '@deepseek-ai/dsh-cdc-redis'
import {
  type KafkaConsumedMessage,
  type KafkaSubscribeRequest,
  type KafkaSubscription,
  KafkaSubscriptionId,
  KafkaTopic,
} from '@deepseek-ai/dsh-kafka'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const event: CdcEvent = {
  specVersion: 1,
  eventId: 'event-1',
  operation: 'insert',
  occurredAt: '2026-08-19T12:00:00.000Z',
  source: { database: 'app', table: 'users', file: 'mysql-bin.000001', position: 123 },
  key: { id: '42' },
  before: null,
  after: { id: '42', name: 'Ada' },
  schemaFingerprint: 'schema-1',
}

const config = {
  subscriptionId: 'redis-users',
  consumerGroup: 'redis-projection',
  topics: ['app.users'],
  fallbackMode: 'latest',
  commandTimeoutMs: 50,
  retryInitialDelayMs: 1,
  retryMaxDelayMs: 2,
  maxRetries: 'unlimited',
  routes: [{
    database: 'app',
    table: 'users',
    topic: 'app.users',
    keyPrefix: 'users',
    ttlSeconds: 60,
    watchedColumns: ['name'],
  }],
} satisfies Config

interface ControlledSubscription extends KafkaSubscription {
  fail(error: Error): void
}

function controlledSubscription(
  label: string,
  events?: string[],
  closeFailure?: unknown,
  settleOnClose = true,
): ControlledSubscription {
  const completion = Promise.withResolvers<undefined>()
  let settled = false
  let closeFailed = false
  return {
    id: KafkaSubscriptionId(label),
    done: completion.promise,
    close: vi.fn(async () => {
      events?.push(`close:${label}`)
      if (settleOnClose && !settled) {
        settled = true
        completion.resolve(undefined)
      }
      if (closeFailure !== undefined && !closeFailed) {
        closeFailed = true
        throw closeFailure
      }
    }),
    fail(error) {
      if (settled) return
      settled = true
      completion.reject(error)
    },
  }
}

describe('Redis CDC consumer', () => {
  interface EvalOptions {
    keys: string[]
    arguments: string[]
  }
  const evalCommand = vi.fn<(script: string, options: EvalOptions) => Promise<unknown>>()
  const warn = vi.fn()
  const error = vi.fn()
  const fiberDispose = vi.fn(async () => {})
  let request: KafkaSubscribeRequest | undefined
  let dispose: (() => Promise<void>) | undefined
  let activeSubscription: ControlledSubscription
  let commandSignal: AbortSignal | undefined
  const subscribe = vi.fn(async (next: KafkaSubscribeRequest): Promise<KafkaSubscription> => {
    request = next
    return activeSubscription
  })
  const ctx = {
    kafka: { subscribe },
    redis: {
      withClient: vi.fn(async (
        callback: (client: {
          withAbortSignal(signal: AbortSignal): { eval: typeof evalCommand }
        }) => Promise<void>,
      ) => callback({
        withAbortSignal(signal) {
          commandSignal = signal
          return { eval: evalCommand }
        },
      })),
    },
    logger: { warn, error },
    fiber: { dispose: fiberDispose },
    effect: vi.fn((execute: () => () => Promise<void>) => {
      dispose = execute()
      return vi.fn(async () => {})
    }),
  } as unknown as Context

  const message = (
    value: Buffer | null,
    options: { topic?: string; key?: Buffer | null; partition?: number; offset?: bigint } = {},
  ): KafkaConsumedMessage => ({
    topic: KafkaTopic(options.topic ?? 'app.users'),
    partition: options.partition ?? 0,
    offset: options.offset ?? 7n,
    timestamp: 0n,
    key: options.key === undefined ? encodeKey(event.key) : options.key,
    value,
    headers: [],
  })

  const handle = async (
    value: Buffer | null,
    options?: { topic?: string; key?: Buffer | null; partition?: number; offset?: bigint },
  ): Promise<void> => {
    if (request === undefined) throw new Error('test subscription is unavailable')
    await request.handle(message(value, options))
  }

  const disposePlugin = (): Promise<void> => {
    if (dispose === undefined) throw new Error('test plugin disposal is unavailable')
    return dispose()
  }

  beforeEach(() => {
    request = undefined
    dispose = undefined
    commandSignal = undefined
    activeSubscription = controlledSubscription('initial')
    subscribe.mockReset().mockImplementation(async (next) => {
      request = next
      return activeSubscription
    })
    evalCommand.mockReset().mockResolvedValue(1)
    warn.mockReset()
    error.mockReset()
    fiberDispose.mockReset().mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await dispose?.()
  })

  it('atomically writes JSON with offset metadata and applies watched-column filtering', async () => {
    await apply(ctx, config)
    await handle(Buffer.from(JSON.stringify(event)))

    const [script, options] = evalCommand.mock.calls[0] ?? []
    expect(script).toEqual(expect.stringContaining("redis.call('HSET'"))
    expect(options).toEqual({
      keys: [
        expect.stringMatching(/^users:[a-f0-9]{64}$/u),
        expect.stringMatching(/^users:[a-f0-9]{64}:__dsh_cdc_version$/u),
      ],
      arguments: ['app.users', '0', '7', 'write', JSON.stringify(event.after), '60'],
    })

    const changed = {
      ...event,
      operation: 'update',
      before: event.after,
      after: { id: '42', name: 'Grace' },
    } satisfies CdcEvent
    await handle(Buffer.from(JSON.stringify(changed)), { offset: 8n })
    expect(evalCommand.mock.calls[1]?.[1].arguments).toEqual([
      'app.users', '0', '8', 'write', JSON.stringify(changed.after), '60',
    ])

    await handle(Buffer.from(JSON.stringify({
      ...changed,
      before: changed.after,
      after: { ...changed.after, email: 'ignored@example.test' },
      changedColumns: ['email'],
    })), { offset: 9n })
    expect(evalCommand).toHaveBeenCalledTimes(2)

    await handle(Buffer.from(JSON.stringify({
      ...changed,
      operation: 'delete',
      before: changed.after,
      after: null,
    })), { offset: 10n })
    expect(evalCommand.mock.calls[2]?.[1].arguments).toEqual([
      'app.users', '0', '10', 'delete', '', '60',
    ])
  })

  it('rejects mismatched Kafka keys, row-image keys, and partition movement', async () => {
    await apply(ctx, config)
    await expect(handle(Buffer.from(JSON.stringify(event)), { key: null })).rejects.toThrow(/Kafka key/u)
    await expect(handle(Buffer.from(JSON.stringify(event)), { key: Buffer.from('{"id":"other"}') }))
      .rejects.toThrow(/Kafka key/u)
    await expect(handle(Buffer.from(JSON.stringify({
      ...event,
      after: { name: 'Ada' },
    })))).rejects.toThrow(/row image/u)
    await expect(handle(Buffer.from(JSON.stringify({
      ...event,
      after: { ...event.after, id: 'other' },
    })))).rejects.toThrow(/row image/u)
    evalCommand.mockResolvedValueOnce(-1)
    await expect(handle(Buffer.from(JSON.stringify(event)), { partition: 1 }))
      .rejects.toThrow(/different Kafka topic or partition/u)
    evalCommand.mockResolvedValueOnce(2)
    await expect(handle(Buffer.from(JSON.stringify(event))))
      .rejects.toThrow(/unexpected result/u)
    evalCommand.mockResolvedValueOnce(0)
    await expect(handle(Buffer.from(JSON.stringify(event)))).resolves.toBeUndefined()
  })

  it('projects older watched updates when change metadata is missing', async () => {
    await apply(ctx, config)
    const changed = {
      ...event,
      operation: 'update',
      before: event.after,
      after: { id: '42', name: 'Grace' },
    } satisfies CdcEvent
    await expect(handle(Buffer.from(JSON.stringify(changed)))).resolves.toBeUndefined()
    expect(evalCommand).toHaveBeenCalledTimes(1)
  })

  it('rejects tombstones, unknown routes, wrong topics, and Redis command failures', async () => {
    await apply(ctx, config)
    await expect(handle(null)).rejects.toThrow(/tombstones/u)
    await expect(handle(Buffer.from(JSON.stringify({
      ...event,
      source: { ...event.source, table: 'missing' },
    })))).rejects.toThrow(/no configured route/u)
    await expect(handle(Buffer.from(JSON.stringify(event)), { topic: 'wrong' })).rejects.toThrow(/wrong topic/u)
    evalCommand.mockRejectedValueOnce(new Error('Redis failed'))
    await expect(handle(Buffer.from(JSON.stringify(event)))).rejects.toThrow('Redis failed')
  })

  it('aborts a Redis command at the configured deadline', async () => {
    await apply(ctx, { ...config, commandTimeoutMs: 5 })
    evalCommand.mockImplementationOnce(async () => new Promise((resolve, reject) => {
      const signal = commandSignal
      if (signal === undefined) {
        resolve(1)
        return
      }
      signal.addEventListener('abort', () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('test command aborted'))
      }, { once: true })
    }))
    await expect(handle(Buffer.from(JSON.stringify(event)))).rejects.toThrow(/timed out after 5ms/u)
    expect(commandSignal?.aborted).toBe(true)
  })

  it('closes a failed subscription before retrying and stops the retry owner on disposal', async () => {
    const lifecycle: string[] = []
    const first = controlledSubscription('first', lifecycle)
    const second = controlledSubscription('second', lifecycle)
    activeSubscription = first
    subscribe.mockImplementationOnce(async (next) => {
      lifecycle.push('subscribe:first')
      request = next
      return first
    }).mockImplementationOnce(async (next) => {
      lifecycle.push('subscribe:second')
      request = next
      return second
    })

    await apply(ctx, config)
    first.fail(new Error('runtime failure'))
    await vi.waitFor(() => { expect(subscribe).toHaveBeenCalledTimes(2) })
    expect(lifecycle).toEqual(['subscribe:first', 'close:first', 'subscribe:second'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('retrying in 1ms'))

    await disposePlugin()
    dispose = undefined
    expect(lifecycle.filter(item => item === 'close:second')).toHaveLength(1)
  })

  it('bounds retries, handles retry cleanup failures, and cancels pending backoff', async () => {
    const lifecycle: string[] = []
    const first = controlledSubscription('first', lifecycle, new Error('close failed'))
    activeSubscription = first
    subscribe.mockImplementationOnce(async (next) => {
      request = next
      return first
    }).mockRejectedValueOnce(new Error('subscribe failed'))

    await apply(ctx, { ...config, retryInitialDelayMs: 1, retryMaxDelayMs: 1, maxRetries: 1 })
    first.fail(new Error('handler failed'))
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith('cdc-redis: Kafka subscription stopped after 1 retries')
    })
    await vi.waitFor(() => { expect(fiberDispose).toHaveBeenCalledTimes(1) })
    expect(warn).toHaveBeenCalledWith('cdc-redis: failed subscription cleanup before retry')
    expect(subscribe).toHaveBeenCalledTimes(2)
    await expect(disposePlugin()).rejects.toThrow('close failed')
    dispose = undefined

    activeSubscription = controlledSubscription('backoff')
    subscribe.mockReset().mockImplementation(async (next) => {
      request = next
      return activeSubscription
    })
    await apply(ctx, { ...config, retryInitialDelayMs: 10_000, retryMaxDelayMs: 10_000 })
    activeSubscription.fail(new Error('wait failure'))
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('10000ms')) })
    await disposePlugin()
    dispose = undefined
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('reports a failed automatic unload after retry exhaustion', async () => {
    fiberDispose.mockRejectedValueOnce(new Error('unload failed'))
    await apply(ctx, { ...config, maxRetries: 0 })

    activeSubscription.fail(new Error('runtime failure'))

    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith(
        'cdc-redis: plugin unload failed after Kafka retries were exhausted',
      )
    })
    expect(fiberDispose).toHaveBeenCalledTimes(1)
  })

  it('returns immediately when disposal aborts just before retry waiting begins', async () => {
    activeSubscription = controlledSubscription('pre-aborted')
    let disposing: Promise<void> | undefined
    warn.mockImplementationOnce(() => { disposing = dispose?.() })

    await apply(ctx, { ...config, retryInitialDelayMs: 10_000, retryMaxDelayMs: 10_000 })
    activeSubscription.fail(new Error('runtime failure'))
    await vi.waitFor(() => { expect(disposing).toBeDefined() })
    if (disposing === undefined) throw new Error('test disposal did not start')
    await disposing
    dispose = undefined
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('contains close failures from subscriptions created while disposal waits for a retry', async () => {
    const lifecycle: string[] = []
    const first = controlledSubscription('first', lifecycle)
    const closeFailure = new Error('late close failed')
    const second = controlledSubscription('second', lifecycle, closeFailure)
    const retry = Promise.withResolvers<KafkaSubscription>()
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (cause: unknown): void => {
      unhandledRejections.push(cause)
    }
    activeSubscription = first
    subscribe.mockImplementationOnce(async (next) => {
      request = next
      return first
    }).mockImplementationOnce(async () => retry.promise)

    await apply(ctx, config)
    first.fail(new Error('runtime failure'))
    await vi.waitFor(() => { expect(subscribe).toHaveBeenCalledTimes(2) })
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const disposing = disposePlugin()
      second.fail(new Error('late subscription failed'))
      retry.resolve(second)
      await expect(disposing).resolves.toBeUndefined()
      dispose = undefined
      await new Promise<void>(resolve => setImmediate(resolve))

      expect(lifecycle.filter(item => item === 'close:second')).toHaveLength(1)
      expect(warn).toHaveBeenCalledWith('cdc-redis: failed subscription cleanup after disposal')
      expect(unhandledRejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('surfaces Error and non-Error subscription close failures during disposal', async () => {
    activeSubscription = controlledSubscription('error-close', undefined, new Error('close error'))
    await apply(ctx, config)
    await expect(dispose?.()).rejects.toThrow('close error')
    dispose = undefined

    activeSubscription = controlledSubscription('value-close', undefined, 'close value')
    await apply(ctx, config)
    await expect(disposePlugin()).rejects.toThrow(/subscription close failed/u)
    dispose = undefined

    activeSubscription = controlledSubscription('null-close', undefined, null)
    await apply(ctx, config)
    await expect(disposePlugin()).rejects.toThrow(/subscription close failed/u)
    dispose = undefined

    activeSubscription = controlledSubscription(
      'pending-done-close',
      undefined,
      new Error('close while done remains pending'),
      false,
    )
    await apply(ctx, config)
    await expect(disposePlugin()).rejects.toThrow('close while done remains pending')
    dispose = undefined
  })

  it('uses route defaults when TTL and watched columns are omitted', async () => {
    await apply(ctx, {
      ...config,
      routes: [{
        database: 'app',
        table: 'users',
        topic: 'app.users',
        keyPrefix: 'users',
      }],
    })
    await handle(Buffer.from(JSON.stringify(event)))
    expect(evalCommand.mock.calls[0]?.[1].arguments.at(-1)).toBe('0')
  })

  it('rejects blank, unrouted, duplicated, and unbounded configuration', async () => {
    await expect(apply(ctx, { ...config, subscriptionId: '   ' })).rejects.toThrow(/non-blank/u)
    await expect(apply(ctx, { ...config, routes: [] })).rejects.toThrow(/at least one route/u)
    await expect(apply(ctx, { ...config, topics: ['app.users', 'missing'] })).rejects.toThrow(/must have a route/u)
    await expect(apply(ctx, {
      ...config,
      routes: [{ ...config.routes[0]!, watchedColumns: ['name', 'name'] }],
    })).rejects.toThrow(/invalid or duplicate route/u)
    await expect(apply(ctx, {
      ...config,
      routes: [{ ...config.routes[0]!, watchedColumns: [' '] }],
    })).rejects.toThrow(/invalid or duplicate route/u)
    await expect(apply(ctx, {
      ...config,
      routes: [{ ...config.routes[0]!, ttlSeconds: 31_536_001 }],
    })).rejects.toThrow(/invalid or duplicate route/u)
    await expect(apply(ctx, {
      ...config,
      retryInitialDelayMs: 3,
      retryMaxDelayMs: 2,
    })).rejects.toThrow(/must not exceed/u)
  })
})
