import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { encodeCdcEvent, encodeKey, type CdcEvent } from '@deepseek-ai/dsh-cdc-protocol'
import { KafkaTopic, type KafkaConsumedMessage } from '@deepseek-ai/dsh-kafka'
import type { KafkaEventConsumerOptions } from '@deepseek-ai/dsh-kafka-events'
import * as Plugin from '../src/index.ts'
import { sessionSearchProjectionDocumentId } from '../src/document.ts'

const CONFIG = {
  topic: 'cdc.session_messages',
  groupId: 'session-search',
  subscriptionId: 'session-search',
  fallbackMode: 'earliest',
  maxBytes: 8192,
  database: 'app',
  table: 'session_messages',
  schemaFingerprints: ['schema-a'],
  index: 'session-search-v1',
} as const

const MAPPING = {
  tenant: { type: 'keyword' }, user: { type: 'keyword' }, session: { type: 'keyword' },
  message: { type: 'keyword' }, status: { type: 'keyword' }, visibility: { type: 'keyword' },
  role: { type: 'keyword' }, content: { type: 'text' }, source_time: { type: 'date' },
  revision: { type: 'long' }, deleted: { type: 'boolean' },
}

function row(revision = 12): Record<string, string | number> {
  return {
    tenant_id: 'tenant-1', user_id: 'user-8', session_id: 'session-100', message_id: 'message-12',
    revision, status: 'completed', visibility: 'user', role: 'user', visible_text: 'hello',
    occurred_at: '2026-08-23T12:00:00.000Z',
  }
}

function event(overrides: Partial<CdcEvent> = {}): CdcEvent {
  return {
    specVersion: 1,
    eventId: 'event-1',
    operation: 'insert',
    occurredAt: '2026-08-23T12:00:01.000Z',
    source: { database: 'app', table: 'session_messages', file: 'mysql-bin.000001', position: 100 },
    key: { message_id: 'message-12' },
    before: null,
    after: row(),
    changedColumns: Object.keys(row()),
    schemaFingerprint: 'schema-a',
    ...overrides,
  }
}

function message(source: CdcEvent): KafkaConsumedMessage {
  return {
    topic: KafkaTopic(CONFIG.topic), partition: 0, offset: 1n, timestamp: 1n,
    key: encodeKey(source.key), value: encodeCdcEvent(source), headers: [],
  }
}

class FakeKafkaEvents {
  options?: KafkaEventConsumerOptions<CdcEvent>
  closed = false
  readonly completion = Promise.withResolvers<undefined>()
  async subscribe<T>(options: KafkaEventConsumerOptions<T>): Promise<{
    id: typeof options.id
    done: Promise<void>
    close(): Promise<void>
    health(): never
  }> {
    this.options = options as unknown as KafkaEventConsumerOptions<CdcEvent>
    return {
      id: options.id,
      done: this.completion.promise,
      close: async () => { this.closed = true },
      health: () => { throw new Error('unused') },
    }
  }
  fail(cause: unknown): void {
    this.completion.reject(cause)
  }
  async deliver(source: CdcEvent, override?: Partial<KafkaConsumedMessage>): Promise<void> {
    if (this.options === undefined) throw new Error('not subscribed')
    const wire = { ...message(source), ...override }
    const decoded = this.options.codec.decode(wire.value ?? undefined, wire)
    await this.options.handler.handle({ event: decoded, message: wire })
  }
}

class FakeElasticsearch {
  readonly writes: Array<Record<string, unknown>> = []
  conflict = false
  mapping = MAPPING
  async operation<T>(callback: (client: unknown) => T | Promise<T>): Promise<T> {
    return callback({
      indices: { getMapping: async () => ({ [CONFIG.index]: { mappings: { properties: this.mapping } } }) },
      index: async (request: Record<string, unknown>) => {
        if (this.conflict) throw {
          statusCode: 409,
          body: { error: { type: 'version_conflict_engine_exception' } },
        }
        this.writes.push(request)
      },
    })
  }
}

const contexts: Context[] = []
afterEach(async () => Promise.allSettled(contexts.splice(0).map(async ctx => ctx.fiber.dispose())))

async function boot(): Promise<{ kafka: FakeKafkaEvents; elasticsearch: FakeElasticsearch; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const ctx = new Context()
  contexts.push(ctx)
  const kafka = new FakeKafkaEvents()
  const elasticsearch = new FakeElasticsearch()
  ctx.provide('kafkaEvents', kafka)
  ctx.provide('elasticsearch', elasticsearch)
  const fiber = await ctx.plugin(Plugin, CONFIG)
  return { kafka, elasticsearch, fiber }
}

describe('session search CDC projection', () => {
  it('indexes visible rows with tenant identity and authoritative revision', async () => {
    const { kafka, elasticsearch } = await boot()
    await kafka.deliver(event())
    expect(elasticsearch.writes[0]).toEqual({
      index: CONFIG.index,
      id: sessionSearchProjectionDocumentId('tenant-1', 'user-8', 'message-12'),
      version: 12,
      version_type: 'external',
      document: {
        tenant: 'tenant-1', user: 'user-8', session: 'session-100', message: 'message-12',
        status: 'completed', visibility: 'user', role: 'user', content: 'hello',
        source_time: '2026-08-23T12:00:00.000Z', revision: 12, deleted: false,
      },
    })
  })

  it('applies authoritative records without Kafka through the same versioned writer', async () => {
    const elasticsearch = new FakeElasticsearch()
    await Plugin.applySessionSearchProjectionRecord(elasticsearch, CONFIG.index, {
      tenantId: 'tenant-1',
      userId: 'user-8',
      sessionId: 'session-100',
      messageId: 'message-12',
      revision: 15,
      status: 'completed',
      visibility: 'user',
      role: 'assistant',
      visibleText: 'reconciled',
      occurredAt: '2026-08-23T12:00:00.000Z',
      deleted: false,
    })
    expect(elasticsearch.writes[0]).toEqual({
      index: CONFIG.index,
      id: sessionSearchProjectionDocumentId('tenant-1', 'user-8', 'message-12'),
      version: 15,
      version_type: 'external',
      document: {
        tenant: 'tenant-1', user: 'user-8', session: 'session-100', message: 'message-12',
        status: 'completed', visibility: 'user', role: 'assistant', content: 'reconciled',
        source_time: '2026-08-23T12:00:00.000Z', revision: 15, deleted: false,
      },
    })

    elasticsearch.conflict = true
    await expect(Plugin.applySessionSearchProjectionRecord(elasticsearch, CONFIG.index, {
      tenantId: 'tenant-1', userId: 'user-8', sessionId: 'session-100', messageId: 'message-12',
      revision: 14, status: 'completed', visibility: 'user', role: 'assistant',
      visibleText: 'older', occurredAt: '2026-08-23T12:00:00.000Z', deleted: true,
    })).resolves.toBeUndefined()
  })

  it('writes tombstones for deletes and non-visible states', async () => {
    const { kafka, elasticsearch } = await boot()
    const deleted = event({ operation: 'delete', before: row(13), after: null })
    await kafka.deliver(deleted)
    const hiddenRow = { ...row(14), visibility: 'private' }
    await kafka.deliver(event({ operation: 'update', before: row(13), after: hiddenRow, changedColumns: ['visibility', 'revision'] }))
    expect(elasticsearch.writes.map(write => (write.document as { deleted: boolean }).deleted)).toEqual([true, true])
    expect(elasticsearch.writes[1]?.document).not.toHaveProperty('content')
  })

  it('rejects wrong route, fingerprint, Kafka key, and row-image key', async () => {
    const { kafka } = await boot()
    await expect(kafka.deliver(event({ source: { ...event().source, table: 'other' } }))).rejects.toMatchObject({ code: 'invalid-event' })
    await expect(kafka.deliver(event({ schemaFingerprint: 'wrong' }))).rejects.toMatchObject({ code: 'invalid-event' })
    await expect(kafka.deliver(event(), { key: Buffer.from('wrong') })).rejects.toMatchObject({ code: 'invalid-event' })
    await expect(kafka.deliver(event({ key: { message_id: 'other' } }))).rejects.toMatchObject({ code: 'invalid-event' })
  })

  it('skips explicit unrelated updates, processes missing hints, and accepts version conflicts', async () => {
    const { kafka, elasticsearch } = await boot()
    await kafka.deliver(event({ operation: 'update', before: row(), after: { ...row(), usage: 1 }, changedColumns: ['usage'] }))
    expect(elasticsearch.writes).toEqual([])
    await kafka.deliver(event({ operation: 'update', before: row(), after: row(), changedColumns: undefined }))
    expect(elasticsearch.writes).toHaveLength(1)
    elasticsearch.conflict = true
    await expect(kafka.deliver(event())).resolves.toBeUndefined()
  })

  it('validates mapping before subscribing and closes with its plugin scope', async () => {
    const { kafka, fiber } = await boot()
    await fiber.dispose()
    expect(kafka.closed).toBe(true)
  })

  it('fail-stops its plugin scope when the Kafka subscription fails', async () => {
    const { kafka } = await boot()
    kafka.fail(new Error('consumer failed'))
    await vi.waitFor(() => { expect(kafka.closed).toBe(true) })
  })
})
