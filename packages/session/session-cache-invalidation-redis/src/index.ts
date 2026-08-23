/**
 * Tenant-isolated session cache invalidation from validated CDC events.
 * @module @deepseek-ai/dsh-session-cache-invalidation-redis
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  decodeCdcEvent,
  encodeCdcEvent,
  encodeKey,
  type CdcEvent,
  type CdcValue,
} from '@deepseek-ai/dsh-cdc-protocol'
import type { EventCodec, EventDelivery } from '@deepseek-ai/dsh-kafka-events'
import {
  KafkaConsumerGroupId,
  KafkaSubscriptionId,
  KafkaTopic,
  type KafkaConsumedMessage,
} from '@deepseek-ai/dsh-kafka'
import '@deepseek-ai/dsh-redis'
import z from '@deepseek-ai/schemastery'

/** Fixed session-context cache-key kind. */
export const SESSION_CONTEXT_CACHE_KEY_KIND = 'dsh.session.context'
/** Fixed cache-key format version. */
export const SESSION_CONTEXT_CACHE_KEY_FORMAT_VERSION = 2
/** Columns whose update can change a cached session context. */
export const SESSION_CACHE_WATCHED_COLUMNS = new Set([
  'status', 'visibility', 'role', 'visible_text', 'occurred_at',
])

const ROW_FIELDS = new Set([
  'tenant_id', 'user_id', 'session_id', 'message_id', 'revision',
  'status', 'visibility', 'role', 'visible_text', 'occurred_at',
])
const KEY_FIELDS = ['tenant_id', 'user_id', 'session_id', 'message_id'] as const

const INVALIDATE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
local incoming = ARGV[1]
local newer = (not current) or (#incoming > #current) or (#incoming == #current and incoming > current)
if not newer then return 0 end
redis.call('SET', KEYS[1], incoming)
redis.call('DEL', KEYS[2])
return 1
`

const REFILL_SCRIPT = `
local watermark = redis.call('GET', KEYS[1])
local candidate = ARGV[1]
local stale = watermark and ((#candidate < #watermark) or (#candidate == #watermark and candidate < watermark))
if stale then return 0 end
redis.call('SET', KEYS[2], ARGV[2])
return 1
`

/** Identity used by one tenant-isolated session cache entry. */
export interface SessionCacheIdentity {
  /** Tenant that owns the session. */
  tenantId: string
  /** User that owns the session. */
  userId: string
  /** Session being cached. */
  sessionId: string
}

/** Minimal Redis command interface required by the atomic helpers. */
export interface SessionCacheScriptClient {
  /**
   * Evaluate one cache script.
   * @param script - Package-owned Lua source.
   * @param options - Ordered keys and arguments.
   * @returns Redis script result.
   */
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

/** Input for guarded session-context cache refill. */
export interface SessionContextCacheRefill extends SessionCacheIdentity {
  /** Authoritative revision represented by the value. */
  revision: string | number
  /** Serialized cache value. */
  value: string
}

interface SessionMessageRow extends SessionCacheIdentity {
  messageId: string
  revision: string
}

/**
 * Derive the tenant-isolated complete session-context cache key.
 * @param identity - Tenant, user, and session identity.
 * @returns Canonical JSON-array key.
 */
export function sessionContextCacheKey(identity: SessionCacheIdentity): string {
  return JSON.stringify([
    SESSION_CONTEXT_CACHE_KEY_KIND,
    SESSION_CONTEXT_CACHE_KEY_FORMAT_VERSION,
    identity.tenantId,
    identity.userId,
    identity.sessionId,
  ])
}

/**
 * Derive the invalidation watermark key paired with a session cache key.
 * @param identity - Tenant, user, and session identity.
 * @returns Canonical JSON-array watermark key.
 */
export function sessionContextCacheWatermarkKey(identity: SessionCacheIdentity): string {
  return JSON.stringify([
    `${SESSION_CONTEXT_CACHE_KEY_KIND}.watermark`,
    SESSION_CONTEXT_CACHE_KEY_FORMAT_VERSION,
    identity.tenantId,
    identity.userId,
    identity.sessionId,
  ])
}

function canonicalRevision(value: CdcValue | string | number | undefined): string {
  const text = typeof value === 'number' ? String(value) : value
  if (
    typeof text !== 'string' || !/^[1-9][0-9]*$/u.test(text)
    || (typeof value === 'number' && !Number.isSafeInteger(value))
  ) throw new Error('session-cache-invalidation-redis: revision must be a positive canonical integer')
  return text
}

/**
 * Atomically refill a cache only when its authoritative revision is not below the invalidation watermark.
 * @param client - Redis client scoped to the caller's operation.
 * @param refill - Tenant identity, authoritative revision, and serialized value.
 * @returns `true` when Redis accepted the value; `false` when a newer invalidation rejected it.
 */
export async function refillSessionContextCache(
  client: SessionCacheScriptClient,
  refill: SessionContextCacheRefill,
): Promise<boolean> {
  const revision = canonicalRevision(refill.revision)
  const result = await client.eval(REFILL_SCRIPT, {
    keys: [sessionContextCacheWatermarkKey(refill), sessionContextCacheKey(refill)],
    arguments: [revision, refill.value],
  })
  return result === 1
}

function requiredString(row: Record<string, CdcValue>, field: string): string {
  const value = row[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`session-cache-invalidation-redis: invalid ${field}`)
  }
  return value
}

function validateRow(value: Record<string, CdcValue> | null): SessionMessageRow {
  if (value === null || Object.keys(value).length !== ROW_FIELDS.size
    || Object.keys(value).some(field => !ROW_FIELDS.has(field))) {
    throw new Error('session-cache-invalidation-redis: CDC row fields do not match the session message schema')
  }
  const occurredAt = requiredString(value, 'occurred_at')
  const milliseconds = Date.parse(occurredAt)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== occurredAt) {
    throw new Error('session-cache-invalidation-redis: invalid occurred_at')
  }
  if (typeof value.visible_text !== 'string') {
    throw new Error('session-cache-invalidation-redis: invalid visible_text')
  }
  requiredString(value, 'status')
  requiredString(value, 'visibility')
  requiredString(value, 'role')
  return {
    tenantId: requiredString(value, 'tenant_id'),
    userId: requiredString(value, 'user_id'),
    sessionId: requiredString(value, 'session_id'),
    messageId: requiredString(value, 'message_id'),
    revision: canonicalRevision(value.revision),
  }
}

function validateIdentity(message: KafkaConsumedMessage, event: CdcEvent): SessionMessageRow {
  if (message.key === null || !message.key.equals(encodeKey(event.key))) {
    throw new Error('session-cache-invalidation-redis: Kafka key does not match the CDC event key')
  }
  if (Object.keys(event.key).length !== KEY_FIELDS.length
    || KEY_FIELDS.some(field => !Object.hasOwn(event.key, field))) {
    throw new Error('session-cache-invalidation-redis: CDC key fields do not match the session message key')
  }
  const image = event.operation === 'delete' ? event.before : event.after
  const row = validateRow(image)
  for (const candidate of [event.before, event.after]) {
    if (candidate === null) continue
    for (const field of KEY_FIELDS) {
      if (candidate[field] !== event.key[field]) {
        throw new Error('session-cache-invalidation-redis: CDC key does not match a row image')
      }
    }
    validateRow(candidate)
  }
  return row
}

/** Cordis plugin name. */
export const name = 'session-cache-invalidation-redis'
/** Typed Kafka event and Redis services required by this Consumer. */
export const inject = ['kafkaEvents', 'redis']

/** Explicit CDC route and Kafka subscription configuration. */
export interface Config {
  /** Authorized CDC topic. */
  topic: string
  /** Authorized consumer group. */
  groupId: string
  /** Subscription identity unique within `dsh-kafka-events`. */
  subscriptionId: string
  /** Start policy when no committed offset exists. */
  fallbackMode: 'earliest' | 'latest' | 'fail'
  /** Complete CDC payload limit. */
  maxBytes: number
  /** Exact source database. */
  database: string
  /** Exact source table. */
  table: string
  /** Exact accepted source schema fingerprint. */
  schemaFingerprint: string
}

/** Loader schema; every deployment-specific value is required. */
export const Config: z<Config> = z.object({
  topic: z.string().min(1).required(),
  groupId: z.string().min(1).required(),
  subscriptionId: z.string().min(1).required(),
  fallbackMode: z.union([z.const('earliest'), z.const('latest'), z.const('fail')] as const).required(),
  maxBytes: z.natural().min(1).required(),
  database: z.string().min(1).required(),
  table: z.string().min(1).required(),
  schemaFingerprint: z.string().min(1).required(),
})

function codec(config: Config): EventCodec<CdcEvent> {
  return {
    decode(value, message) {
      if (value === undefined) throw new Error('session-cache-invalidation-redis: tombstones are unsupported')
      if (message.topic !== config.topic) throw new Error('session-cache-invalidation-redis: unexpected topic')
      const event = decodeCdcEvent(value, { maxBytes: config.maxBytes })
      if (event.source.database !== config.database || event.source.table !== config.table) {
        throw new Error('session-cache-invalidation-redis: event has no configured table route')
      }
      if (event.schemaFingerprint !== config.schemaFingerprint) {
        throw new Error('session-cache-invalidation-redis: schema fingerprint mismatch')
      }
      validateIdentity(message, event)
      return event
    },
    encode: event => encodeCdcEvent(event, { maxBytes: config.maxBytes }),
  }
}

function shouldInvalidate({ event }: EventDelivery<CdcEvent>): boolean {
  return event.operation !== 'update' || event.changedColumns === undefined
    || event.changedColumns.some(column => SESSION_CACHE_WATCHED_COLUMNS.has(column))
}

/**
 * Subscribe to one CDC route and atomically invalidate stale session caches.
 * @param ctx - Host context carrying typed Kafka events and Redis.
 * @param config - Exact route, schema, payload, and subscription policy.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const subscription = await ctx.kafkaEvents.subscribe({
    id: KafkaSubscriptionId(config.subscriptionId),
    groupId: KafkaConsumerGroupId(config.groupId),
    topics: [KafkaTopic(config.topic)],
    fallbackMode: config.fallbackMode,
    codec: codec(config),
    filter: { accept: shouldInvalidate },
    handler: {
      async handle({ event, message }) {
        const row = validateIdentity(message, event)
        await ctx.redis.withClient(async (client) => {
          await client.eval(INVALIDATE_SCRIPT, {
            keys: [sessionContextCacheWatermarkKey(row), sessionContextCacheKey(row)],
            arguments: [row.revision],
          })
        })
      },
    },
  })
  ctx.effect(() => async () => { await subscription.close() }, 'session-cache-invalidation-redis')
}
