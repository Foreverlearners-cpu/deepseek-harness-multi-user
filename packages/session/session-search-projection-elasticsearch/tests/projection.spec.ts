import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionMessageChangeUserId } from '@deepseek-ai/dsh-session-message-change-protocol'
import * as SessionSearchProjection from '../src/index.ts'
import {
  changeEvent,
  completeMessage,
  documentId,
  FakeElasticsearch,
  FakeKafka,
  FakeSource,
  INDEX,
  kafkaMessage,
  MATCHING_MAPPING,
  PLUGIN_CONFIG,
} from './harness.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
})

async function boot(options?: {
  kafka?: FakeKafka
  elasticsearch?: FakeElasticsearch
  source?: FakeSource
}): Promise<{
  ctx: Context
  fiber: Awaited<ReturnType<Context['plugin']>>
  kafka: FakeKafka
  elasticsearch: FakeElasticsearch
  source: FakeSource
  logs: string[]
}> {
  const kafka = options?.kafka ?? new FakeKafka()
  const elasticsearch = options?.elasticsearch ?? new FakeElasticsearch()
  const source = options?.source ?? new FakeSource()
  const logs: string[] = []
  const ctx = new Context()
  contexts.push(ctx)
  ctx.logger.warn = ((message: unknown) => { logs.push(String(message)) }) as typeof ctx.logger.warn
  ctx.logger.error = ((message: unknown) => { logs.push(String(message)) }) as typeof ctx.logger.error
  ctx.provide('kafka', kafka)
  ctx.provide('elasticsearch', elasticsearch)
  ctx.provide('sessionCompleteMessageQuery', source)
  const fiber = await ctx.plugin(SessionSearchProjection, PLUGIN_CONFIG)
  return { ctx, fiber, kafka, elasticsearch, source, logs }
}

describe('session search projection Elasticsearch Consumer', () => {
  it('keeps the function-plugin namespace free of a default export', () => {
    expect('default' in SessionSearchProjection).toBe(false)
  })

  it('indexes one upsert from the authoritative complete message', async () => {
    const { kafka, elasticsearch, source } = await boot()
    const event = changeEvent()

    await kafka.deliver(kafkaMessage(event))

    expect(source.reads).toEqual([{ sessionId: event.sessionId, sourceSeq: 12 }])
    expect(elasticsearch.writes).toHaveLength(1)
    expect(elasticsearch.writes[0]).toEqual({
      index: INDEX,
      id: documentId('user-8', 'message-12'),
      version: 13,
      version_type: 'external',
      document: {
        user: 'user-8',
        session: 'session-100',
        message: 'message-12',
        role: 'user',
        content: 'hello from the source',
        source_time: '2026-08-19T13:48:00.000Z',
        source_seq: 12,
        deleted: false,
      },
    })
    expect(kafka.committed).toBe(1)
  })

  it('writes a delete tombstone without reading the source', async () => {
    const { kafka, elasticsearch, source } = await boot()
    const event = changeEvent({ operation: 'delete', sourceSeq: 20 })

    await kafka.deliver(kafkaMessage(event))

    expect(source.reads).toEqual([])
    expect(elasticsearch.writes[0]).toEqual({
      index: INDEX,
      id: documentId('user-8', 'message-12'),
      version: 21,
      version_type: 'external',
      document: {
        user: 'user-8',
        session: 'session-100',
        message: 'message-12',
        source_time: '2026-08-19T13:49:00.000Z',
        source_seq: 20,
        deleted: true,
      },
    })
    expect(kafka.committed).toBe(1)
  })

  it('treats an equal or lower version conflict as a successful no-op', async () => {
    const { kafka, elasticsearch } = await boot()
    const id = documentId('user-8', 'message-12')
    await kafka.deliver(kafkaMessage(changeEvent({ sourceSeq: 12 })))
    await kafka.deliver(kafkaMessage(changeEvent({
      eventId: changeEvent().eventId,
      sourceSeq: 5,
      occurredAt: '2026-08-19T13:40:00.000Z',
    })))

    expect(kafka.committed).toBe(2)
    expect(elasticsearch.documents.get(id)).toEqual({
      version: 13,
      document: {
        user: 'user-8',
        session: 'session-100',
        message: 'message-12',
        role: 'user',
        content: 'hello from the source',
        source_time: '2026-08-19T13:48:00.000Z',
        source_seq: 12,
        deleted: false,
      },
    })
  })

  it('treats a repeated upsert as success without resurrecting newer state', async () => {
    const { kafka, elasticsearch } = await boot()
    await kafka.deliver(kafkaMessage(changeEvent({ sourceSeq: 12 })))
    await kafka.deliver(kafkaMessage(changeEvent({ sourceSeq: 12 })))

    expect(kafka.committed).toBe(2)
    expect(elasticsearch.writes).toHaveLength(2)
    expect(elasticsearch.documents.get(documentId('user-8', 'message-12'))?.version).toBe(13)
  })

  it('does not commit an invalid Kafka value', async () => {
    const { kafka, elasticsearch, source } = await boot()
    const message = kafkaMessage()
    message.value = Buffer.from('{')

    await expect(kafka.deliver(message)).rejects.toMatchObject({ code: 'invalid-json' })
    expect(source.reads).toEqual([])
    expect(elasticsearch.writes).toEqual([])
    expect(kafka.committed).toBe(0)
  })

  it('does not commit a null Kafka value', async () => {
    const { kafka, elasticsearch, source } = await boot()
    const message = kafkaMessage()
    message.value = null

    await expect(kafka.deliver(message)).rejects.toMatchObject({ code: 'invalid-event' })
    expect(source.reads).toEqual([])
    expect(elasticsearch.writes).toEqual([])
    expect(kafka.committed).toBe(0)
  })

  it('does not commit when the source query fails', async () => {
    const source = new FakeSource()
    source.message = new Error('source unavailable')
    const { kafka, elasticsearch } = await boot({ source })

    await expect(kafka.deliver(kafkaMessage())).rejects.toMatchObject({ code: 'query-failed' })
    expect(elasticsearch.writes).toEqual([])
    expect(kafka.committed).toBe(0)
  })

  it('does not commit when source identities do not match the event', async () => {
    const source = new FakeSource()
    source.message = completeMessage({
      userId: SessionMessageChangeUserId('other-user'),
      messageId: MessageId('other-message'),
    })
    const { kafka, elasticsearch, logs } = await boot({ source })

    await expect(kafka.deliver(kafkaMessage())).rejects.toMatchObject({ code: 'identity-mismatch' })
    expect(elasticsearch.writes).toEqual([])
    expect(kafka.committed).toBe(0)
    expect(logs.join('\n')).not.toMatch(/user-8|other-user|message-12|hello from the source/)
  })

  it('does not commit when Elasticsearch write fails for a reason other than version conflict', async () => {
    const elasticsearch = new FakeElasticsearch()
    elasticsearch.failNextWrite = new Error('cluster unavailable')
    const { kafka } = await boot({ elasticsearch })

    await expect(kafka.deliver(kafkaMessage())).rejects.toMatchObject({ code: 'elasticsearch-failed' })
    expect(kafka.committed).toBe(0)
  })

  it('treats a 409 version-conflict body on meta as a successful no-op', async () => {
    const elasticsearch = new FakeElasticsearch()
    const { kafka } = await boot({ elasticsearch })
    await kafka.deliver(kafkaMessage(changeEvent({ sourceSeq: 12 })))
    elasticsearch.failNextWrite = {
      meta: {
        statusCode: 409,
        body: { error: { type: 'version_conflict_engine_exception' } },
      },
    }
    await kafka.deliver(kafkaMessage(changeEvent({ sourceSeq: 12 })))
    expect(kafka.committed).toBe(2)
  })

  it('treats a 409 version-conflict body on the error as a successful no-op', async () => {
    const elasticsearch = new FakeElasticsearch()
    const { kafka } = await boot({ elasticsearch })
    elasticsearch.failNextWrite = {
      statusCode: 409,
      body: { error: { type: 'version_conflict_engine_exception' } },
    }
    await kafka.deliver(kafkaMessage())
    expect(kafka.committed).toBe(1)
    expect(elasticsearch.documents.size).toBe(0)
  })

  it('falls back to the error body when meta.body is not a record', async () => {
    const elasticsearch = new FakeElasticsearch()
    const { kafka } = await boot({ elasticsearch })
    elasticsearch.failNextWrite = {
      statusCode: 409,
      meta: { statusCode: 409, body: 1 },
      body: { error: { type: 'version_conflict_engine_exception' } },
    }
    await kafka.deliver(kafkaMessage())
    expect(kafka.committed).toBe(1)
  })

  it('does not treat a non-version 409 as success', async () => {
    const elasticsearch = new FakeElasticsearch()
    elasticsearch.failNextWrite = {
      statusCode: 409,
      meta: { statusCode: 409, body: { error: { type: 'document_missing_exception' } } },
    }
    const { kafka } = await boot({ elasticsearch })
    await expect(kafka.deliver(kafkaMessage())).rejects.toMatchObject({ code: 'elasticsearch-failed' })
    expect(kafka.committed).toBe(0)
  })

  it.each([
    ['a non-object throw', null],
    ['a 409 without a body', { statusCode: 409 }],
    ['a 409 whose meta status is not a number', { meta: { statusCode: '409' } }],
    ['a 409 whose meta body is not an object', { statusCode: 409, meta: { statusCode: 409, body: 1 } }],
    ['a 409 whose error body is not an object', { statusCode: 409, body: { error: 1 } }],
    ['a 409 whose conflict type is not a string', { statusCode: 409, body: { error: { type: 1 } } }],
  ])('does not treat %s as a version-conflict success', async (_label, failNextWrite) => {
    const elasticsearch = new FakeElasticsearch()
    elasticsearch.failNextWrite = failNextWrite
    const { kafka } = await boot({ elasticsearch })
    await expect(kafka.deliver(kafkaMessage())).rejects.toMatchObject({ code: 'elasticsearch-failed' })
    expect(kafka.committed).toBe(0)
  })

  it('logs an unknown handler failure without protected values', async () => {
    const { kafka, logs } = await boot()
    const message = kafkaMessage()
    message.value = new Proxy(new Uint8Array(), {
      get() {
        throw new Error('decoder boom')
      },
    }) as Buffer
    await expect(kafka.deliver(message)).rejects.toThrow('decoder boom')
    expect(logs.join('\n')).toContain('handler failed: unknown')
    expect(logs.join('\n')).not.toMatch(/user-8|hello from the source/)
  })

  it('refuses activation when the index mapping does not match', async () => {
    const kafka = new FakeKafka()
    const elasticsearch = new FakeElasticsearch()
    elasticsearch.mapping = { ...MATCHING_MAPPING, content: { type: 'keyword' } }
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('kafka', kafka)
    ctx.provide('elasticsearch', elasticsearch)
    ctx.provide('sessionCompleteMessageQuery', new FakeSource())

    await expect(ctx.plugin(SessionSearchProjection, PLUGIN_CONFIG))
      .rejects.toMatchObject({ code: 'mapping-mismatch' })
    expect(kafka.request).toBeUndefined()
  })

  it.each([
    ['getMapping throws', (elasticsearch: FakeElasticsearch) => {
      elasticsearch.mappingError = new Error('index missing')
    }],
    ['getMapping returns a non-object', (elasticsearch: FakeElasticsearch) => {
      elasticsearch.mappingResponse = 5
    }],
    ['getMapping returns no indexes', (elasticsearch: FakeElasticsearch) => {
      elasticsearch.mappingResponse = {}
    }],
    ['an index entry is not a mapping object', (elasticsearch: FakeElasticsearch) => {
      elasticsearch.mappingResponse = { [INDEX]: 1 }
    }],
    ['mappings is missing', (elasticsearch: FakeElasticsearch) => {
      elasticsearch.mappingResponse = { [INDEX]: {} }
    }],
    ['mappings is not an object', (elasticsearch: FakeElasticsearch) => {
      elasticsearch.mappingResponse = { [INDEX]: { mappings: 1 } }
    }],
    ['properties is missing', (elasticsearch: FakeElasticsearch) => {
      elasticsearch.mappingResponse = { [INDEX]: { mappings: {} } }
    }],
    ['properties is not an object', (elasticsearch: FakeElasticsearch) => {
      elasticsearch.mappingResponse = { [INDEX]: { mappings: { properties: 1 } } }
    }],
    ['a required field type is not a string', (elasticsearch: FakeElasticsearch) => {
      elasticsearch.mapping = { ...MATCHING_MAPPING, content: { type: 1 } }
    }],
  ])('refuses activation when %s', async (_label, setup) => {
    const kafka = new FakeKafka()
    const elasticsearch = new FakeElasticsearch()
    setup(elasticsearch)
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('kafka', kafka)
    ctx.provide('elasticsearch', elasticsearch)
    ctx.provide('sessionCompleteMessageQuery', new FakeSource())

    await expect(ctx.plugin(SessionSearchProjection, PLUGIN_CONFIG))
      .rejects.toMatchObject({ code: 'mapping-mismatch' })
    expect(kafka.request).toBeUndefined()
  })

  it('allows extra mapping fields and subscribes before handling records', async () => {
    const elasticsearch = new FakeElasticsearch()
    elasticsearch.mapping = { ...MATCHING_MAPPING, extra: { type: 'keyword' } }
    const { kafka } = await boot({ elasticsearch })

    expect(kafka.request).toMatchObject({
      id: 'session-search-projection',
      groupId: PLUGIN_CONFIG.groupId,
      topics: [PLUGIN_CONFIG.topic],
      mode: 'earliest',
    })
  })

  it('stops polling, waits for the active write, then closes the subscription', async () => {
    const elasticsearch = new FakeElasticsearch()
    const gate = Promise.withResolvers<undefined>()
    elasticsearch.indexGate = gate.promise
    const { kafka, fiber } = await boot({ elasticsearch })
    const delivered = kafka.deliver(kafkaMessage())
    await elasticsearch.indexStarted.promise

    const disposing = fiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(kafka.closed).toBe(false)
    expect(kafka.committed).toBe(0)

    gate.resolve(undefined)
    await disposing
    await delivered
    expect(kafka.closed).toBe(true)
    expect(kafka.committed).toBe(1)
  })

  it('does not use Kafka payload text as document content', async () => {
    const { kafka, elasticsearch } = await boot()
    await kafka.deliver(kafkaMessage(changeEvent({
      sessionId: SessionId('session-100'),
    })))
    expect(JSON.stringify(elasticsearch.writes[0]?.document)).not.toContain('evt-9001')
    expect(elasticsearch.writes[0]?.document.content).toBe('hello from the source')
  })
})
