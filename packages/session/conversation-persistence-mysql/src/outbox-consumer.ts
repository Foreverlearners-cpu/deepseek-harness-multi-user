/** Optional semantic-outbox fan-out to Kafka, Redis, and Elasticsearch. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { KafkaService } from '@deepseek-ai/dsh-kafka'
import { KafkaTopic } from '@deepseek-ai/dsh-kafka'
import type { Redis } from '@deepseek-ai/dsh-redis'
import type { ElasticsearchService } from '@deepseek-ai/dsh-elasticsearch'
import type { ConversationOutboxEvent, MysqlConversationPersistence } from './index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    conversationPersistence: MysqlConversationPersistence
    kafka: KafkaService
    redis: Redis
    elasticsearch: ElasticsearchService
  }
}

/** Cordis configuration for the optional semantic outbox fan-out. */
export interface Config {
  enabled?: boolean
  stateFile?: string
  pollIntervalMs?: number
  kafkaTopic?: string
  kafkaGroup?: string
  redisPrefix?: string
  elasticsearchIndex?: string
}

/** Debezium change envelope containing one outbox row. */
export interface DebeziumOutboxChange {
  payload?: {
    after?: Record<string, unknown> | null
    op?: string
  }
}

/** Parse a Debezium row envelope without accepting chunk/event-log payloads.
 * @param change Debezium change payload to inspect.
 * @returns A validated semantic event, or undefined for non-conversation rows.
 */
export function parseDebeziumOutboxChange(change: DebeziumOutboxChange): ConversationOutboxEvent | undefined {
  const row = change.payload?.after
  if (row === null || row === undefined) return undefined
  const eventType = String(row.event_type ?? '')
  if (!eventType.startsWith('conversation.')) return undefined
  const payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json
  const extensions = typeof row.extensions === 'string' ? JSON.parse(row.extensions) : row.extensions
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  if (typeof extensions !== 'object' || extensions === null || Array.isArray(extensions)) return undefined
  return {
    schemaVersion: Number(row.schema_version ?? 1), eventId: String(row.outbox_id), eventType: eventType as ConversationOutboxEvent['eventType'],
    occurredAt: Number(row.occurred_at), userId: String(row.user_id), sessionId: String(row.session_id),
    ...(row.message_id === null || row.message_id === undefined ? {} : { messageId: String(row.message_id) }),
    aggregateRevision: Number(row.aggregate_revision), payload: payload as Record<string, unknown>,
    extensions: extensions as Record<string, unknown>,
  }
}

/**
 * Polls the MySQL outbox and fans out semantic events. MySQL remains the
 * authority: a downstream failure leaves the watermark unchanged and is
 * retried on the next poll. Each sink uses the stable outbox id for idempotency.
 */
export class ConversationOutboxConsumer extends Service {
  static inject = ['conversationPersistence']
  static Config: z<Config> = z.object({
    enabled: z.boolean().default(false), stateFile: z.string(),
    pollIntervalMs: z.number().step(1).min(250).default(2000),
    kafkaTopic: z.string(), kafkaGroup: z.string(), redisPrefix: z.string(), elasticsearchIndex: z.string(),
  })
  override readonly name = 'conversationOutbox'
  private readonly stateFile: string
  private readonly pollIntervalMs: number
  private watermark = -1
  private watermarkEventId = ''
  private watermarkSequence = -1
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private closed = false

  constructor(ctx: Context, public config: Config = {}) {
    super(ctx, 'conversationOutbox')
    this.stateFile = config.stateFile ?? join(process.env.DSH_HOME ?? '.dsh', 'conversation-outbox-watermark.json')
    this.pollIntervalMs = config.pollIntervalMs ?? 2000
    ctx.effect(() => async () => {
      this.closed = true
      if (this.timer !== undefined) clearTimeout(this.timer)
    }, 'conversationOutbox lifecycle')
  }

  async [Service.init](): Promise<void> {
    if (this.config.enabled !== true) return
    await this.loadWatermark()
    this.schedule(0)
  }

  private schedule(delay = this.pollIntervalMs): void {
    if (this.closed || this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.poll().finally(() => this.schedule())
    }, Math.max(0, delay))
  }

  private async poll(): Promise<void> {
    if (this.running || this.closed) return
    const kafka = this.ctx.get('kafka')
    const redis = this.ctx.get('redis')
    const elasticsearch = this.ctx.get('elasticsearch')
    if (kafka === undefined && redis === undefined && elasticsearch === undefined) return
    this.running = true
    try {
      const events = await this.ctx.conversationPersistence.readOutbox({
        afterSequence: this.watermarkSequence,
        afterOccurredAt: this.watermark, afterEventId: this.watermarkEventId, limit: 100,
      })
      for (const event of events) {
        await this.publish(event, kafka, redis, elasticsearch)
        this.watermark = event.occurredAt
        this.watermarkEventId = event.eventId
        this.watermarkSequence = event.outboxSequence ?? this.watermarkSequence
        await this.saveWatermark()
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(`conversation outbox fan-out failed; watermark remains ${this.watermark}: ${String(error)}`)
    } finally {
      this.running = false
    }
  }

  private async publish(
    event: ConversationOutboxEvent,
    kafka: KafkaService | undefined,
    redis: Redis | undefined,
    elasticsearch: ElasticsearchService | undefined,
  ): Promise<void> {
    const { outboxSequence: _outboxSequence, ...wireEvent } = event
    const value = Buffer.from(JSON.stringify(wireEvent), 'utf8')
    if (kafka !== undefined && this.config.kafkaTopic !== undefined) {
      await kafka.publish([{
        topic: KafkaTopic(this.config.kafkaTopic), key: Buffer.from(`${event.userId}:${event.sessionId}`), value,
        headers: { 'x-dsh-outbox-id': Buffer.from(event.eventId) }, timestamp: BigInt(event.occurredAt),
      }])
    }
    if (redis !== undefined) {
      const prefix = this.config.redisPrefix ?? 'dsh:conversation:event'
      await redis.withClient(client => client.set(`${prefix}:${event.eventId}`, value.toString('utf8')))
    }
    if (elasticsearch !== undefined && this.config.elasticsearchIndex !== undefined) {
      await elasticsearch.operation(client => client.index({ index: this.config.elasticsearchIndex!, id: event.eventId, document: wireEvent }))
    }
  }

  private async loadWatermark(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as { occurredAt?: number; eventId?: string; sequence?: number }
      if (Number.isSafeInteger(parsed.occurredAt)) {
        this.watermark = parsed.occurredAt!
        this.watermarkEventId = typeof parsed.eventId === 'string' ? parsed.eventId : ''
      }
      if (Number.isSafeInteger(parsed.sequence)) this.watermarkSequence = parsed.sequence!
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async saveWatermark(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true })
    const temporary = `${this.stateFile}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify({
      occurredAt: this.watermark, eventId: this.watermarkEventId, sequence: this.watermarkSequence,
    }) + '\n', 'utf8')
    await rename(temporary, this.stateFile)
  }
}

export default ConversationOutboxConsumer
