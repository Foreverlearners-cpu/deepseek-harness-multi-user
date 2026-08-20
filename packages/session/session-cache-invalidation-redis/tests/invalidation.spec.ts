import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  KafkaConsumerGroupId,
  KafkaSubscriptionId,
  KafkaTopic,
  type KafkaConsumedMessage,
} from '@deepseek-ai/dsh-kafka'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as SessionMessageChangeProtocol from '@deepseek-ai/dsh-session-message-change-protocol'
import {
  encodeSessionMessageChange,
  SESSION_MESSAGE_CHANGE_EVENT_TYPE,
  SESSION_MESSAGE_CHANGE_SCHEMA_VERSION,
  SessionMessageChangeEventId,
  SessionMessageChangeProtocolError,
  SessionMessageChangeUserId,
  type SessionMessageChangeEvent,
} from '@deepseek-ai/dsh-session-message-change-protocol'
import * as SessionCacheInvalidationRedis from '../src/index.ts'
import { sessionContextCacheKey } from '../src/index.ts'
import { FakeKafka, FakeRedis } from './fakes.ts'

const CONFIG = {
  topic: 'dsh.session.message-changes',
  groupId: 'dsh-session-context-cache',
  subscriptionId: 'session-context-cache',
  mode: 'committed',
  maxBytes: 4096,
  deploymentId: 'deploy-a',
} as const

const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
})

function event(overrides: Partial<SessionMessageChangeEvent> = {}): SessionMessageChangeEvent {
  return {
    schemaVersion: SESSION_MESSAGE_CHANGE_SCHEMA_VERSION,
    eventId: SessionMessageChangeEventId('evt-9001'),
    eventType: SESSION_MESSAGE_CHANGE_EVENT_TYPE,
    userId: SessionMessageChangeUserId('user-8'),
    sessionId: SessionId('session-100'),
    messageId: MessageId('message-12'),
    operation: 'upsert',
    sourceSeq: 12,
    occurredAt: '2026-08-19T13:49:00.000Z',
    ...overrides,
  }
}

function record(value: Uint8Array | null, offset = 9n): KafkaConsumedMessage {
  return {
    topic: KafkaTopic(CONFIG.topic),
    partition: 2,
    offset,
    timestamp: 100n,
    key: null,
    value: value === null ? null : Buffer.from(value),
    headers: [],
  }
}

async function boot(): Promise<{ ctx: Context; kafka: FakeKafka; redis: FakeRedis }> {
  const ctx = new Context()
  contexts.push(ctx)
  const kafka = await ctx.plugin(FakeKafka)
  const redis = await ctx.plugin(FakeRedis)
  await ctx.plugin(SessionCacheInvalidationRedis, CONFIG)
  return { ctx, kafka: kafka.ctx.kafka as unknown as FakeKafka, redis: redis.ctx.redis as unknown as FakeRedis }
}

describe('session cache invalidation', () => {
  it.each(['upsert', 'delete'] as const)('deletes the complete context key for %s', async (operation) => {
    const { kafka, redis } = await boot()
    const source = event({ operation })
    const key = sessionContextCacheKey({
      deploymentId: CONFIG.deploymentId,
      userId: source.userId,
      sessionId: source.sessionId,
    })
    redis.keys.add(key)

    await kafka.deliver(record(encodeSessionMessageChange(source, { maxBytes: CONFIG.maxBytes })))

    expect(redis.deleted).toEqual([key])
    expect(redis.keys.has(key)).toBe(false)
    expect(kafka.committed).toEqual([{ topic: CONFIG.topic, partition: 2, offset: 9n }])
  })

  it('treats a missing key as success and repeats deletion without error', async () => {
    const { kafka, redis } = await boot()
    const encoded = encodeSessionMessageChange(event(), { maxBytes: CONFIG.maxBytes })

    await kafka.deliver(record(encoded, 9n))
    await kafka.deliver(record(encoded, 10n))

    const key = sessionContextCacheKey({
      deploymentId: CONFIG.deploymentId,
      userId: SessionMessageChangeUserId('user-8'),
      sessionId: SessionId('session-100'),
    })
    expect(redis.deleted).toEqual([key, key])
    expect(kafka.committed).toEqual([
      { topic: CONFIG.topic, partition: 2, offset: 9n },
      { topic: CONFIG.topic, partition: 2, offset: 10n },
    ])
  })

  it('does not commit or delete when decode fails', async () => {
    const { ctx, kafka, redis } = await boot()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    await expect(kafka.deliver(record(new TextEncoder().encode('{"no":"schema"}')))).rejects.toBeInstanceOf(
      SessionMessageChangeProtocolError,
    )

    expect(redis.deleted).toEqual([])
    expect(kafka.committed).toEqual([])
    expect(warn.mock.calls.map(call => String(call[0])).join('\n')).toMatch(
      /category=invalid-event topic=dsh\.session\.message-changes partition=2 offset=9/,
    )
    expect(warn.mock.calls.map(call => String(call[0])).join('\n')).not.toMatch(/user-8|session-100/)
  })

  it('does not commit when the Kafka value is null', async () => {
    const { ctx, kafka, redis } = await boot()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    await expect(kafka.deliver(record(null))).rejects.toBeInstanceOf(SessionMessageChangeProtocolError)

    expect(redis.deleted).toEqual([])
    expect(kafka.committed).toEqual([])
    expect(warn.mock.calls.map(call => String(call[0])).join('\n')).toMatch(
      /category=invalid-event topic=dsh\.session\.message-changes partition=2 offset=9/,
    )
  })

  it('rethrows an unexpected decode error without committing or logging identifiers', async () => {
    const decode = vi.spyOn(SessionMessageChangeProtocol, 'decodeSessionMessageChange')
      .mockImplementation(() => {
        throw new Error('unexpected decoder failure')
      })
    try {
      const { ctx, kafka, redis } = await boot()
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

      await expect(kafka.deliver(record(new TextEncoder().encode('{"no":"schema"}'))))
        .rejects.toThrow(/unexpected decoder failure/)

      expect(redis.deleted).toEqual([])
      expect(kafka.committed).toEqual([])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      decode.mockRestore()
    }
  })

  it('does not commit when Redis deletion fails', async () => {
    const { ctx, kafka, redis } = await boot()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    redis.failNext = true

    await expect(kafka.deliver(record(encodeSessionMessageChange(event(), { maxBytes: CONFIG.maxBytes }))))
      .rejects.toThrow(/redis command failed/)

    expect(redis.deleted).toEqual([])
    expect(kafka.committed).toEqual([])
    const logged = warn.mock.calls.map(call => String(call[0])).join('\n')
    expect(logged).toMatch(/category=redis topic=dsh\.session\.message-changes partition=2 offset=9 eventId=evt-9001/)
    expect(logged).not.toMatch(/user-8|session-100|dsh\.session\.context/)
  })

  it('removes the subscription when the plugin fiber disposes', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(FakeKafka)
    await ctx.plugin(FakeRedis)
    const fiber = await ctx.plugin(SessionCacheInvalidationRedis, CONFIG)
    const kafka = ctx.kafka as unknown as FakeKafka

    expect(kafka.subscriptions.has(KafkaSubscriptionId(CONFIG.subscriptionId))).toBe(true)
    expect([...kafka.subscriptions.values()][0]).toMatchObject({
      groupId: KafkaConsumerGroupId(CONFIG.groupId),
      topics: [KafkaTopic(CONFIG.topic)],
      mode: CONFIG.mode,
    })

    await fiber.dispose()
    expect(kafka.subscriptions.size).toBe(0)
  })

  it('waits for an in-flight DEL before removing the subscription', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(FakeKafka)
    await ctx.plugin(FakeRedis)
    const fiber = await ctx.plugin(SessionCacheInvalidationRedis, CONFIG)
    const kafka = ctx.kafka as unknown as FakeKafka
    const redis = ctx.redis as unknown as FakeRedis

    let release!: () => void
    redis.delayDel = new Promise((resolve) => { release = resolve })
    let started = false
    redis.onDelStart = () => { started = true }

    const delivery = kafka.deliver(record(encodeSessionMessageChange(event(), { maxBytes: CONFIG.maxBytes })))
    await vi.waitFor(() => { expect(started).toBe(true) })

    const disposing = fiber.dispose()
    expect(kafka.subscriptions.size).toBe(1)

    release()
    await Promise.all([delivery, disposing])
    expect(kafka.subscriptions.size).toBe(0)
    expect(kafka.committed).toHaveLength(1)
  })

  it('keeps the function-plugin namespace free of a default export', () => {
    expect('default' in SessionCacheInvalidationRedis).toBe(false)
  })
})
