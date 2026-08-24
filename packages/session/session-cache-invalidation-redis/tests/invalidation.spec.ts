import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { encodeCdcEvent, encodeKey, type CdcEvent } from '@deepseek-ai/dsh-cdc-protocol'
import type { KafkaEventConsumerOptions } from '@deepseek-ai/dsh-kafka-events'
import { KafkaTopic, type KafkaConsumedMessage } from '@deepseek-ai/dsh-kafka'
import {
  SESSION_CACHE_WATCHED_COLUMNS,
  apply,
  applySessionContextCacheSnapshot,
  refillSessionContextCache,
  sessionContextCacheKey,
  sessionContextCacheWatermarkKey,
} from '../src/index.ts'

const CONFIG = {
  topic: 'dsh.cdc.session_messages.v1',
  groupId: 'session-cache',
  subscriptionId: 'session-cache-redis',
  fallbackMode: 'fail',
  maxBytes: 4096,
  database: 'dsh',
  table: 'session_messages',
  schemaFingerprint: 'schema-1',
} as const

const row = {
  tenant_id: 'tenant-1',
  user_id: 'user-1',
  session_id: 'session-1',
  message_id: 'message-1',
  revision: '12',
  status: 'completed',
  visibility: 'user',
  role: 'assistant',
  visible_text: 'hello',
  occurred_at: '2026-08-23T00:00:00.000Z',
}

type RedisEvalOptions = { keys: string[]; arguments: string[] }

function redisEvalMock(): ReturnType<typeof vi.fn<(script: string, options: RedisEvalOptions) => Promise<number>>> {
  return vi.fn(async (_script: string, _options: RedisEvalOptions) => 1)
}

function event(overrides: Partial<CdcEvent> = {}): CdcEvent {
  return {
    specVersion: 1,
    eventId: 'event-1',
    operation: 'update',
    occurredAt: '2026-08-23T00:00:00.000Z',
    source: { database: CONFIG.database, table: CONFIG.table, file: 'mysql-bin.000001', position: 10 },
    key: {
      tenant_id: row.tenant_id,
      user_id: row.user_id,
      session_id: row.session_id,
      message_id: row.message_id,
    },
    before: { ...row, visible_text: 'old', revision: '11' },
    after: row,
    changedColumns: ['visible_text', 'revision'],
    schemaFingerprint: CONFIG.schemaFingerprint,
    ...overrides,
  }
}

function message(source: CdcEvent, overrides: Partial<KafkaConsumedMessage> = {}): KafkaConsumedMessage {
  return {
    topic: KafkaTopic(CONFIG.topic),
    partition: 1,
    offset: 8n,
    timestamp: 1n,
    key: encodeKey(source.key),
    value: encodeCdcEvent(source),
    headers: [],
    ...overrides,
  }
}

async function harness(): Promise<{
  options: KafkaEventConsumerOptions<CdcEvent>
  evalMock: ReturnType<typeof redisEvalMock>
  close: ReturnType<typeof vi.fn>
  fail: (cause: unknown) => undefined
  error: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  dispose: () => Promise<void>
}> {
  let options: KafkaEventConsumerOptions<CdcEvent> | undefined
  const close = vi.fn(async () => {})
  const evalMock = redisEvalMock()
  const failure = Promise.withResolvers<undefined>()
  const error = vi.fn()
  const stop = vi.fn(async () => {})
  let dispose: (() => Promise<void>) | undefined
  const ctx = {
    kafkaEvents: {
      subscribe: async (candidate: KafkaEventConsumerOptions<CdcEvent>) => {
        options = candidate
        return { id: candidate.id, done: failure.promise, health: vi.fn(), close }
      },
    },
    redis: { withClient: async (callback: (client: { eval: typeof evalMock }) => unknown) => callback({ eval: evalMock }) },
    logger: { error },
    fiber: { dispose: stop },
    effect: (setup: () => () => Promise<void>) => { dispose = setup() },
  }
  await apply(ctx as unknown as Context, CONFIG)
  if (options === undefined) throw new Error('subscription not created')
  if (dispose === undefined) throw new Error('disposer not registered')
  return {
    options,
    evalMock,
    close,
    fail: (cause: unknown) => {
      failure.reject(cause)
      return undefined
    },
    error,
    stop,
    dispose,
  }
}

async function consume(options: KafkaEventConsumerOptions<CdcEvent>, source: CdcEvent, record = message(source)): Promise<boolean> {
  const delivery = { event: options.codec.decode(record.value ?? undefined, record), message: record }
  const accepted = options.filter === undefined || await options.filter.accept(delivery)
  if (accepted) await options.handler.handle(delivery)
  return accepted
}

describe('session CDC cache invalidation', () => {
  it.each(['insert', 'delete'] as const)('invalidates %s with an authoritative revision watermark', async (operation) => {
    const setup = await harness()
    const source = operation === 'insert'
      ? event({ operation, before: null, after: row, changedColumns: Object.keys(row) })
      : event({ operation, before: row, after: null, changedColumns: Object.keys(row) })

    expect(await consume(setup.options, source)).toBe(true)
    expect(setup.evalMock).toHaveBeenCalledOnce()
    const [, call] = setup.evalMock.mock.calls[0] ?? []
    expect(call).toEqual({
      keys: [
        sessionContextCacheWatermarkKey({ tenantId: row.tenant_id, userId: row.user_id, sessionId: row.session_id }),
        sessionContextCacheKey({ tenantId: row.tenant_id, userId: row.user_id, sessionId: row.session_id }),
      ],
      arguments: ['12'],
    })
  })

  it('skips only an update with an explicit disjoint changed-column hint', async () => {
    const setup = await harness()
    const unrelated = event({ before: { ...row, revision: '11' }, changedColumns: ['revision'] })
    expect(await consume(setup.options, unrelated)).toBe(false)
    expect(setup.evalMock).not.toHaveBeenCalled()

    const missing = event()
    delete missing.changedColumns
    expect(await consume(setup.options, missing)).toBe(true)
    expect(setup.evalMock).toHaveBeenCalledOnce()
    expect(SESSION_CACHE_WATCHED_COLUMNS.has('visible_text')).toBe(true)
  })

  it.each([
    ['topic', (source: CdcEvent) => message(source, { topic: KafkaTopic('wrong') })],
    ['database', (source: CdcEvent) => message({ ...source, source: { ...source.source, database: 'wrong' } })],
    ['table', (source: CdcEvent) => message({ ...source, source: { ...source.source, table: 'wrong' } })],
    ['schema', (source: CdcEvent) => message({ ...source, schemaFingerprint: 'wrong' })],
    ['Kafka key', (source: CdcEvent) => message(source, { key: Buffer.from('{}') })],
    ['row identity', (source: CdcEvent) => message({
      ...source,
      after: { ...row, tenant_id: 'wrong' },
      changedColumns: ['tenant_id', 'visible_text', 'revision'],
    })],
  ])('rejects a mismatched %s before Redis', async (_name, make) => {
    const setup = await harness()
    const source = event()
    await expect(async () => {
      const record = make(source)
      await consume(setup.options, source, record)
    }).rejects.toThrow(/session-cache-invalidation-redis/u)
    expect(setup.evalMock).not.toHaveBeenCalled()
  })

  it('propagates Redis failure so the event runner cannot commit', async () => {
    const setup = await harness()
    setup.evalMock.mockRejectedValueOnce(new Error('redis failed'))
    await expect(consume(setup.options, event())).rejects.toThrow(/redis failed/u)
  })

  it.each([
    ['row fields', { ...row, unexpected: 'x' }, ['unexpected', 'visible_text', 'revision']],
    ['required string', { ...row, status: '' }, ['status', 'visible_text', 'revision']],
    ['occurred_at', { ...row, occurred_at: 'yesterday' }, ['occurred_at', 'visible_text', 'revision']],
    ['visible_text', { ...row, visible_text: { nested: true } }, ['visible_text', 'revision']],
  ])('rejects invalid %s', async (_name, after, changedColumns) => {
    const setup = await harness()
    const source = event({ after, changedColumns })
    await expect(consume(setup.options, source)).rejects.toThrow(/session-cache-invalidation-redis/u)
  })

  it('rejects an incomplete CDC identity key and a tombstone', async () => {
    const setup = await harness()
    const source = event({ key: { tenant_id: row.tenant_id } })
    await expect(consume(setup.options, source)).rejects.toThrow(/key fields/u)
    const tombstone = message(event(), { value: null })
    expect(() => setup.options.codec.decode(undefined, tombstone)).toThrow(/tombstones/u)
  })

  it('exposes producer-compatible encoding and closes the owned subscription', async () => {
    const setup = await harness()
    expect(setup.options.codec.encode(event())).toEqual(encodeCdcEvent(event()))
    await setup.dispose()
    expect(setup.close).toHaveBeenCalledOnce()
  })

  it('uses a tenant-isolated key and guards cache refill with the watermark', async () => {
    const client = { eval: redisEvalMock() }
    const accepted = await refillSessionContextCache(client, {
      tenantId: 'tenant-1', userId: 'user-1', sessionId: 'session-1', revision: '12', value: 'cached',
    })
    expect(accepted).toBe(true)
    expect(client.eval.mock.calls[0]?.[1]).toEqual({
      keys: [
        sessionContextCacheWatermarkKey({ tenantId: 'tenant-1', userId: 'user-1', sessionId: 'session-1' }),
        sessionContextCacheKey({ tenantId: 'tenant-1', userId: 'user-1', sessionId: 'session-1' }),
      ],
      arguments: ['12', 'cached'],
    })
    client.eval.mockResolvedValueOnce(0)
    await expect(refillSessionContextCache(client, {
      tenantId: 'tenant-1', userId: 'user-1', sessionId: 'session-1', revision: 11, value: 'old',
    })).resolves.toBe(false)
    expect(sessionContextCacheKey({ tenantId: 'tenant-1', userId: 'u', sessionId: 's' }))
      .not.toBe(sessionContextCacheKey({ tenantId: 'tenant-2', userId: 'u', sessionId: 's' }))
  })

  it('applies an authoritative snapshot without Kafka metadata', async () => {
    const client = { eval: redisEvalMock() }
    await expect(applySessionContextCacheSnapshot(client, {
      tenantId: 'tenant-1', userId: 'user-1', sessionId: 'session-1', revision: '12',
    })).resolves.toBe(true)
    expect(client.eval.mock.calls[0]?.[1]).toEqual({
      keys: [
        sessionContextCacheWatermarkKey({ tenantId: 'tenant-1', userId: 'user-1', sessionId: 'session-1' }),
        sessionContextCacheKey({ tenantId: 'tenant-1', userId: 'user-1', sessionId: 'session-1' }),
      ],
      arguments: ['12'],
    })
    client.eval.mockResolvedValueOnce(0)
    await expect(applySessionContextCacheSnapshot(client, {
      tenantId: 'tenant-1', userId: 'user-1', sessionId: 'session-1', revision: 11,
    })).resolves.toBe(false)
  })

  it('fails closed when the owned Kafka subscription stops', async () => {
    const setup = await harness()
    setup.stop.mockRejectedValueOnce(new Error('dispose detail must stay private'))
    setup.fail(new Error('broker detail must stay private'))
    await vi.waitFor(() => { expect(setup.error).toHaveBeenCalledTimes(2) })
    expect(setup.stop).toHaveBeenCalledOnce()
    expect(setup.error).toHaveBeenCalledWith(
      'session-cache-invalidation-redis: Kafka subscription stopped unexpectedly',
    )
    expect(setup.error).toHaveBeenCalledWith(
      'session-cache-invalidation-redis: plugin unload failed after Kafka subscription stopped',
    )
    expect(setup.error.mock.calls.flat().join(' ')).not.toMatch(/broker detail|dispose detail/u)
  })

  it('rejects non-canonical revisions', async () => {
    await expect(refillSessionContextCache({ eval: vi.fn() }, {
      tenantId: 't', userId: 'u', sessionId: 's', revision: '01', value: 'old',
    })).rejects.toThrow(/revision/u)
    await expect(refillSessionContextCache({ eval: vi.fn() }, {
      tenantId: 't', userId: 'u', sessionId: 's', revision: Number.MAX_SAFE_INTEGER + 1, value: 'old',
    })).rejects.toThrow(/revision/u)
  })
})
