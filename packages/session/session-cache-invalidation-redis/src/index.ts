/**
 * Host-only Kafka Consumer that deletes one complete session-context Redis key
 * for each validated `session.message.changed` event. Both `upsert` and
 * `delete` invalidate the same key. Cache refill stays with the session read
 * owner.
 * @module @deepseek-ai/dsh-session-cache-invalidation-redis
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  KafkaConsumerGroupId,
  KafkaSubscriptionId,
  KafkaTopic,
  type KafkaConsumedMessage,
  type KafkaSubscriptionMode,
} from '@deepseek-ai/dsh-kafka'
import '@deepseek-ai/dsh-redis'
import {
  decodeSessionMessageChange,
  SessionMessageChangeProtocolError,
  type SessionMessageChangeEvent,
  type SessionMessageChangeUserId,
} from '@deepseek-ai/dsh-session-message-change-protocol'

/** Fixed cache-key kind stored as the first JSON array segment. */
export const SESSION_CONTEXT_CACHE_KEY_KIND = 'dsh.session.context'

/** Fixed cache-key format version stored as the third JSON array segment. */
export const SESSION_CONTEXT_CACHE_KEY_FORMAT_VERSION = 1

/** Inputs required to derive one session-context cache key. */
export interface SessionContextCacheKeyInput {
  /** Configured deployment identity. */
  readonly deploymentId: string
  /** Authoritative private-session owner from the decoded event. */
  readonly userId: SessionMessageChangeUserId
  /** Session whose complete cached context must be removed. */
  readonly sessionId: SessionMessageChangeEvent['sessionId']
}

/**
 * Derive the unambiguous session-context cache key.
 * @param input - Deployment identity plus the decoded user and session ids.
 * @returns Canonical UTF-8 JSON array bytes as a string; equal inputs produce equal keys.
 */
export function sessionContextCacheKey(input: SessionContextCacheKeyInput): string {
  return JSON.stringify([
    SESSION_CONTEXT_CACHE_KEY_KIND,
    input.deploymentId,
    SESSION_CONTEXT_CACHE_KEY_FORMAT_VERSION,
    input.userId,
    input.sessionId,
  ])
}

/** Cordis plugin name. */
export const name = 'session-cache-invalidation-redis'

/** Host Kafka and Redis services required before subscription can start. */
export const inject = ['kafka', 'redis']

/** Explicit Host Consumer configuration with no hidden business defaults. */
export interface Config {
  /** Authorized Kafka topic that carries session message change events. */
  topic: string
  /** Authorized Kafka consumer group for this invalidation Consumer. */
  groupId: string
  /** Subscription identity unique within the Kafka service. */
  subscriptionId: string
  /** Start position used when the group has no committed offset. */
  mode: KafkaSubscriptionMode
  /** Complete-payload byte limit forwarded to `decodeSessionMessageChange`. */
  maxBytes: number
  /** Deployment identity embedded in every cache key. */
  deploymentId: string
}

/** Loader schema; every field is required. */
export const Config: z<Config> = z.object({
  topic: z.string().min(1).required(),
  groupId: z.string().min(1).required(),
  subscriptionId: z.string().min(1).required(),
  mode: z.union([z.const('committed'), z.const('earliest'), z.const('latest')] as const).required(),
  maxBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  deploymentId: z.string().min(1).required(),
})

function logFailure(
  ctx: Context,
  message: KafkaConsumedMessage,
  category: string,
  eventId?: string,
): void {
  const suffix = eventId === undefined ? '' : ` eventId=${eventId}`
  ctx.logger.warn(
    `session-cache-invalidation-redis failed category=${category} topic=${message.topic} partition=${message.partition} offset=${message.offset}${suffix}`,
  )
}

function decodeValue(
  ctx: Context,
  config: Config,
  message: KafkaConsumedMessage,
): SessionMessageChangeEvent {
  try {
    return decodeSessionMessageChange(
      message.value === null ? null : new Uint8Array(message.value),
      { maxBytes: config.maxBytes },
    )
  } catch (error: unknown) {
    if (!(error instanceof SessionMessageChangeProtocolError)) throw error
    logFailure(ctx, message, error.code)
    throw error
  }
}

/**
 * Subscribe to the configured topic and delete one session-context key per record.
 * @param ctx - Host context exposing `kafka` and `redis`.
 * @param config - Explicit topic, group, subscription, mode, payload limit, and deployment identity.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.kafka.subscribe({
    id: KafkaSubscriptionId(config.subscriptionId),
    groupId: KafkaConsumerGroupId(config.groupId),
    topics: [KafkaTopic(config.topic)],
    mode: config.mode,
    async handle(message) {
      const event = decodeValue(ctx, config, message)
      try {
        const key = sessionContextCacheKey({
          deploymentId: config.deploymentId,
          userId: event.userId,
          sessionId: event.sessionId,
        })
        await ctx.redis.withClient(async (client) => {
          await client.del(key)
        })
      } catch (error: unknown) {
        logFailure(ctx, message, 'redis', event.eventId)
        throw error
      }
    },
  })
}
