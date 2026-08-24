/** CDC row-image projection of complete visible session messages into Elasticsearch. */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import {
  decodeCdcEvent,
  encodeCdcEvent,
  encodeKey,
  getChangedColumns,
  type CdcEvent,
  type CdcValue,
} from '@deepseek-ai/dsh-cdc-protocol'
import type { ElasticsearchClient } from '@deepseek-ai/dsh-elasticsearch'
import {
  KafkaConsumerGroupId,
  KafkaSubscriptionId,
  KafkaTopic,
  type KafkaConsumedMessage,
  type KafkaSubscriptionFallbackMode,
} from '@deepseek-ai/dsh-kafka'
import type { EventCodec, EventDelivery, EventHandler } from '@deepseek-ai/dsh-kafka-events'
import z from '@deepseek-ai/schemastery'
import {
  assertSessionSearchProjectionMapping,
  isExternalVersionConflict,
  sessionSearchProjectionDocumentId,
} from './document.ts'
import { SessionSearchProjectionError } from './error.ts'

export { SessionSearchProjectionError } from './error.ts'
export type { SessionSearchProjectionErrorCode } from './error.ts'

const SEARCH_COLUMNS = new Set([
  'tenant_id',
  'user_id',
  'session_id',
  'message_id',
  'revision',
  'status',
  'visibility',
  'role',
  'visible_text',
  'occurred_at',
])
const COMPLETED_STATUS = 'completed'
const USER_VISIBILITY = 'user'

/** Cordis plugin name. */
export const name = 'session-search-projection-elasticsearch'
/** Typed Kafka event runner and Elasticsearch transport required at activation. */
export const inject = ['kafkaEvents', 'elasticsearch']

/** Fixed CDC route and Elasticsearch destination. */
export interface Config {
  /** Kafka topic carrying session CDC events. */
  topic: string
  /** Kafka consumer group for the search projection. */
  groupId: string
  /** Stable Kafka subscription identity. */
  subscriptionId: string
  /** Offset fallback applied when no committed position exists. */
  fallbackMode: KafkaSubscriptionFallbackMode
  /** Maximum accepted encoded Kafka record size. */
  maxBytes: number
  /** Source database name accepted by the projection. */
  database: string
  /** Source table name accepted by the projection. */
  table: string
  /** Event schema fingerprints accepted by the projection. */
  schemaFingerprints: string[]
  /** Elasticsearch index receiving projected messages. */
  index: string
}

/** Loader schema with no hidden deployment values. */
export const Config: z<Config> = z.object({
  topic: z.string().min(1).required(),
  groupId: z.string().min(1).required(),
  subscriptionId: z.string().min(1).required(),
  fallbackMode: z.union([z.const('earliest'), z.const('latest'), z.const('fail')] as const).required(),
  maxBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  database: z.string().min(1).required(),
  table: z.string().min(1).required(),
  schemaFingerprints: z.array(z.string().min(1)).required(),
  index: z.string().min(1).required(),
})

interface SessionMessageRow {
  tenantId: string
  userId: string
  sessionId: string
  messageId: string
  revision: number
  status: string
  visibility: string
  role: 'user' | 'assistant'
  visibleText: string
  occurredAt: string
}

/** Kafka-independent authoritative input accepted by the projection writer. */
export interface SessionSearchProjectionRecord {
  tenantId: string
  userId: string
  sessionId: string
  messageId: string
  revision: number
  status: string
  visibility: string
  role: string
  visibleText: string
  occurredAt: string
  deleted: boolean
}

/** Minimal Elasticsearch operation boundary required by the projection writer. */
export interface SessionSearchProjectionElasticsearch {
  operation<T>(callback: (client: ElasticsearchClient) => T | Promise<T>): Promise<T>
}

function invalidEvent(cause?: unknown): SessionSearchProjectionError {
  return new SessionSearchProjectionError(
    'invalid-event',
    cause === undefined ? undefined : { cause },
  )
}

function requiredString(row: Record<string, CdcValue>, column: string): string {
  const value = row[column]
  if (typeof value !== 'string' || value.trim().length === 0) throw invalidEvent()
  return value
}

function requiredRevision(row: Record<string, CdcValue>): number {
  const value = row.revision
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw invalidEvent()
  return value
}

function messageRow(row: Record<string, CdcValue>): SessionMessageRow {
  const role = requiredString(row, 'role')
  if (role !== 'user' && role !== 'assistant') throw invalidEvent()
  const occurredAt = requiredString(row, 'occurred_at')
  if (!Number.isFinite(Date.parse(occurredAt)) || new Date(Date.parse(occurredAt)).toISOString() !== occurredAt) {
    throw invalidEvent()
  }
  return {
    tenantId: requiredString(row, 'tenant_id'),
    userId: requiredString(row, 'user_id'),
    sessionId: requiredString(row, 'session_id'),
    messageId: requiredString(row, 'message_id'),
    revision: requiredRevision(row),
    status: requiredString(row, 'status'),
    visibility: requiredString(row, 'visibility'),
    role,
    visibleText: requiredString(row, 'visible_text'),
    occurredAt,
  }
}

function validateKey(message: KafkaConsumedMessage, event: CdcEvent): void {
  if (message.key === null || !message.key.equals(encodeKey(event.key))) throw invalidEvent()
  for (const image of [event.before, event.after]) {
    if (image === null) continue
    for (const [column, value] of Object.entries(event.key)) {
      if (!Object.hasOwn(image, column) || !isDeepStrictEqual(image[column], value)) throw invalidEvent()
    }
  }
}

function validateRoute(config: Config, delivery: EventDelivery<CdcEvent>): void {
  const { event, message } = delivery
  if (
    message.topic !== config.topic
    || event.source.database !== config.database
    || event.source.table !== config.table
    || !config.schemaFingerprints.includes(event.schemaFingerprint)
  ) throw invalidEvent()
  validateKey(message, event)
}

function imageFor(event: CdcEvent): Record<string, CdcValue> {
  const image = event.operation === 'delete' ? event.before : event.after
  if (image === null) throw invalidEvent()
  return image
}

function shouldProcess(event: CdcEvent): boolean {
  if (event.operation !== 'update') return true
  if (event.changedColumns === undefined) return true
  return getChangedColumns(event).some((column: string) => SEARCH_COLUMNS.has(column))
}

async function writeDocument(
  elasticsearch: SessionSearchProjectionElasticsearch,
  index: string,
  id: string,
  version: number,
  document: Record<string, unknown>,
): Promise<void> {
  try {
    await elasticsearch.operation(async (client: ElasticsearchClient) => {
      await client.index({ index, id, version, version_type: 'external', document })
    })
  } catch (cause) {
    if (isExternalVersionConflict(cause)) return
    throw new SessionSearchProjectionError('elasticsearch-failed', { cause })
  }
}

function validRecord(record: SessionSearchProjectionRecord): boolean {
  const required = [
    record.tenantId,
    record.userId,
    record.sessionId,
    record.messageId,
    record.status,
    record.visibility,
    record.occurredAt,
  ]
  const visible = !record.deleted && record.status === COMPLETED_STATUS && record.visibility === USER_VISIBILITY
  return required.every(value => typeof value === 'string' && value.trim().length > 0)
    && Number.isSafeInteger(record.revision) && record.revision > 0
    && typeof record.deleted === 'boolean'
    && typeof record.role === 'string'
    && typeof record.visibleText === 'string'
    && (!visible || ((record.role === 'user' || record.role === 'assistant') && record.visibleText.trim().length > 0))
    && Number.isFinite(Date.parse(record.occurredAt))
    && new Date(Date.parse(record.occurredAt)).toISOString() === record.occurredAt
}

/**
 * Apply one authoritative projection record without Kafka or CDC metadata.
 * Structurally compatible reconciler records can call this function from a named sink.
 */
export async function applySessionSearchProjectionRecord(
  elasticsearch: SessionSearchProjectionElasticsearch,
  index: string,
  record: SessionSearchProjectionRecord,
): Promise<void> {
  if (index.trim().length === 0 || !validRecord(record)) {
    throw new SessionSearchProjectionError('invalid-record')
  }
  const deleted = record.deleted
    || record.status !== COMPLETED_STATUS
    || record.visibility !== USER_VISIBILITY
  await writeDocument(
    elasticsearch,
    index,
    sessionSearchProjectionDocumentId(record.tenantId, record.userId, record.messageId),
    record.revision,
    {
      tenant: record.tenantId,
      user: record.userId,
      session: record.sessionId,
      message: record.messageId,
      status: record.status,
      visibility: record.visibility,
      ...(deleted ? {} : { role: record.role, content: record.visibleText }),
      source_time: record.occurredAt,
      revision: record.revision,
      deleted,
    },
  )
}

class ProjectionHandler implements EventHandler<CdcEvent> {
  constructor(private readonly ctx: Context, private readonly config: Config) {}

  async handle(delivery: EventDelivery<CdcEvent>): Promise<void> {
    validateRoute(this.config, delivery)
    if (!shouldProcess(delivery.event)) return
    const row = messageRow(imageFor(delivery.event))
    await applySessionSearchProjectionRecord(this.ctx.elasticsearch, this.config.index, {
      ...row,
      deleted: delivery.event.operation === 'delete',
    })
  }
}

/** Validate mapping and start the typed CDC consumer. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.schemaFingerprints.length === 0 || new Set(config.schemaFingerprints).size !== config.schemaFingerprints.length) {
    throw new Error('session search projection requires unique schema fingerprints')
  }
  await ctx.elasticsearch.operation(async (client: ElasticsearchClient) => (
    assertSessionSearchProjectionMapping(client, config.index)
  ))
  const codec: EventCodec<CdcEvent> = {
    encode: (event: CdcEvent) => encodeCdcEvent(event, { maxBytes: config.maxBytes }),
    decode: (value: Uint8Array | undefined) => {
      if (value === undefined) throw invalidEvent()
      try {
        return decodeCdcEvent(value, { maxBytes: config.maxBytes })
      } catch (cause) {
        throw invalidEvent(cause)
      }
    },
  }
  const subscription = await ctx.kafkaEvents.subscribe({
    id: KafkaSubscriptionId(config.subscriptionId),
    groupId: KafkaConsumerGroupId(config.groupId),
    topics: [KafkaTopic(config.topic)],
    fallbackMode: config.fallbackMode,
    codec,
    handler: new ProjectionHandler(ctx, config),
  })
  ctx.effect(() => async () => { await subscription.close() }, 'session-search-projection.subscription')
  void subscription.done.catch(() => {
    ctx.logger.error('session-search-projection: Kafka subscription stopped')
    queueMicrotask(() => { void ctx.fiber.dispose().catch(() => {}) })
  })
}
