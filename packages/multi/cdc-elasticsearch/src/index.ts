/** Kafka CDC projection consumer for Elasticsearch. @module @deepseek-ai/dsh-cdc-elasticsearch */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import {
  decodeCdcEvent,
  digest,
  encodeKey,
  type CdcEvent,
} from '@deepseek-ai/dsh-cdc'
import type {} from '@deepseek-ai/dsh-elasticsearch'
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

const DEFAULT_RETRY_INITIAL_DELAY_MS = 1_000
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000
const DEFAULT_STATE_INDEX = 'dsh-cdc-state-v1'
const BINLOG_POSITION_RANGE = 0x1_0000_0000n
const MAX_BINLOG_POSITION = Number(BINLOG_POSITION_RANGE - 1n)
const MAX_EXTERNAL_VERSION = BigInt(Number.MAX_SAFE_INTEGER)

/** Elasticsearch destination for one source table. */
export interface ElasticsearchCdcRoute {
  /** Source schema name. */
  database: string
  /** Source table name. */
  table: string
  /** Kafka topic carrying this table. */
  topic: string
  /** Elasticsearch destination index. */
  index: string
  /** UPDATE columns that trigger this projection; empty means every update. */
  watchedColumns?: string[]
}

/** Elasticsearch CDC consumer configuration. */
export interface Config {
  /** Unique subscription identity within the Kafka service. */
  subscriptionId: string
  /** Kafka consumer group. */
  consumerGroup: string
  /** Allowed CDC topics. */
  topics: string[]
  /** Start mode when a partition has no committed offset. */
  fallbackMode?: KafkaSubscriptionFallbackMode
  /** First delay after a failed subscription in milliseconds. */
  retryInitialDelayMs?: number
  /** Maximum subscription retry delay in milliseconds. */
  retryMaxDelayMs?: number
  /** Maximum consecutive resubscriptions, or `unlimited`; zero disables retries. */
  maxRetries?: number | 'unlimited'
  /** Elasticsearch index retaining projection ordering metadata. */
  stateIndex?: string
  /** Source table routes. */
  routes: ElasticsearchCdcRoute[]
}

interface ResolvedConfig extends Config {
  fallbackMode: KafkaSubscriptionFallbackMode
  retryInitialDelayMs: number
  retryMaxDelayMs: number
  maxRetries: number | 'unlimited'
  stateIndex: string
}

interface ResolvedRoute extends ElasticsearchCdcRoute {
  watchedColumns: string[]
}

/** Cordis plugin name. */
export const name = 'cdc-elasticsearch'
/** Infrastructure services required by this consumer. */
export const inject = ['kafka', 'elasticsearch']
/** Validated Elasticsearch projection configuration. */
export const Config: z<Config> = z.object({
  subscriptionId: z.string().min(1).required(),
  consumerGroup: z.string().min(1).required(),
  topics: z.array(z.string().min(1)).required(),
  fallbackMode: z.union([
    z.const('earliest'), z.const('latest'), z.const('fail'),
  ] as const).default('latest'),
  retryInitialDelayMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_RETRY_INITIAL_DELAY_MS),
  retryMaxDelayMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_RETRY_MAX_DELAY_MS),
  maxRetries: z.union([z.natural(), z.const('unlimited')] as const).default('unlimited'),
  stateIndex: z.string().min(1).default(DEFAULT_STATE_INDEX),
  routes: z.array(z.object({
    database: z.string().min(1).required(),
    table: z.string().min(1).required(),
    topic: z.string().min(1).required(),
    index: z.string().min(1).required(),
    watchedColumns: z.array(z.string().min(1)).default([]),
  })).required(),
})

function routeId(database: string, table: string): string {
  return JSON.stringify([database, table])
}

function displayRoute(database: string, table: string): string {
  return `${database}.${table}`
}

function documentId(database: string, table: string, key: Record<string, unknown>): string {
  return digest(JSON.stringify({ database, table, key }))
}

function stateDocumentId(
  route: ResolvedRoute,
  event: CdcEvent,
): string {
  return digest(JSON.stringify({
    index: route.index,
    database: event.source.database,
    table: event.source.table,
    key: event.key,
  }))
}

function isBlank(value: string): boolean {
  return value.trim().length === 0
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function isVersionConflict(cause: unknown): boolean {
  if (
    typeof cause !== 'object' || cause === null
    || !('statusCode' in cause) || cause.statusCode !== 409
    || !('body' in cause) || typeof cause.body !== 'object' || cause.body === null
    || !('error' in cause.body) || typeof cause.body.error !== 'object' || cause.body.error === null
    || !('type' in cause.body.error)
  ) return false
  return cause.body.error.type === 'version_conflict_engine_exception'
}

function validateMessageIdentity(message: KafkaConsumedMessage, event: CdcEvent): void {
  if (message.key === null || !message.key.equals(encodeKey(event.key))) {
    throw new Error('cdc-elasticsearch: Kafka key does not match the CDC event key')
  }
  for (const image of [event.before, event.after]) {
    if (image === null) continue
    for (const [column, value] of Object.entries(event.key)) {
      if (!Object.hasOwn(image, column) || !isDeepStrictEqual(image[column], value)) {
        throw new Error('cdc-elasticsearch: CDC event key does not match its row image')
      }
    }
  }
}

function externalVersion(event: CdcEvent): number {
  const match = /\.([0-9]+)$/u.exec(event.source.file)
  const sequenceText = match?.[1]
  const normalizedSequence = sequenceText?.replace(/^0+/u, '') || '0'
  if (
    sequenceText === undefined || normalizedSequence.length > 7
    || event.source.position > MAX_BINLOG_POSITION
  ) {
    throw new Error('cdc-elasticsearch: MySQL binlog coordinate exceeds the exact external-version range')
  }
  const version = BigInt(normalizedSequence) * BINLOG_POSITION_RANGE + BigInt(event.source.position)
  if (version < 1n || version > MAX_EXTERNAL_VERSION) {
    throw new Error('cdc-elasticsearch: MySQL binlog coordinate exceeds the exact external-version range')
  }
  return Number(version)
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

/** Subscribe to CDC topics and apply successful records before Kafka commits their offsets. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = config as ResolvedConfig
  const stateIndex = config.stateIndex ?? DEFAULT_STATE_INDEX
  if (
    isBlank(config.subscriptionId) || isBlank(config.consumerGroup)
    || isBlank(stateIndex)
    || resolved.topics.length === 0
    || resolved.topics.some(isBlank)
    || new Set(resolved.topics).size !== resolved.topics.length
  ) throw new Error('cdc-elasticsearch: subscriptionId, consumerGroup, and unique topics must be non-blank')
  if (resolved.retryInitialDelayMs > resolved.retryMaxDelayMs) {
    throw new Error('cdc-elasticsearch: retryInitialDelayMs must not exceed retryMaxDelayMs')
  }

  const routes = new Map<string, ResolvedRoute>()
  const routedTopics = new Set<string>()
  for (const configured of config.routes) {
    const route: ResolvedRoute = {
      ...configured,
      watchedColumns: configured.watchedColumns ?? [],
    }
    const id = routeId(route.database, route.table)
    if (
      [route.database, route.table, route.topic, route.index].some(isBlank)
      || route.watchedColumns.some(isBlank)
      || routes.has(id)
      || !config.topics.includes(route.topic)
      || route.index === stateIndex
      || new Set(route.watchedColumns).size !== route.watchedColumns.length
    ) {
      throw new Error(`cdc-elasticsearch: invalid or duplicate route ${displayRoute(route.database, route.table)}`)
    }
    routes.set(id, route)
    routedTopics.add(route.topic)
  }
  if (routes.size === 0) throw new Error('cdc-elasticsearch: at least one route is required')
  if (config.topics.some(topic => !routedTopics.has(topic))) {
    throw new Error('cdc-elasticsearch: every subscribed topic must have a route')
  }

  let consecutiveFailures = 0
  const request: KafkaSubscribeRequest = {
    id: KafkaSubscriptionId(config.subscriptionId),
    groupId: KafkaConsumerGroupId(config.consumerGroup),
    topics: config.topics.map(KafkaTopic),
    fallbackMode: resolved.fallbackMode,
    async handle(message) {
      if (message.value === null) throw new Error('cdc-elasticsearch: tombstones are unsupported')
      const event = decodeCdcEvent(message.value)
      validateMessageIdentity(message, event)
      const route = routes.get(routeId(event.source.database, event.source.table))
      if (route === undefined) throw new Error('cdc-elasticsearch: event has no configured route')
      if (message.topic !== route.topic) throw new Error('cdc-elasticsearch: event arrived on the wrong topic')
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

      const id = documentId(event.source.database, event.source.table, event.key)
      const version = externalVersion(event)
      await ctx.elasticsearch.operation(async (client) => {
        const stateRequest = {
          index: stateIndex,
          id: stateDocumentId(route, event),
          document: {
            specVersion: 1,
            eventId: event.eventId,
            source: event.source,
            kafka: {
              topic: message.topic,
              partition: message.partition,
              offset: String(message.offset),
            },
          },
          version,
          version_type: 'external_gte' as const,
        }
        try {
          await client.index(stateRequest)
        } catch (cause) {
          if (isVersionConflict(cause)) {
            consecutiveFailures = 0
            return
          }
          throw cause
        }
        try {
          if (event.operation === 'delete') {
            await client.delete({
              index: route.index,
              id,
              version,
              version_type: 'external_gte',
            }, { ignore: [404] })
            return
          }
          await client.index({
            index: route.index,
            id,
            document: event.after,
            version,
            version_type: 'external_gte',
          })
        } catch (cause) {
          if (!isVersionConflict(cause)) throw cause
          try {
            await client.index(stateRequest)
          } catch (stateCause) {
            if (isVersionConflict(stateCause)) {
              consecutiveFailures = 0
              return
            }
            throw new AggregateError(
              [cause, stateCause],
              'cdc-elasticsearch: target conflict state verification failed',
            )
          }
          throw cause
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
        ctx.logger.warn('cdc-elasticsearch: failed subscription cleanup before retry')
      }
      consecutiveFailures += 1

      while (!isAborted(stopped.signal)) {
        if (resolved.maxRetries !== 'unlimited' && consecutiveFailures > resolved.maxRetries) {
          ctx.logger.error(`cdc-elasticsearch: Kafka subscription stopped after ${resolved.maxRetries} retries`)
          queueMicrotask(() => {
            void ctx.fiber.dispose().catch(() => {
              ctx.logger.error('cdc-elasticsearch: plugin unload failed after Kafka retries were exhausted')
            })
          })
          return
        }
        const delayMs = retryDelay(resolved, consecutiveFailures)
        ctx.logger.warn(`cdc-elasticsearch: Kafka subscription stopped; retrying in ${delayMs}ms`)
        if (!await waitForRetry(delayMs, stopped.signal)) return
        try {
          const next = await subscribeTracked()
          if (isAborted(stopped.signal)) {
            try {
              await closeSubscription(next)
            } catch {
              ctx.logger.warn('cdc-elasticsearch: failed subscription cleanup after disposal')
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
          ctx.logger.warn('cdc-elasticsearch: failed subscription cleanup after disposal')
        }
      }
      if (closeFailed && closeFailure instanceof Error) throw closeFailure
      if (closeFailed) {
        throw new Error('cdc-elasticsearch: subscription close failed', { cause: closeFailure })
      }
    })()
    void cleanup.catch(() => {})
    return cleanup
  }

  ctx.effect(() => dispose, 'cdc-elasticsearch.subscription-supervisor')

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
