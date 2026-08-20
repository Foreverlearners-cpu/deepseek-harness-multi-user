import { createHash } from 'node:crypto'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  encodeSessionMessageChange,
  SESSION_MESSAGE_CHANGE_EVENT_TYPE,
  SESSION_MESSAGE_CHANGE_SCHEMA_VERSION,
  SessionMessageChangeEventId,
  SessionMessageChangeUserId,
} from '@deepseek-ai/dsh-session-message-change-protocol'
import type { SessionMessageChangeEvent } from '@deepseek-ai/dsh-session-message-change-protocol'
import type {
  KafkaConsumedMessage,
  KafkaSubscribeRequest,
  KafkaSubscription,
} from '@deepseek-ai/dsh-kafka'
import type { SessionCompleteMessage } from '../src/index.ts'

export const INDEX = 'dsh-session-messages'
const TOPIC = 'dsh.session.message-changes'
const GROUP_ID = 'dsh-session-message-search'
const MAX_BYTES = 4096

export const PLUGIN_CONFIG = {
  topic: TOPIC,
  groupId: GROUP_ID,
  maxBytes: MAX_BYTES,
  index: INDEX,
  mode: 'earliest' as const,
}

export const MATCHING_MAPPING = {
  user: { type: 'keyword' },
  session: { type: 'keyword' },
  message: { type: 'keyword' },
  role: { type: 'keyword' },
  content: { type: 'text' },
  source_time: { type: 'date' },
  source_seq: { type: 'long' },
  deleted: { type: 'boolean' },
}

export function documentId(userId: string, messageId: string): string {
  return createHash('sha256').update(JSON.stringify([userId, messageId])).digest('hex')
}

export function changeEvent(overrides: Partial<SessionMessageChangeEvent> = {}): SessionMessageChangeEvent {
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

export function completeMessage(
  overrides: Partial<SessionCompleteMessage> = {},
): SessionCompleteMessage {
  return {
    userId: SessionMessageChangeUserId('user-8'),
    messageId: MessageId('message-12'),
    role: 'user',
    visibleText: 'hello from the source',
    occurredAt: '2026-08-19T13:48:00.000Z',
    ...overrides,
  }
}

export function kafkaMessage(event: SessionMessageChangeEvent = changeEvent()): KafkaConsumedMessage {
  return {
    topic: TOPIC as KafkaConsumedMessage['topic'],
    partition: 1,
    offset: 7n,
    timestamp: 100n,
    key: Buffer.from('["user-8","session-100"]'),
    value: Buffer.from(encodeSessionMessageChange(event, { maxBytes: MAX_BYTES })),
    headers: [],
  }
}

function versionConflict(): Error {
  return Object.assign(new Error('version conflict'), {
    statusCode: 409,
    meta: {
      statusCode: 409,
      body: { error: { type: 'version_conflict_engine_exception' } },
    },
  })
}

export class FakeKafka {
  request?: KafkaSubscribeRequest
  committed = 0
  closed = false
  private inFlight: Promise<void> | undefined
  private readonly doneState = Promise.withResolvers<undefined>()

  async subscribe(request: KafkaSubscribeRequest): Promise<KafkaSubscription> {
    this.request = request
    return {
      id: request.id,
      done: this.doneState.promise,
      close: async () => this.close(),
    }
  }

  async deliver(message: KafkaConsumedMessage): Promise<void> {
    if (this.closed || this.request === undefined) throw new Error('subscription is closed')
    const run = Promise.resolve(this.request.handle(message)).then(() => {
      this.committed += 1
    })
    this.inFlight = run
    try {
      await run
    } finally {
      this.inFlight = undefined
    }
  }

  async close(): Promise<void> {
    if (this.inFlight !== undefined) await this.inFlight.catch(() => {})
    this.closed = true
    this.doneState.resolve(undefined)
  }
}

export class FakeSource {
  readonly reads: Array<{ sessionId: string; sourceSeq: number }> = []
  message: SessionCompleteMessage | Error | undefined = completeMessage()

  async read(sessionId: SessionId, sourceSeq: number): Promise<SessionCompleteMessage> {
    this.reads.push({ sessionId, sourceSeq })
    if (this.message instanceof Error) throw this.message
    if (this.message === undefined) throw new Error('source miss')
    return this.message
  }
}

export class FakeElasticsearch {
  mapping: Record<string, { type: string | number } | number> = { ...MATCHING_MAPPING }
  mappingError?: Error
  mappingResponse?: unknown
  failNextWrite?: unknown
  readonly writes: Array<{
    index: string
    id: string
    version: number
    version_type: string
    document: Record<string, unknown>
  }> = []
  readonly documents = new Map<string, { version: number; document: Record<string, unknown> }>()
  indexStarted = Promise.withResolvers<undefined>()
  indexGate?: Promise<undefined>

  async operation<T>(callback: (client: FakeElasticsearchClient) => T | Promise<T>): Promise<T> {
    return callback({
      indices: {
        getMapping: async () => {
          if (this.mappingError !== undefined) throw this.mappingError
          if (this.mappingResponse !== undefined) return this.mappingResponse
          return { [INDEX]: { mappings: { properties: this.mapping } } }
        },
      },
      index: async (params: {
        index: string
        id: string
        version: number
        version_type: string
        document: Record<string, unknown>
      }) => {
        this.indexStarted.resolve(undefined)
        if (this.indexGate !== undefined) await this.indexGate
        if (this.failNextWrite !== undefined) {
          const error = this.failNextWrite
          this.failNextWrite = undefined
          throw error
        }
        this.writes.push(params)
        const current = this.documents.get(params.id)
        if (current !== undefined && params.version <= current.version) throw versionConflict()
        this.documents.set(params.id, { version: params.version, document: params.document })
      },
    })
  }
}

interface FakeElasticsearchClient {
  indices: { getMapping(): Promise<unknown> }
  index(params: {
    index: string
    id: string
    version: number
    version_type: string
    document: Record<string, unknown>
  }): Promise<void>
}
