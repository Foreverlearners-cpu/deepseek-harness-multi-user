/**
 * Host-only Cordis function plugin that projects complete session messages into
 * Elasticsearch from content-free `session.message.changed` Kafka records.
 * @module @deepseek-ai/dsh-session-search-projection-elasticsearch
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ElasticsearchClient } from '@deepseek-ai/dsh-elasticsearch'
import {
  KafkaConsumerGroupId,
  KafkaSubscriptionId,
  KafkaTopic,
  type KafkaConsumedMessage,
  type KafkaSubscriptionMode,
} from '@deepseek-ai/dsh-kafka'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  decodeSessionMessageChange,
  SessionMessageChangeProtocolError,
  type SessionMessageChangeEvent,
  type SessionMessageChangeUserId,
} from '@deepseek-ai/dsh-session-message-change-protocol'
import z from '@deepseek-ai/schemastery'
import {
  assertSessionSearchProjectionMapping,
  isExternalVersionConflict,
  sessionSearchProjectionDocumentId,
} from './document.ts'
import { SessionSearchProjectionError } from './error.ts'

export { SessionSearchProjectionError } from './error.ts'
export type { SessionSearchProjectionErrorCode } from './error.ts'

/** Complete user or assistant message read at one session sequence. */
export interface SessionCompleteMessage {
  /** Authoritative private-session owner. */
  readonly userId: SessionMessageChangeUserId
  /** Immutable message identity. */
  readonly messageId: MessageId
  /** Visible speaker role stored on the document. */
  readonly role: 'user' | 'assistant'
  /** Complete visible text only; never reasoning or failed partial output. */
  readonly visibleText: string
  /** Canonical UTC source time stored as `source_time`. */
  readonly occurredAt: string
}

/** Authoritative complete-message lookup required by this Consumer. */
export interface SessionCompleteMessageQuery {
  /**
   * Read the complete message at one session sequence.
   * @param sessionId - Session that owns the message.
   * @param sourceSeq - Sequence of the authoritative complete-message fact.
   * @returns The complete user or assistant message at that sequence.
   * @throws When the identified complete message cannot be read.
   */
  read(sessionId: SessionId, sourceSeq: number): Promise<SessionCompleteMessage>
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'session-search-projection-elasticsearch'

/** Host Kafka, Elasticsearch, and complete-message source required before activation. */
export const inject = ['kafka', 'elasticsearch', 'sessionCompleteMessageQuery']

/** Explicit deployment settings; the plugin supplies no hidden defaults. */
export interface Config {
  /** Kafka topic authorized on `ctx.kafka`. */
  topic: string
  /** Independent consumer group authorized on `ctx.kafka`. */
  groupId: string
  /** Complete Kafka-value byte limit passed to `decodeSessionMessageChange`. */
  maxBytes: number
  /** Existing Elasticsearch index whose mapping this plugin validates. */
  index: string
  /** Kafka start mode used when the group has no committed offset. */
  mode: KafkaSubscriptionMode
}

/** Loader schema for the required topic, group, payload limit, index, and start mode. */
export const Config: z<Config> = z.object({
  topic: z.string().min(1).required(),
  groupId: z.string().min(1).required(),
  maxBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  index: z.string().min(1).required(),
  mode: z.union([z.const('committed'), z.const('earliest'), z.const('latest')]).required(),
})

interface IndexWrite {
  id: string
  version: number
  document: Record<string, unknown>
}

function failureCode(error: unknown): string {
  if (error instanceof SessionSearchProjectionError || error instanceof SessionMessageChangeProtocolError) {
    return error.code
  }
  return 'unknown'
}

async function writeDocument(ctx: Context, index: string, write: IndexWrite): Promise<void> {
  try {
    await ctx.elasticsearch.operation(async (client: ElasticsearchClient) => {
      await client.index({
        index,
        id: write.id,
        version: write.version,
        version_type: 'external',
        document: write.document,
      })
    })
  } catch (cause) {
    if (isExternalVersionConflict(cause)) return
    throw new SessionSearchProjectionError('elasticsearch-failed', { cause })
  }
}

async function handleChange(
  ctx: Context,
  source: SessionCompleteMessageQuery,
  config: Config,
  message: KafkaConsumedMessage,
): Promise<void> {
  const event: SessionMessageChangeEvent = decodeSessionMessageChange(message.value, {
    maxBytes: config.maxBytes,
  })
  const id = sessionSearchProjectionDocumentId(event.userId, event.messageId)
  const version = event.sourceSeq + 1
  if (event.operation === 'delete') {
    await writeDocument(ctx, config.index, {
      id,
      version,
      document: {
        user: event.userId,
        session: event.sessionId,
        message: event.messageId,
        source_time: event.occurredAt,
        source_seq: event.sourceSeq,
        deleted: true,
      },
    })
    return
  }
  let complete: SessionCompleteMessage
  try {
    complete = await source.read(event.sessionId, event.sourceSeq)
  } catch (cause) {
    throw new SessionSearchProjectionError('query-failed', { cause })
  }
  if (complete.userId !== event.userId || complete.messageId !== event.messageId) {
    throw new SessionSearchProjectionError('identity-mismatch')
  }
  await writeDocument(ctx, config.index, {
    id,
    version,
    document: {
      user: complete.userId,
      session: event.sessionId,
      message: complete.messageId,
      role: complete.role,
      content: complete.visibleText,
      source_time: complete.occurredAt,
      source_seq: event.sourceSeq,
      deleted: false,
    },
  })
}

/**
 * Validate the index mapping, subscribe to the configured topic, and project each record.
 * @param ctx - Host context providing Kafka, Elasticsearch, and `sessionCompleteMessageQuery`.
 * @param config - Required topic, group, payload limit, index, and start mode.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const source = ctx.get('sessionCompleteMessageQuery') as SessionCompleteMessageQuery
  await ctx.elasticsearch.operation(async (client) => {
    await assertSessionSearchProjectionMapping(client, config.index)
  })
  const subscription = await ctx.kafka.subscribe({
    id: KafkaSubscriptionId('session-search-projection'),
    groupId: KafkaConsumerGroupId(config.groupId),
    topics: [KafkaTopic(config.topic)],
    mode: config.mode,
    handle: async (message) => {
      try {
        await handleChange(ctx, source, config, message)
      } catch (error) {
        ctx.logger.warn(`session-search-projection: handler failed: ${failureCode(error)}`)
        throw error
      }
    },
  })
  ctx.effect(() => async () => {
    await subscription.close()
  }, 'session-search-projection.subscription')
}
