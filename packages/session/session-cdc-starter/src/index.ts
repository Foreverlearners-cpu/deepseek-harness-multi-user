/** Session CDC runtime composition with supervised Redis and Elasticsearch consumers. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { KafkaEventConsumerHealth, KafkaEventConsumerStatus } from '@deepseek-ai/dsh-kafka-events'
import KafkaEventsService from '@deepseek-ai/dsh-kafka-events'
import { applySessionContextCacheSnapshot } from '@deepseek-ai/dsh-session-cache-invalidation-redis'
import * as RedisConsumer from '@deepseek-ai/dsh-session-cache-invalidation-redis'
import SessionProjectionReconcilerService from '@deepseek-ai/dsh-session-projection-reconciler'
import type { SessionProjectionRecord, SessionProjectionSink } from '@deepseek-ai/dsh-session-projection-reconciler'
import { applySessionSearchProjectionRecord } from '@deepseek-ai/dsh-session-search-projection-elasticsearch'
import * as SearchConsumer from '@deepseek-ai/dsh-session-search-projection-elasticsearch'
import z from '@deepseek-ai/schemastery'

/** Shared authoritative CDC route. */
export interface SessionCdcRouteConfig {
  topic: string
  database: string
  table: string
  maxBytes: number
}

/** Redis consumer identity, offset fallback, and exact schema. */
export interface SessionCdcRedisConfig {
  groupId: string
  subscriptionId: string
  fallbackMode: 'earliest' | 'latest' | 'fail'
  schemaFingerprint: string
}

/** Elasticsearch consumer identity, offset fallback, accepted schemas, and index. */
export interface SessionCdcElasticsearchConfig {
  groupId: string
  subscriptionId: string
  fallbackMode: 'earliest' | 'latest' | 'fail'
  schemaFingerprints: string[]
  index: string
}

/** Optional operator-triggered reconciliation service configuration. */
export interface SessionCdcReconcilerConfig {
  maxBatchSize: number
}

/** Complete starter configuration with explicit deployment-owned values. */
export interface Config {
  route: SessionCdcRouteConfig
  redis: SessionCdcRedisConfig
  elasticsearch: SessionCdcElasticsearchConfig
  reconciler?: SessionCdcReconcilerConfig
  monitorIntervalMs: number
}

const fallbackMode = z.union([z.const('earliest'), z.const('latest'), z.const('fail')] as const)

/** Loader schema; cross-consumer relationships are checked before mounting children. */
export const Config: z<Config> = z.object({
  route: z.object({
    topic: z.string().min(1).required(),
    database: z.string().min(1).required(),
    table: z.string().min(1).required(),
    maxBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  }).required(),
  redis: z.object({
    groupId: z.string().min(1).required(),
    subscriptionId: z.string().min(1).required(),
    fallbackMode: fallbackMode.required(),
    schemaFingerprint: z.string().min(1).required(),
  }).required(),
  elasticsearch: z.object({
    groupId: z.string().min(1).required(),
    subscriptionId: z.string().min(1).required(),
    fallbackMode: fallbackMode.required(),
    schemaFingerprints: z.array(z.string().min(1)).required(),
    index: z.string().min(1).required(),
  }).required(),
  reconciler: z.object({
    maxBatchSize: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  }),
  monitorIntervalMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
})

/** Aggregate consumer status without event values or failure details. */
export interface SessionCdcConsumerHealth {
  subscriptionId: string
  status: KafkaEventConsumerStatus | 'missing'
  received: number
  filtered: number
  handled: number
  failures: number
}

/** Privacy-bounded aggregate runtime state. */
export interface SessionCdcStarterHealth {
  status: 'starting' | 'running' | 'failed' | 'stopping'
  redis: SessionCdcConsumerHealth
  elasticsearch: SessionCdcConsumerHealth
  reconciler?: ReturnType<SessionProjectionReconcilerService['health']>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionCdcStarter: SessionCdcStarterService
  }
}

function assertConfig(config: Config): void {
  if (config.redis.groupId === config.elasticsearch.groupId) {
    throw new Error('session-cdc-starter: Redis and Elasticsearch consumer groups must be different')
  }
  if (config.redis.subscriptionId === config.elasticsearch.subscriptionId) {
    throw new Error('session-cdc-starter: Redis and Elasticsearch subscription ids must be different')
  }
  const fingerprints = config.elasticsearch.schemaFingerprints
  if (fingerprints.length === 0 || new Set(fingerprints).size !== fingerprints.length) {
    throw new Error('session-cdc-starter: Elasticsearch schema fingerprints must be non-empty and unique')
  }
  if (!fingerprints.includes(config.redis.schemaFingerprint)) {
    throw new Error('session-cdc-starter: Redis schema fingerprint must be accepted by Elasticsearch')
  }
}

function missing(subscriptionId: string): SessionCdcConsumerHealth {
  return { subscriptionId, status: 'missing', received: 0, filtered: 0, handled: 0, failures: 0 }
}

function consumerHealth(
  health: readonly KafkaEventConsumerHealth[],
  subscriptionId: string,
): SessionCdcConsumerHealth {
  const current = health.find(candidate => candidate.id === subscriptionId)
  return current === undefined
    ? missing(subscriptionId)
    : {
      subscriptionId,
      status: current.status,
      received: current.received,
      filtered: current.filtered,
      handled: current.handled,
      failures: current.failures,
    }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason
}

/** Supervised owner of the complete live CDC projection composition. */
export class SessionCdcStarterService extends Service {
  static inject = ['kafka', 'redis', 'elasticsearch']
  static Config = Config

  private status: SessionCdcStarterHealth['status'] = 'starting'
  private kafkaEvents?: KafkaEventsService
  private reconciler?: SessionProjectionReconcilerService
  private monitor: ReturnType<typeof setInterval> | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'sessionCdcStarter')
  }

  async [Service.init](): Promise<void> {
    assertConfig(this.config)
    await this.ctx.plugin(KafkaEventsService)
    this.kafkaEvents = this.ctx.kafkaEvents
    await this.ctx.plugin(SearchConsumer, {
      ...this.config.route,
      ...this.config.elasticsearch,
    })
    await this.ctx.plugin(RedisConsumer, {
      ...this.config.route,
      ...this.config.redis,
    })
    if (this.config.reconciler !== undefined) {
      await this.ctx.plugin(SessionProjectionReconcilerService, this.config.reconciler)
      this.reconciler = this.ctx.sessionProjectionReconciler
      this.registerReconcilerSinks(this.reconciler)
    }
    this.status = 'running'
    this.ctx.effect(() => {
      this.monitor = setInterval(() => { this.checkConsumers() }, this.config.monitorIntervalMs)
      return () => {
        if (this.monitor !== undefined) clearInterval(this.monitor)
        this.monitor = undefined
        if (this.status !== 'failed') this.status = 'stopping'
      }
    }, 'session-cdc-starter.monitor')
    this.checkConsumers()
  }

  /** Return detached aggregate health without records, errors, or backend credentials. */
  health(): SessionCdcStarterHealth {
    const subscriptions = this.kafkaEvents?.health() ?? []
    return {
      status: this.status,
      redis: consumerHealth(subscriptions, this.config.redis.subscriptionId),
      elasticsearch: consumerHealth(subscriptions, this.config.elasticsearch.subscriptionId),
      ...(this.reconciler === undefined ? {} : { reconciler: this.reconciler.health() }),
    }
  }

  private registerReconcilerSinks(reconciler: SessionProjectionReconcilerService): void {
    const redisSink: SessionProjectionSink = {
      name: 'session-cache-invalidation-redis',
      apply: async (record, signal) => {
        throwIfAborted(signal)
        await this.ctx.redis.withClient(async (client) => {
          await applySessionContextCacheSnapshot(client, record)
        })
      },
    }
    const elasticsearchSink: SessionProjectionSink = {
      name: 'session-search-projection-elasticsearch',
      apply: async (record: SessionProjectionRecord, signal) => {
        throwIfAborted(signal)
        await applySessionSearchProjectionRecord(
          this.ctx.elasticsearch,
          this.config.elasticsearch.index,
          record,
        )
      },
    }
    this.ctx.effect(() => {
      const disposeRedis = reconciler.registerSink(redisSink)
      const disposeElasticsearch = reconciler.registerSink(elasticsearchSink)
      return () => {
        disposeElasticsearch()
        disposeRedis()
      }
    }, 'session-cdc-starter.reconciler-sinks')
  }

  private checkConsumers(): void {
    if (this.status !== 'running') return
    const health = this.health()
    if (health.redis.status === 'running' && health.elasticsearch.status === 'running') return
    this.status = 'failed'
    if (this.monitor !== undefined) clearInterval(this.monitor)
    this.monitor = undefined
    this.ctx.logger.error('session-cdc-starter: an expected Kafka subscription stopped')
    queueMicrotask(() => {
      void this.ctx.fiber.dispose().catch(() => {
        this.ctx.logger.error('session-cdc-starter: failed to unload after consumer loss')
      })
    })
  }
}

export default SessionCdcStarterService
