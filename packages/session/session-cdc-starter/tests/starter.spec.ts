import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { encodeCdcEvent, encodeKey, type CdcEvent } from '@deepseek-ai/dsh-cdc-protocol'
import {
  KafkaTopic,
  type KafkaConsumedMessage,
  type KafkaSubscribeRequest,
  type KafkaSubscription,
} from '@deepseek-ai/dsh-kafka'
import type { SessionProjectionRecord } from '@deepseek-ai/dsh-session-projection-reconciler'
import Starter, { type Config } from '../src/index.ts'

const CONFIG: Config = {
  route: { topic: 'cdc.session-messages', database: 'app', table: 'session_messages', maxBytes: 8192 },
  redis: {
    groupId: 'session-cache', subscriptionId: 'session-cache-redis', fallbackMode: 'fail',
    schemaFingerprint: 'schema-a',
  },
  elasticsearch: {
    groupId: 'session-search', subscriptionId: 'session-search-es', fallbackMode: 'fail',
    schemaFingerprints: ['schema-a'], index: 'session-search-v1',
  },
  monitorIntervalMs: 5,
}

const row = {
  tenant_id: 'tenant-1', user_id: 'user-1', session_id: 'session-1', message_id: 'message-1',
  revision: 12, status: 'completed', visibility: 'user', role: 'assistant', visible_text: 'hello',
  occurred_at: '2026-08-23T00:00:00.000Z',
}

function event(overrides: Partial<CdcEvent> = {}): CdcEvent {
  return {
    specVersion: 1,
    eventId: 'event-1',
    operation: 'insert',
    occurredAt: '2026-08-23T00:00:01.000Z',
    source: { database: CONFIG.route.database, table: CONFIG.route.table, file: 'mysql-bin.000001', position: 1 },
    key: {
      tenant_id: row.tenant_id,
      user_id: row.user_id,
      session_id: row.session_id,
      message_id: row.message_id,
    },
    before: null,
    after: row,
    changedColumns: Object.keys(row),
    schemaFingerprint: 'schema-a',
    ...overrides,
  }
}

function message(source: CdcEvent): KafkaConsumedMessage {
  return {
    topic: KafkaTopic(CONFIG.route.topic),
    partition: 0,
    offset: 1n,
    timestamp: 1n,
    key: encodeKey(source.key),
    value: Buffer.from(encodeCdcEvent(source)),
    headers: [],
  }
}

class FakeKafka {
  readonly requests = new Map<string, KafkaSubscribeRequest>()
  readonly closed: string[] = []
  private readonly completions = new Map<string, ReturnType<typeof Promise.withResolvers<undefined>>>()

  async subscribe(request: KafkaSubscribeRequest): Promise<KafkaSubscription> {
    this.requests.set(request.id, request)
    const completion = Promise.withResolvers<undefined>()
    this.completions.set(request.id, completion)
    return {
      id: request.id,
      done: completion.promise,
      close: async () => {
        if (!this.closed.includes(request.id)) this.closed.push(request.id)
        completion.resolve(undefined)
      },
    }
  }

  async deliver(subscriptionId: string, source: CdcEvent): Promise<void> {
    const request = this.requests.get(subscriptionId)
    if (request === undefined) throw new Error('missing subscription')
    try {
      await request.handle(message(source))
    } catch (cause) {
      this.completions.get(subscriptionId)?.reject(cause)
      throw cause
    }
  }
}

class FakeRedis {
  readonly calls: Array<{ keys: string[]; arguments: string[] }> = []
  private readonly revisions = new Map<string, bigint>()

  async withClient<T>(callback: (client: { eval: FakeRedis['eval'] }) => T | Promise<T>): Promise<T> {
    return callback({ eval: this.eval.bind(this) })
  }

  async eval(_script: string, options: { keys: string[]; arguments: string[] }): Promise<number> {
    this.calls.push(options)
    const key = options.keys[0] ?? ''
    const incoming = BigInt(options.arguments[0] ?? '0')
    const current = this.revisions.get(key)
    if (current !== undefined && current >= incoming) return 0
    this.revisions.set(key, incoming)
    return 1
  }
}

const MAPPING = {
  tenant: { type: 'keyword' }, user: { type: 'keyword' }, session: { type: 'keyword' },
  message: { type: 'keyword' }, status: { type: 'keyword' }, visibility: { type: 'keyword' },
  role: { type: 'keyword' }, content: { type: 'text' }, source_time: { type: 'date' },
  revision: { type: 'long' }, deleted: { type: 'boolean' },
}

class FakeElasticsearch {
  readonly writes: Array<Record<string, unknown>> = []
  async operation<T>(callback: (client: unknown) => T | Promise<T>): Promise<T> {
    return callback({
      indices: { getMapping: async () => ({ [CONFIG.elasticsearch.index]: { mappings: { properties: MAPPING } } }) },
      index: async (request: Record<string, unknown>) => { this.writes.push(request) },
    })
  }
}

const contexts: Context[] = []
afterEach(async () => Promise.allSettled(contexts.splice(0).map(async context => context.fiber.dispose())))

async function boot(config: Config = CONFIG): Promise<{
  ctx: Context
  kafka: FakeKafka
  redis: FakeRedis
  elasticsearch: FakeElasticsearch
  fiber: Awaited<ReturnType<Context['plugin']>>
}> {
  const ctx = new Context()
  contexts.push(ctx)
  const kafka = new FakeKafka()
  const redis = new FakeRedis()
  const elasticsearch = new FakeElasticsearch()
  ctx.provide('kafka', kafka)
  ctx.provide('redis', redis)
  ctx.provide('elasticsearch', elasticsearch)
  const fiber = await ctx.plugin(Starter, config)
  return { ctx, kafka, redis, elasticsearch, fiber }
}

describe('session CDC starter', () => {
  it.each([
    ['consumer group', { ...CONFIG, elasticsearch: { ...CONFIG.elasticsearch, groupId: CONFIG.redis.groupId } }],
    ['subscription id', { ...CONFIG, elasticsearch: { ...CONFIG.elasticsearch, subscriptionId: CONFIG.redis.subscriptionId } }],
    ['empty fingerprints', { ...CONFIG, elasticsearch: { ...CONFIG.elasticsearch, schemaFingerprints: [] } }],
    ['duplicate fingerprints', { ...CONFIG, elasticsearch: { ...CONFIG.elasticsearch, schemaFingerprints: ['schema-a', 'schema-a'] } }],
    ['fingerprint subset', { ...CONFIG, redis: { ...CONFIG.redis, schemaFingerprint: 'schema-b' } }],
  ])('rejects invalid %s before creating subscriptions', async (_name, config) => {
    const ctx = new Context()
    contexts.push(ctx)
    const kafka = new FakeKafka()
    ctx.provide('kafka', kafka)
    ctx.provide('redis', new FakeRedis())
    ctx.provide('elasticsearch', new FakeElasticsearch())
    await expect(ctx.plugin(Starter, config)).rejects.toThrow(/session-cdc-starter/u)
    expect(kafka.requests.size).toBe(0)
  })

  it('starts independent groups, sends one encoded event to both projections, and drains both', async () => {
    const setup = await boot()
    expect([...setup.kafka.requests.values()].map(request => request.groupId).sort()).toEqual([
      CONFIG.redis.groupId,
      CONFIG.elasticsearch.groupId,
    ].sort())
    const source = event()
    await setup.kafka.deliver(CONFIG.elasticsearch.subscriptionId, source)
    await setup.kafka.deliver(CONFIG.redis.subscriptionId, source)
    expect(setup.elasticsearch.writes).toHaveLength(1)
    expect(setup.redis.calls).toHaveLength(1)
    expect(setup.ctx.sessionCdcStarter.health()).toMatchObject({
      status: 'running',
      redis: { status: 'running', handled: 1 },
      elasticsearch: { status: 'running', handled: 1 },
    })
    await setup.fiber.dispose()
    expect(setup.kafka.closed.sort()).toEqual([
      CONFIG.redis.subscriptionId,
      CONFIG.elasticsearch.subscriptionId,
    ].sort())
  })

  it('fails startup and rolls back Elasticsearch when Redis subscription creation fails', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const kafka = new FakeKafka()
    const original = kafka.subscribe.bind(kafka)
    kafka.subscribe = async (request) => {
      if (request.id === CONFIG.redis.subscriptionId) throw new Error('Redis consumer unavailable')
      return original(request)
    }
    ctx.provide('kafka', kafka)
    ctx.provide('redis', new FakeRedis())
    ctx.provide('elasticsearch', new FakeElasticsearch())
    await expect(ctx.plugin(Starter, CONFIG)).rejects.toThrow(/Redis consumer unavailable/u)
    expect(kafka.closed).toContain(CONFIG.elasticsearch.subscriptionId)
  })

  it('fail-stops and reports no payload when a poison event stops one subscription', async () => {
    const setup = await boot()
    const starter = setup.ctx.sessionCdcStarter
    const poison = event({ schemaFingerprint: 'wrong-secret-value' })
    await expect(setup.kafka.deliver(CONFIG.redis.subscriptionId, poison)).rejects.toThrow()
    await vi.waitFor(() => { expect(setup.kafka.closed).toContain(CONFIG.elasticsearch.subscriptionId) })
    expect(JSON.stringify(starter.health())).not.toContain('wrong-secret-value')
  })

  it('registers Redis and Elasticsearch reconciler sinks while the application owns the source', async () => {
    const setup = await boot({ ...CONFIG, reconciler: { maxBatchSize: 10 } })
    const record: SessionProjectionRecord = {
      tenantId: 'tenant-1', userId: 'user-1', sessionId: 'session-1', messageId: 'message-1',
      revision: 20, status: 'completed', visibility: 'user', role: 'assistant', visibleText: 'snapshot',
      occurredAt: '2026-08-23T00:00:00.000Z', deleted: false,
    }
    setup.ctx.sessionProjectionReconciler.registerSource({ readPage: async () => ({ records: [record] }) })
    await expect(setup.ctx.sessionProjectionReconciler.reconcile({
      batchSize: 1,
      sinkStrategy: 'sequential',
    })).resolves.toMatchObject({ status: 'completed', processed: 1 })
    expect(setup.redis.calls.at(-1)?.arguments).toEqual(['20'])
    expect(setup.elasticsearch.writes.at(-1)).toMatchObject({ version: 20, version_type: 'external' })

    await setup.ctx.sessionProjectionReconciler.reconcile({ batchSize: 1, sinkStrategy: 'sequential' })
    expect(setup.redis.calls.at(-1)?.arguments).toEqual(['20'])
    expect(setup.ctx.sessionCdcStarter.health()).toMatchObject({ reconciler: { status: 'idle' } })
  })
})
