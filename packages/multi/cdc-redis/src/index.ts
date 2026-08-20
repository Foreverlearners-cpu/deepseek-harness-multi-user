/** Kafka CDC projection consumer for Redis. @module @deepseek-ai/dsh-cdc-redis */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import {
  decodeCdcEvent,
  digest,
  encodeKey,
  type CdcEvent,
} from '@deepseek-ai/dsh-cdc'
import type {} from '@deepseek-ai/dsh-redis'
import {
  KafkaConsumerGroupId,
  type KafkaConsumedMessage,
  type KafkaSubscribeRequest,
  type KafkaSubscription,
  type KafkaSubscriptionFallbackMode,
  KafkaSubscriptionId,
  KafkaTopic,
} from '@deepseek-ai/dsh-kafka'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'

const DEFAULT_COMMAND_TIMEOUT_MS = 10_000
const DEFAULT_RETRY_INITIAL_DELAY_MS = 1_000
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000
const MAX_REDIS_TTL_SECONDS = 31_536_000
const VERSION_KEY_SUFFIX = ':__dsh_cdc_version'

const APPLY_IF_CURRENT_SCRIPT = `
local function normalizeDecimal(value)
  local normalized = string.gsub(value, '^0+', '')
  if normalized == '' then return '0' end
  return normalized
end

local function greaterThanOrEqual(left, right)
  left = normalizeDecimal(left)
  right = normalizeDecimal(right)
  if string.len(left) ~= string.len(right) then
    return string.len(left) > string.len(right)
  end
  return left >= right
end

local storedTopic = redis.call('HGET', KEYS[2], 'topic')
if storedTopic then
  local storedPartition = redis.call('HGET', KEYS[2], 'partition')
  if storedTopic ~= ARGV[1] or storedPartition ~= ARGV[2] then return -1 end
  local storedOffset = redis.call('HGET', KEYS[2], 'offset')
  if greaterThanOrEqual(storedOffset, ARGV[3]) then return 0 end
end

redis.call('HSET', KEYS[2], 'topic', ARGV[1], 'partition', ARGV[2], 'offset', ARGV[3])
if ARGV[4] == 'delete' then
  redis.call('DEL', KEYS[1])
elseif ARGV[6] == '0' then
  redis.call('SET', KEYS[1], ARGV[5])
else
  redis.call('SET', KEYS[1], ARGV[5], 'EX', ARGV[6])
end
return 1
`

/** Redis destination for one source table. */
export interface RedisCdcRoute {
  /** Source schema name. */
  database: string
  /** Source table name. */
  table: string
  /** Kafka topic carrying this table. */
  topic: string
  /** Prefix for generated Redis keys. */
  keyPrefix: string
  /** Optional expiry in seconds; zero means no expiry and the maximum is one year. */
  ttlSeconds?: number
  /** UPDATE columns that trigger this projection; empty means every update. */
  watchedColumns?: string[]
}

/** Redis CDC consumer configuration. */
export interface Config {
  /** Unique subscription identity within the Kafka service. */
  subscriptionId: string
  /** Kafka consumer group. */
  consumerGroup: string
  /** Allowed CDC topics. */
  topics: string[]
  /** Start mode when a partition has no committed offset. */
  fallbackMode?: KafkaSubscriptionFallbackMode
  /** Redis command deadline in milliseconds. */
  commandTimeoutMs?: number
  /** First delay after a failed subscription in milliseconds. */
  retryInitialDelayMs?: number
  /** Maximum subscription retry delay in milliseconds. */
  retryMaxDelayMs?: number
  /** Maximum consecutive resubscriptions, or `unlimited`; zero disables retries. */
  maxRetries?: number | 'unlimited'
  /** Source table routes. */
  routes: RedisCdcRoute[]
}

interface ResolvedRoute extends RedisCdcRoute {
  ttlSeconds: number
  watchedColumns: string[]
}

interface ResolvedConfig extends Config {
  fallbackMode: KafkaSubscriptionFallbackMode
  commandTimeoutMs: number
  retryInitialDelayMs: number
  retryMaxDelayMs: number
  maxRetries: number | 'unlimited'
}

/** Cordis plugin name. */
export const name = 'cdc-redis'
/** Infrastructure services required by this consumer. */
export const inject = ['kafka', 'redis']
/** Validated Redis projection configuration. */
export const Config: z<Config> = z.object({
  subscriptionId: z.string().min(1).required(),
  consumerGroup: z.string().min(1).required(),
  topics: z.array(z.string().min(1)).required(),
  fallbackMode: z.union([
    z.const('earliest'), z.const('latest'), z.const('fail'),
  ] as const).default('latest'),
  commandTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_COMMAND_TIMEOUT_MS),
  retryInitialDelayMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_RETRY_INITIAL_DELAY_MS),
  retryMaxDelayMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_RETRY_MAX_DELAY_MS),
  maxRetries: z.union([z.natural(), z.const('unlimited')] as const).default('unlimited'),
  routes: z.array(z.object({
    database: z.string().min(1).required(),
    table: z.string().min(1).required(),
    topic: z.string().min(1).required(),
    keyPrefix: z.string().min(1).required(),
    ttlSeconds: z.natural().max(MAX_REDIS_TTL_SECONDS).default(0),
    watchedColumns: z.array(z.string().min(1)).default([]),
  })).required(),
})

function routeId(database: string, table: string): string {
  return JSON.stringify([database, table])
}

function displayRoute(database: string, table: string): string {
  return `${database}.${table}`
}

function redisKey(route: RedisCdcRoute, database: string, table: string, key: Record<string, unknown>): string {
  return `${route.keyPrefix}:${digest(JSON.stringify({ database, table, key }))}`
}

function isBlank(value: string): boolean {
  return value.trim().length === 0
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function validateMessageIdentity(message: KafkaConsumedMessage, event: CdcEvent): void {
  if (message.key === null || !message.key.equals(encodeKey(event.key))) {
    throw new Error('cdc-redis: Kafka key does not match the CDC event key')
  }
  for (const image of [event.before, event.after]) {
    if (image === null) continue
    for (const [column, value] of Object.entries(event.key)) {
      if (!Object.hasOwn(image, column) || !isDeepStrictEqual(image[column], value)) {
        throw new Error('cdc-redis: CDC event key does not match its row image')
      }
    }
  }
}

function retryDelay(config: ResolvedConfig, failures: number): number {
  return Math.min(config.retryMaxDelayMs, config.retryInitialDelayMs * 2 ** Math.min(failures - 1, 30))
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve(true)
    }, delayMs)
    const abort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function waitForSubscription(subscription: KafkaSubscription, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const finish = (completed: boolean): void => {
      signal.removeEventListener('abort', abort)
      resolve(completed)
    }
    const abort = (): void => { finish(false) }
    signal.addEventListener('abort', abort, { once: true })
    void subscription.done.then(
      () => { finish(true) },
      () => { finish(true) },
    )
  })
}

async function runWithDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`cdc-redis: Redis command timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  try {
    return await operation(controller.signal)
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new Error(`cdc-redis: Redis command timed out after ${timeoutMs}ms`, { cause })
    }
    throw cause
  } finally {
    clearTimeout(timer)
  }
}

/** Subscribe to CDC topics and apply successful records before Kafka commits their offsets. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = config as ResolvedConfig
  if (
    isBlank(config.subscriptionId) || isBlank(config.consumerGroup)
    || resolved.topics.length === 0
    || resolved.topics.some(isBlank)
    || new Set(resolved.topics).size !== resolved.topics.length
  ) throw new Error('cdc-redis: subscriptionId, consumerGroup, and unique topics must be non-blank')
  if (resolved.retryInitialDelayMs > resolved.retryMaxDelayMs) {
    throw new Error('cdc-redis: retryInitialDelayMs must not exceed retryMaxDelayMs')
  }

  const routes = new Map<string, ResolvedRoute>()
  const routedTopics = new Set<string>()
  for (const configured of config.routes) {
    const route: ResolvedRoute = {
      ...configured,
      ttlSeconds: configured.ttlSeconds ?? 0,
      watchedColumns: configured.watchedColumns ?? [],
    }
    const id = routeId(route.database, route.table)
    if (
      [route.database, route.table, route.topic, route.keyPrefix].some(isBlank)
      || route.watchedColumns.some(isBlank)
      || routes.has(id)
      || !config.topics.includes(route.topic)
      || new Set(route.watchedColumns).size !== route.watchedColumns.length
      || route.ttlSeconds > MAX_REDIS_TTL_SECONDS
    ) {
      throw new Error(`cdc-redis: invalid or duplicate route ${displayRoute(route.database, route.table)}`)
    }
    routes.set(id, route)
    routedTopics.add(route.topic)
  }
  if (routes.size === 0) throw new Error('cdc-redis: at least one route is required')
  if (config.topics.some(topic => !routedTopics.has(topic))) {
    throw new Error('cdc-redis: every subscribed topic must have a route')
  }

  let consecutiveFailures = 0
  const request: KafkaSubscribeRequest = {
    id: KafkaSubscriptionId(config.subscriptionId),
    groupId: KafkaConsumerGroupId(config.consumerGroup),
    topics: config.topics.map(KafkaTopic),
    fallbackMode: resolved.fallbackMode,
    async handle(message) {
      if (message.value === null) throw new Error('cdc-redis: tombstones are unsupported')
      const event = decodeCdcEvent(message.value)
      validateMessageIdentity(message, event)
      const route = routes.get(routeId(event.source.database, event.source.table))
      if (route === undefined) throw new Error('cdc-redis: event has no configured route')
      if (message.topic !== route.topic) throw new Error('cdc-redis: event arrived on the wrong topic')
      if (
        event.operation === 'update' && route.watchedColumns.length > 0
      ) {
        // Older v1 records may omit changedColumns. Apply those updates in full
        // so a missing hint cannot silently drop a projection change.
        const changedColumns = event.changedColumns
        if (
          changedColumns !== undefined
          && !route.watchedColumns.some(column => changedColumns.includes(column))
        ) {
          consecutiveFailures = 0
          return
        }
      }

      const key = redisKey(route, event.source.database, event.source.table, event.key)
      const value = event.after === null ? '' : JSON.stringify(event.after)
      await ctx.redis.withClient(async (client) => {
        const result = await runWithDeadline(resolved.commandTimeoutMs, async signal => (
          client.withAbortSignal(signal).eval(APPLY_IF_CURRENT_SCRIPT, {
            keys: [key, `${key}${VERSION_KEY_SUFFIX}`],
            arguments: [
              message.topic,
              String(message.partition),
              String(message.offset),
              event.operation === 'delete' ? 'delete' : 'write',
              value,
              String(route.ttlSeconds),
            ],
          })
        ))
        if (result === -1) {
          throw new Error('cdc-redis: one row key moved to a different Kafka topic or partition')
        }
        if (result !== 0 && result !== 1) {
          throw new Error('cdc-redis: Redis version script returned an unexpected result')
        }
      })
      consecutiveFailures = 0
    },
  }

  const stopped = new AbortController()
  const owner: { subscription?: KafkaSubscription } = {}
  const ownedSubscriptions = new Set<KafkaSubscription>()
  const closePromises = new WeakMap<KafkaSubscription, Promise<void>>()
  const startup = Promise.withResolvers<void>()
  let pendingSubscribe: Promise<KafkaSubscription> | undefined
  let supervisor: Promise<void> | undefined

  const closeSubscription = (subscription: KafkaSubscription): Promise<void> => {
    const existing = closePromises.get(subscription)
    if (existing !== undefined) return existing
    const closing = (async () => {
      try {
        await subscription.close()
      } finally {
        ownedSubscriptions.delete(subscription)
      }
    })()
    closePromises.set(subscription, closing)
    // The caller still observes the same rejection, but a late close cannot
    // become unhandled while ownership is being handed back to the supervisor.
    void closing.catch(() => {})
    return closing
  }

  const subscribeTracked = (): Promise<KafkaSubscription> => {
    const pending = Promise.resolve().then(() => ctx.kafka.subscribe(request))
    const tracked = pending.then((subscription) => {
      ownedSubscriptions.add(subscription)
      void subscription.done.catch(() => {})
      return subscription
    })
    pendingSubscribe = tracked
    void tracked.catch(() => {})
    void tracked.then(
      () => {
        if (pendingSubscribe === tracked) pendingSubscribe = undefined
      },
      () => {
        if (pendingSubscribe === tracked) pendingSubscribe = undefined
      },
    )
    return tracked
  }

  const supervisorLoop = async (): Promise<void> => {
    while (true) {
      const subscription = owner.subscription
      if (subscription === undefined) return
      if (!await waitForSubscription(subscription, stopped.signal)) return
      if (isAborted(stopped.signal)) return
      try {
        await closeSubscription(subscription)
      } catch {
        ctx.logger.warn('cdc-redis: failed subscription cleanup before retry')
      }
      consecutiveFailures += 1

      while (!isAborted(stopped.signal)) {
        if (resolved.maxRetries !== 'unlimited' && consecutiveFailures > resolved.maxRetries) {
          ctx.logger.error(`cdc-redis: Kafka subscription stopped after ${resolved.maxRetries} retries`)
          queueMicrotask(() => {
            void ctx.fiber.dispose().catch(() => {
              ctx.logger.error('cdc-redis: plugin unload failed after Kafka retries were exhausted')
            })
          })
          return
        }
        const delayMs = retryDelay(resolved, consecutiveFailures)
        ctx.logger.warn(`cdc-redis: Kafka subscription stopped; retrying in ${delayMs}ms`)
        if (!await waitForRetry(delayMs, stopped.signal)) return
        try {
          const next = await subscribeTracked()
          if (isAborted(stopped.signal)) {
            try {
              await closeSubscription(next)
            } catch {
              ctx.logger.warn('cdc-redis: failed subscription cleanup after disposal')
            }
            return
          }
          owner.subscription = next
          break
        } catch {
          consecutiveFailures += 1
        }
      }
    }
  }

  let cleanup: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    cleanup ??= (async () => {
      stopped.abort()
      await startup.promise

      let closeFailed = false
      let closeFailure: unknown
      const active = owner.subscription
      if (active !== undefined) {
        try {
          await closeSubscription(active)
        } catch (cause) {
          closeFailed = true
          closeFailure = cause
        }
      }
      if (pendingSubscribe !== undefined) await pendingSubscribe.catch(() => {})
      if (supervisor !== undefined) await supervisor
      for (const subscription of [...ownedSubscriptions]) {
        try {
          await closeSubscription(subscription)
        } catch {
          ctx.logger.warn('cdc-redis: failed subscription cleanup after disposal')
        }
      }
      if (closeFailed && closeFailure instanceof Error) throw closeFailure
      if (closeFailed) {
        throw new Error('cdc-redis: subscription close failed', { cause: closeFailure })
      }
    })()
    void cleanup.catch(() => {})
    return cleanup
  }

  ctx.effect(() => dispose, 'cdc-redis.subscription-supervisor')

  try {
    owner.subscription = await subscribeTracked()
    if (!isAborted(stopped.signal)) {
      supervisor = supervisorLoop()
      void supervisor.catch(() => {})
    }
  } finally {
    startup.resolve(undefined)
  }
}
