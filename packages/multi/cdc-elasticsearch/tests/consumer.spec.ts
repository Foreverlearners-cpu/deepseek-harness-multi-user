import type { Context } from '@deepseek-ai/cordis'
import { encodeKey, type CdcEvent } from '@deepseek-ai/dsh-cdc'
import { apply, type Config } from '@deepseek-ai/dsh-cdc-elasticsearch'
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
  subscriptionId: 'search-users',
  consumerGroup: 'search-projection',
  topics: ['app.users'],
  fallbackMode: 'latest',
  retryInitialDelayMs: 1,
  retryMaxDelayMs: 2,
  maxRetries: 'unlimited',
  stateIndex: 'dsh-cdc-test-state-v1',
  routes: [{
    database: 'app',
    table: 'users',
    topic: 'app.users',
    index: 'users-v1',
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

describe('Elasticsearch CDC consumer', () => {
  interface IndexRequest {
    index: string
    id: string
    document: unknown
    version: number
    version_type: 'external_gte'
  }
  interface DeleteRequest {
    index: string
    id: string
    version: number
    version_type: 'external_gte'
  }
  const index = vi.fn<(request: IndexRequest, options?: { ignore: number[] }) => Promise<object>>()
  const remove = vi.fn<(request: DeleteRequest, options: { ignore: number[] }) => Promise<object>>()
  const warn = vi.fn()
  const error = vi.fn()
  const fiberDispose = vi.fn(async () => {})
  let request: KafkaSubscribeRequest | undefined
  let dispose: (() => Promise<void>) | undefined
  let activeSubscription: ControlledSubscription
  const subscribe = vi.fn(async (next: KafkaSubscribeRequest): Promise<KafkaSubscription> => {
    request = next
    return activeSubscription
  })
  const ctx = {
    kafka: { subscribe },
    elasticsearch: {
      operation: vi.fn(async (
        callback: (client: { index: typeof index; delete: typeof remove }) => Promise<void>,
      ) => callback({ index, delete: remove })),
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

  const versionConflict = (): Error & { statusCode: number; body: object } => Object.assign(
    new Error('version conflict'),
    {
      statusCode: 409,
      body: { error: { type: 'version_conflict_engine_exception' } },
    },
  )

  beforeEach(() => {
    request = undefined
    dispose = undefined
    activeSubscription = controlledSubscription('initial')
    subscribe.mockReset().mockImplementation(async (next) => {
      request = next
      return activeSubscription
    })
    index.mockReset().mockResolvedValue({})
    remove.mockReset().mockResolvedValue({})
    warn.mockReset()
    error.mockReset()
    fiberDispose.mockReset().mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await dispose?.()
  })

  it('uses stable ids and source-ordered external versions for writes and deletes', async () => {
    await apply(ctx, config)
    await handle(Buffer.from(JSON.stringify(event)))
    const sourceVersion = 0x1_0000_0000 + event.source.position
    const stateWrite = index.mock.calls.find(([call]) => call.index === config.stateIndex)?.[0]
    const targetWrite = index.mock.calls.find(([call]) => call.index === 'users-v1')?.[0]
    const originalId = targetWrite?.id
    expect(originalId).toMatch(/^[a-f0-9]{64}$/u)
    expect(stateWrite?.id).toMatch(/^[a-f0-9]{64}$/u)
    expect(stateWrite).toMatchObject({
      index: config.stateIndex,
      version: sourceVersion,
      version_type: 'external_gte',
      document: {
        specVersion: 1,
        eventId: event.eventId,
        source: event.source,
        kafka: { topic: 'app.users', partition: 0, offset: '7' },
      },
    })
    expect(targetWrite).toEqual({
      index: 'users-v1',
      id: originalId,
      document: event.after,
      version: sourceVersion,
      version_type: 'external_gte',
    })

    const changed = {
      ...event,
      operation: 'update',
      source: { ...event.source, position: 124 },
      before: event.after,
      after: { id: '42', name: 'Grace' },
    } satisfies CdcEvent
    await handle(Buffer.from(JSON.stringify(changed)), { offset: 8n })
    const targetWrites = index.mock.calls.filter(([call]) => call.index === 'users-v1')
    expect(targetWrites[1]?.[0]).toEqual(expect.objectContaining({
      id: originalId,
      version: sourceVersion + 1,
    }))

    await handle(Buffer.from(JSON.stringify({
      ...changed,
      source: { ...changed.source, position: 125 },
      before: changed.after,
      after: { ...changed.after, email: 'ignored@example.test' },
      changedColumns: ['email'],
    })), { offset: 9n })
    expect(index.mock.calls.filter(([call]) => call.index === 'users-v1')).toHaveLength(2)

    await handle(Buffer.from(JSON.stringify({
      ...changed,
      operation: 'delete',
      source: { ...changed.source, position: 126 },
      before: changed.after,
      after: null,
    })), { offset: 10n })
    expect(remove).toHaveBeenCalledWith({
      index: 'users-v1',
      id: originalId,
      version: sourceVersion + 3,
      version_type: 'external_gte',
    }, { ignore: [404] })
  })

  it('rejects mismatched keys and binlog coordinates outside the exact version range', async () => {
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
    await expect(handle(Buffer.from(JSON.stringify({
      ...event,
      source: { ...event.source, file: 'mysql-bin.current' },
    })))).rejects.toThrow(/external-version range/u)
    await expect(handle(Buffer.from(JSON.stringify({
      ...event,
      source: { ...event.source, position: 0x1_0000_0000 },
    })))).rejects.toThrow(/external-version range/u)
    await expect(handle(Buffer.from(JSON.stringify({
      ...event,
      source: { ...event.source, file: 'mysql-bin.2097152' },
    }))))
      .rejects.toThrow(/external-version range/u)

    await handle(Buffer.from(JSON.stringify({
      ...event,
      source: {
        ...event.source,
        file: 'mysql-bin.0000000000000000002097151',
        position: 0xffff_ffff,
      },
    })))
    const boundaryWrite = index.mock.calls.find(([call]) => call.index === config.stateIndex)?.[0]
    expect(boundaryWrite?.version).toBe(Number.MAX_SAFE_INTEGER)
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
    expect(index).toHaveBeenCalledTimes(2)
    expect(remove).not.toHaveBeenCalled()
  })

  it('acknowledges stale source events after Kafka partition movement', async () => {
    let currentVersion = 0
    index.mockImplementation(async (call) => {
      if (call.index !== config.stateIndex) return {}
      if (call.version < currentVersion) throw versionConflict()
      currentVersion = call.version
      return {}
    })
    await apply(ctx, config)

    await handle(Buffer.from(JSON.stringify({
      ...event,
      source: { ...event.source, position: 200 },
    })), { partition: 0, offset: 900n })
    await handle(Buffer.from(JSON.stringify({
      ...event,
      eventId: 'event-2',
      source: { ...event.source, position: 201 },
    })), { partition: 1, offset: 1n })
    await expect(handle(Buffer.from(JSON.stringify({
      ...event,
      eventId: 'event-stale',
      source: { ...event.source, position: 199 },
    })), { partition: 0, offset: 901n })).resolves.toBeUndefined()

    expect(index.mock.calls.filter(([call]) => call.index === 'users-v1')).toHaveLength(2)
  })

  it('resets retry backoff when a stale event is acknowledged', async () => {
    const lifecycle: string[] = []
    const first = controlledSubscription('first', lifecycle)
    const second = controlledSubscription('second', lifecycle)
    const third = controlledSubscription('third', lifecycle)
    let currentVersion = 0
    index.mockImplementation(async (call) => {
      if (call.index === config.stateIndex) {
        if (call.version < currentVersion) throw versionConflict()
        currentVersion = call.version
      }
      return {}
    })
    activeSubscription = first
    subscribe.mockImplementationOnce(async (next) => {
      request = next
      return first
    }).mockImplementationOnce(async (next) => {
      request = next
      return second
    }).mockImplementationOnce(async (next) => {
      request = next
      return third
    })

    await apply(ctx, { ...config, maxRetries: 1, retryInitialDelayMs: 1, retryMaxDelayMs: 1 })
    await handle(Buffer.from(JSON.stringify({
      ...event,
      source: { ...event.source, position: 200 },
    })))
    first.fail(new Error('first failure'))
    await vi.waitFor(() => { expect(subscribe).toHaveBeenCalledTimes(2) })

    await expect(handle(Buffer.from(JSON.stringify({
      ...event,
      eventId: 'event-stale',
      source: { ...event.source, position: 199 },
    })))).resolves.toBeUndefined()
    second.fail(new Error('second failure'))
    await vi.waitFor(() => { expect(subscribe).toHaveBeenCalledTimes(3) })
    expect(error).not.toHaveBeenCalledWith('cdc-elasticsearch: Kafka subscription stopped after 1 retries')

    await disposePlugin()
    dispose = undefined
  })

  it('resets retry backoff when a superseded target write is acknowledged', async () => {
    const lifecycle: string[] = []
    const first = controlledSubscription('first', lifecycle)
    const second = controlledSubscription('second', lifecycle)
    const third = controlledSubscription('third', lifecycle)
    let targetAttempts = 0
    let superseded = false
    index.mockImplementation(async (call) => {
      if (call.index === config.stateIndex) {
        if (superseded) throw versionConflict()
        return {}
      }
      targetAttempts += 1
      if (targetAttempts === 1) {
        superseded = true
        throw versionConflict()
      }
      return {}
    })
    activeSubscription = first
    subscribe.mockImplementationOnce(async (next) => {
      request = next
      return first
    }).mockImplementationOnce(async (next) => {
      request = next
      return second
    }).mockImplementationOnce(async (next) => {
      request = next
      return third
    })

    await apply(ctx, { ...config, maxRetries: 1, retryInitialDelayMs: 1, retryMaxDelayMs: 1 })
    first.fail(new Error('first failure'))
    await vi.waitFor(() => { expect(subscribe).toHaveBeenCalledTimes(2) })
    await expect(handle(Buffer.from(JSON.stringify(event)))).resolves.toBeUndefined()
    second.fail(new Error('second failure'))
    await vi.waitFor(() => { expect(subscribe).toHaveBeenCalledTimes(3) })
    expect(error).not.toHaveBeenCalledWith('cdc-elasticsearch: Kafka subscription stopped after 1 retries')

    await disposePlugin()
    dispose = undefined
  })

  it('retries the same source version but acknowledges a superseded target write', async () => {
    let targetAttempts = 0
    let superseded = false
    index.mockImplementation(async (call) => {
      if (call.index === config.stateIndex) {
        if (superseded) throw versionConflict()
        return {}
      }
      targetAttempts += 1
      if (targetAttempts === 1) throw new Error('temporary target failure')
      if (targetAttempts === 3) {
        superseded = true
        throw versionConflict()
      }
      return {}
    })
    await apply(ctx, config)

    await expect(handle(Buffer.from(JSON.stringify(event)))).rejects.toThrow(/temporary target/u)
    await expect(handle(Buffer.from(JSON.stringify(event)))).resolves.toBeUndefined()
    await expect(handle(Buffer.from(JSON.stringify({
      ...event,
      eventId: 'event-superseded',
      source: { ...event.source, position: 124 },
    })))).resolves.toBeUndefined()

    expect(index.mock.calls.filter(([call]) => call.index === config.stateIndex)).toHaveLength(4)
    expect(index.mock.calls.filter(([call]) => call.index === 'users-v1')).toHaveLength(3)
  })

  it('does not hide unrelated state conflicts or target version divergence', async () => {
    index.mockRejectedValueOnce(Object.assign(new Error('other conflict'), {
      statusCode: 409,
      body: { error: { type: 'document_already_exists_exception' } },
    }))
    await apply(ctx, config)
    await expect(handle(Buffer.from(JSON.stringify(event)))).rejects.toThrow(/other conflict/u)

    index.mockReset().mockImplementation(async (call) => {
      if (call.index === 'users-v1') throw versionConflict()
      return {}
    })
    await expect(handle(Buffer.from(JSON.stringify(event)))).rejects.toThrow(/version conflict/u)
    expect(index.mock.calls.filter(([call]) => call.index === config.stateIndex)).toHaveLength(2)
  })

  it('keeps ordering state stable when the Kafka consumer group changes', async () => {
    await apply(ctx, config)
    await handle(Buffer.from(JSON.stringify(event)))
    const firstStateId = index.mock.calls.find(([call]) => call.index === config.stateIndex)?.[0].id
    await dispose?.()
    dispose = undefined

    activeSubscription = controlledSubscription('replacement')
    await apply(ctx, {
      ...config,
      subscriptionId: 'search-users-replacement',
      consumerGroup: 'search-projection-replacement',
    })
    await handle(Buffer.from(JSON.stringify(event)))
    const stateWrites = index.mock.calls.filter(([call]) => call.index === config.stateIndex)

    expect(stateWrites).toHaveLength(2)
    expect(stateWrites[1]?.[0].id).toBe(firstStateId)
  })

  it('rejects tombstones, unknown routes, and wrong topics', async () => {
    await apply(ctx, config)
    await expect(handle(null)).rejects.toThrow(/tombstones/u)
    await expect(handle(Buffer.from(JSON.stringify({
      ...event,
      source: { ...event.source, table: 'missing' },
    })))).rejects.toThrow(/no configured route/u)
    await expect(handle(Buffer.from(JSON.stringify(event)), { topic: 'wrong' })).rejects.toThrow(/wrong topic/u)
  })

  it('closes failed subscriptions before retry and reports exhausted retries', async () => {
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

    await apply(ctx, { ...config, maxRetries: 1 })
    first.fail(new Error('first failure'))
    await vi.waitFor(() => { expect(subscribe).toHaveBeenCalledTimes(2) })
    expect(lifecycle).toEqual(['subscribe:first', 'close:first', 'subscribe:second'])

    second.fail(new Error('second failure'))
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith('cdc-elasticsearch: Kafka subscription stopped after 1 retries')
    })
    await vi.waitFor(() => { expect(fiberDispose).toHaveBeenCalledTimes(1) })
    expect(lifecycle.filter(item => item === 'close:second')).toHaveLength(1)
    expect(subscribe).toHaveBeenCalledTimes(2)
  })

  it('handles retry cleanup and subscribe failures, then cancels pending backoff', async () => {
    const first = controlledSubscription('first', undefined, new Error('close failed'))
    activeSubscription = first
    subscribe.mockImplementationOnce(async (next) => {
      request = next
      return first
    }).mockRejectedValueOnce(new Error('subscribe failed'))

    await apply(ctx, { ...config, retryInitialDelayMs: 1, retryMaxDelayMs: 1, maxRetries: 1 })
    first.fail(new Error('handler failed'))
    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith('cdc-elasticsearch: Kafka subscription stopped after 1 retries')
    })
    expect(warn).toHaveBeenCalledWith('cdc-elasticsearch: failed subscription cleanup before retry')
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
        'cdc-elasticsearch: plugin unload failed after Kafka retries were exhausted',
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
      expect(warn).toHaveBeenCalledWith('cdc-elasticsearch: failed subscription cleanup after disposal')
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

  it('uses an empty watched-column list when the route omits it', async () => {
    await apply(ctx, {
      ...config,
      routes: [{ database: 'app', table: 'users', topic: 'app.users', index: 'users-v1' }],
    })
    const changed = {
      ...event,
      operation: 'update',
      before: event.after,
      after: { id: '42', name: 'Grace' },
    } satisfies CdcEvent
    await handle(Buffer.from(JSON.stringify(changed)))
    expect(index.mock.calls.filter(([call]) => call.index === 'users-v1')).toHaveLength(1)
  })

  it('rejects blank, unrouted, duplicated, and inconsistent configuration', async () => {
    await expect(apply(ctx, { ...config, consumerGroup: '\t' })).rejects.toThrow(/non-blank/u)
    await expect(apply(ctx, { ...config, routes: [] })).rejects.toThrow(/at least one route/u)
    await expect(apply(ctx, { ...config, topics: ['app.users', 'missing'] })).rejects.toThrow(/must have a route/u)
    await expect(apply(ctx, { ...config, topics: ['same', 'same'] })).rejects.toThrow(/non-blank/u)
    await expect(apply(ctx, {
      ...config,
      routes: [{ ...config.routes[0]!, index: ' ' }],
    })).rejects.toThrow(/invalid or duplicate route/u)
    await expect(apply(ctx, {
      ...config,
      routes: [{ ...config.routes[0]!, watchedColumns: ['name', 'name'] }],
    })).rejects.toThrow(/invalid or duplicate route/u)
    await expect(apply(ctx, {
      ...config,
      routes: [{ ...config.routes[0]!, index: config.stateIndex }],
    })).rejects.toThrow(/invalid or duplicate route/u)
    await expect(apply(ctx, {
      ...config,
      retryInitialDelayMs: 3,
      retryMaxDelayMs: 2,
    })).rejects.toThrow(/must not exceed/u)
  })
})
