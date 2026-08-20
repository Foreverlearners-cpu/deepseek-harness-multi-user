/** User-scoped, message-only conversation persistence for a ToC deployment. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ResultSetHeader } from 'mysql2'
import type { UserId } from '@deepseek-ai/dsh-user'
import { UserId as brandUserId } from '@deepseek-ai/dsh-user'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, UserMessage } from '@deepseek-ai/dsh-session'
import type { AssistantMessage, ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { MessageId, CallId } from '@deepseek-ai/dsh-llm/brand'
import type { FileObjectStore } from '@deepseek-ai/dsh-file-storage'
import {
  ATTACHMENT_OBJECTS_TABLE, CONFIG_TABLE, CONVERSATION_FILES_TABLE,
  CONVERSATIONS_TABLE, ensureSchema, MESSAGES_TABLE, MESSAGE_FILES_TABLE,
  ATTEMPTS_TABLE, OUTBOX_TABLE,
  type ConversationFileRow, type ConversationRow, type MessageRow,
} from './schema.ts'
import { DurableMessageSpool } from './spool.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    conversationPersistence: MysqlConversationPersistence
    runtimeConfigs: MysqlRuntimeConfigStore
  }
}

export { ensureSchema, SCHEMA_VERSION } from './schema.ts'
export { DurableMessageSpool } from './spool.ts'

type JsonObject = Record<string, unknown>
type JsonValue = unknown
const RESERVED_EXTENSION_KEYS = new Set(['sessionId', 'userId', 'title', 'status', 'revision', 'ordinal', 'role', 'content'])
const DEFAULT_CONVERSATION_TITLE = '新会话'
/** Runtime-config key that controls the fallback title for new conversations. */
export const CONVERSATION_DEFAULT_TITLE_CONFIG_KEY = 'conversation.default_title'

/** Lifecycle state of a conversation. */
export type ConversationStatus = 'active' | 'archived' | 'deleted'
/** Source state of a conversation title. */
export type ConversationTitleStatus = 'fallback' | 'generating' | 'generated' | 'manual'
/** Message-only event kinds projected into MySQL. */
export type MessageEventType = 'user/message' | 'assistant/message' | 'tool/result'
/** Message role stored in the projection. */
export type MessageRole = 'user' | 'assistant' | 'tool'
/** Lifecycle state of a projected message. */
export type MessageStatus = 'completed' | 'partial' | 'failed' | 'superseded'

/** User-scoped conversation metadata returned by the persistence service. */
export interface Conversation {
  sessionId: string
  version: number
  userId: string
  title: string
  titleStatus: ConversationTitleStatus
  titleSource: string
  titleRevision: number
  titleUpdatedAt: number
  status: ConversationStatus
  cwd: string | null
  parentSessionId: string | null
  seedLength: number | null
  origin: string | null
  delegationDepth: number | null
  agentPreset: string | null
  incarnation: string
  revision: number
  nextMessageOrdinal: number
  extensions: JsonObject
  createdAt: number
  updatedAt: number
}

/** User-scoped message row returned by the persistence service. */
export interface ConversationMessage {
  messageId: string
  sessionId: string
  userId: string
  ordinal: number
  eventType: MessageEventType
  role: MessageRole
  turnNo: number
  stepNo: number
  content: JsonValue
  source: JsonValue | null
  toolCallId: string | null
  usage: JsonValue | null
  visibility: 'user' | 'internal'
  status: MessageStatus
  extensions: JsonObject
  createdAt: number
  updatedAt: number
}

/** Input used to create a conversation projection. */
export interface CreateConversationInput {
  sessionId: string
  version?: number
  title?: string
  titleStatus?: ConversationTitleStatus
  titleSource?: string
  cwd?: string | null
  parentSessionId?: string | null
  seedLength?: number | null
  origin?: string | null
  delegationDepth?: number | null
  agentPreset?: string | null
  extensions?: JsonObject
  createdAt?: number
}

/** One message and its optional file links to append transactionally. */
export interface AppendMessageInput {
  messageId?: string
  eventType: MessageEventType
  role: MessageRole
  turnNo?: number
  stepNo?: number
  content: JsonValue
  source?: JsonValue | null
  toolCallId?: string | null
  usage?: JsonValue | null
  visibility?: 'user' | 'internal'
  status?: MessageStatus
  extensions?: JsonObject
  /** Conversation file ids attached to this message. The ids are checked and linked in the same transaction. */
  fileIds?: readonly string[]
}

/** File bytes and metadata to register against a conversation. */
export interface RegisterFileInput {
  fileId?: string
  originalName: string
  mediaType: string
  purpose?: string
  data: Uint8Array
  expectedSha256?: string
  extensions?: JsonObject
}

/** Conversation-owned file metadata returned by the persistence service. */
export interface ConversationFile {
  fileId: string
  userId: string
  sessionId: string
  objectId: string
  originalName: string
  mediaType: string
  byteSize: number
  purpose: string
  status: 'ready' | 'deleted' | 'quarantined'
  extensions: JsonObject
  createdAt: number
}

/** Dynamic runtime configuration row. */
export interface RuntimeConfig {
  key: string
  value: JsonValue
  valueType: string
  schemaVersion: number
  description: string
  status: 'active' | 'disabled'
  revision: number
  updatedBy: string | null
  extensions: JsonObject
  createdAt: number
  updatedAt: number
}

/** Cordis configuration for the user-scoped MySQL projection. */
export interface Config {
  /** Trusted authenticated user whose conversations this plugin instance serves. */
  userId: string
  /** Maximum accepted byte size for one conversation file. */
  maxFileBytes?: number
  /** Durable root for final-message retry records awaiting MySQL commit. */
  spoolRoot?: string
  /** Delay between retry attempts for pending durable spool records. */
  spoolRetryMs?: number
}

/** Input used to create or update one runtime configuration value. */
export interface RuntimeConfigInput {
  key: string
  value: JsonValue
  valueType?: string
  schemaVersion?: number
  description?: string
  updatedBy?: string | null
  extensions?: JsonObject
  expectedRevision?: number
}

/** Session header and message-only events reconstructed for AgentLoop resume. */
export interface HydratedSession {
  meta: SessionHeader
  events: SessionEvent[]
}

/** Durable model-attempt metadata associated with a conversation turn. */
export interface ModelAttempt {
  attemptId: string
  sessionId: string
  turnNo: number
  stepNo: number
  retryNo: number
  provider: string
  model: string
  status: 'started' | 'completed' | 'failed' | 'cancelled'
  startedAt: number
  firstTokenAt: number | null
  finishedAt: number | null
  finishReason: string | null
  usage: JsonValue | null
  finalMessageId: string | null
  partialContent: JsonValue | null
  errorCode: string | null
  errorMessage: string | null
  extensions: JsonObject
}

/** Semantic event emitted after a conversation projection commits. */
export interface ConversationOutboxEvent {
  schemaVersion: number
  eventId: string
  eventType: 'conversation.message.committed' | 'conversation.title.changed' | 'conversation.attempt.completed'
  occurredAt: number
  userId: string
  sessionId: string
  messageId?: string
  aggregateRevision: number
  payload: JsonObject
  extensions: JsonObject
  /** Internal monotonic MySQL cursor; omitted by Debezium payloads. */
  outboxSequence?: number
}

/** Listener called after a runtime configuration commit. */
export type RuntimeConfigListener = (config: RuntimeConfig) => void

function json(value: JsonValue, name: string): string {
  let encoded: string
  try { encoded = JSON.stringify(value) } catch (error: unknown) { throw new Error(`${name} must be JSON serializable`, { cause: error }) }
  if (encoded === undefined) throw new Error(`${name} must not be undefined`)
  return encoded
}

function object(value: unknown, name: string, maxBytes = 64 * 1024): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be a JSON object`)
  const parsed = JSON.parse(json(value, name)) as unknown
  if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > maxBytes) throw new Error(`${name} exceeds ${maxBytes} bytes`)
  for (const key of Object.keys(parsed as JsonObject)) {
    if (RESERVED_EXTENSION_KEYS.has(key)) throw new Error(`${name} cannot override key field "${key}"`)
  }
  return parsed as JsonObject
}

/** Validate a JSON object that is itself a payload (not an extensions bag). */
function payloadObject(value: unknown, name: string, maxBytes = 64 * 1024): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be a JSON object`)
  const parsed = JSON.parse(json(value, name)) as unknown
  if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > maxBytes) throw new Error(`${name} exceeds ${maxBytes} bytes`)
  return parsed as JsonObject
}

function parseJson(value: unknown, name: string): JsonValue {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) as JsonValue } catch (error: unknown) { throw new Error(`invalid JSON in ${name}`, { cause: error }) }
}

function parseObject(value: unknown, name: string): JsonObject {
  return object(parseJson(value, name), name)
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    sessionId: row.session_id,
    version: row.version,
    userId: row.user_id,
    title: row.title,
    titleStatus: row.title_status as ConversationTitleStatus,
    titleSource: row.title_source,
    titleRevision: row.title_revision,
    titleUpdatedAt: row.title_updated_at,
    status: row.status as ConversationStatus,
    cwd: row.cwd,
    parentSessionId: row.parent_session_id,
    seedLength: row.seed_length,
    origin: row.origin,
    delegationDepth: row.delegation_depth,
    agentPreset: row.agent_preset,
    incarnation: row.incarnation,
    revision: row.revision,
    nextMessageOrdinal: row.next_message_ordinal,
    extensions: parseObject(row.extensions, 'conversation.extensions'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapMessage(row: MessageRow): ConversationMessage {
  return {
    messageId: row.message_id,
    sessionId: row.session_id,
    userId: row.user_id,
    ordinal: row.ordinal,
    eventType: row.event_type as MessageEventType,
    role: row.role as MessageRole,
    turnNo: row.turn_no,
    stepNo: row.step_no,
    content: parseJson(row.content_json, 'message.content'),
    source: row.source_json === null ? null : parseJson(row.source_json, 'message.source'),
    toolCallId: row.tool_call_id,
    usage: row.usage_json === null ? null : parseJson(row.usage_json, 'message.usage'),
    visibility: row.visibility as 'user' | 'internal',
    status: row.status as MessageStatus,
    extensions: parseObject(row.extensions, 'message.extensions'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapFile(row: ConversationFileRow): ConversationFile {
  return {
    fileId: row.file_id,
    userId: row.user_id,
    sessionId: row.session_id,
    objectId: row.object_id,
    originalName: row.original_name,
    mediaType: row.media_type,
    byteSize: row.byte_size,
    purpose: row.purpose,
    status: row.status as ConversationFile['status'],
    extensions: parseObject(row.extensions, 'file.extensions'),
    createdAt: row.created_at,
  }
}

function validId(value: string, name: string, max = 256): string {
  if (value.length === 0 || value.length > max) throw new Error(`${name} must contain 1-${max} characters`)
  return value
}

/** MySQL message-only persistence. Streaming chunks remain in the live Session only. */
export class MysqlConversationPersistence extends Service {
  static inject = ['mysql', 'users', 'fileStorage']
  static Config: z<Config> = z.object({
    userId: z.string().min(1).max(128).required(),
    maxFileBytes: z.number().step(1).min(1).default(50 * 1024 * 1024),
    spoolRoot: z.string(),
    spoolRetryMs: z.number().step(1).min(250).default(5000),
  })

  override readonly name: string = 'conversationPersistence'
  /** Authenticated user served by this plugin instance. */
  readonly userId: UserId
  /** Provider-neutral object store used for file bytes. */
  readonly fileStorage: FileObjectStore
  /** Maximum bytes accepted by {@link saveFile}. */
  readonly maxFileBytes: number
  /** Optional durable retry spool for failed message commits. */
  readonly spool: DurableMessageSpool | undefined
  private readonly ready: Promise<void>
  private runtimeConfigReady: Promise<void> = Promise.resolve()
  private runtimeConfigDisposer: (() => void) | undefined
  private defaultConversationTitle = DEFAULT_CONVERSATION_TITLE
  private readonly turnBuffers = new Map<string, AppendMessageInput[]>()
  private readonly sessionHeaders = new Map<string, SessionHeader>()
  private readonly writes = new Map<string, Promise<void>>()
  private readonly attemptBuffers = new Map<string, Map<string, ModelAttempt>>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'conversationPersistence')
    this.userId = brandUserId(config.userId)
    this.fileStorage = ctx.fileStorage
    this.maxFileBytes = config.maxFileBytes ?? 50 * 1024 * 1024
    const spoolRoot = config.spoolRoot ?? join(process.env.DSH_HOME ?? '.dsh', 'conversation-spool', 'v1')
    this.spool = new DurableMessageSpool(
      spoolRoot, String(this.userId), config.spoolRetryMs ?? 5000,
      task => this.persistTurn({
        id: SessionId(task.sessionId), version: SESSION_FORMAT_VERSION, userId: this.userId,
        createdAt: task.createdAt,
      }, task.messages, new Map(task.attempts.map(attempt => [`${attempt.turnNo}:${attempt.stepNo}`, attempt])), task.reason),
    )
    ctx.inject(['runtimeConfigs'], ({ runtimeConfigs }) => {
      const apply = (entry: { key: string; value: unknown }): void => {
        if (entry.key !== CONVERSATION_DEFAULT_TITLE_CONFIG_KEY || typeof entry.value !== 'string') return
        const title = entry.value.trim()
        if (title.length === 0 || title.length > 256) return
        this.defaultConversationTitle = title
      }
      this.runtimeConfigDisposer = runtimeConfigs.subscribe?.(apply)
      this.runtimeConfigReady = runtimeConfigs.get(CONVERSATION_DEFAULT_TITLE_CONFIG_KEY)
        .then((entry) => { if (entry !== undefined) apply(entry) })
        .catch(error => this.ctx.logger.warn(`conversation persistence: dynamic config load failed: ${String(error)}`))
    })
    this.ready = this.initialize()
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.scheduleEvent(session, event)
    })
    ctx.effect(() => async () => {
      await Promise.allSettled([...this.writes.values()])
      for (const [sessionId, messages] of this.turnBuffers) {
        if (messages.length === 0) continue
        const header = this.sessionHeaders.get(sessionId)
        if (header !== undefined) await this.persistTurn(header, messages)
      }
      await Promise.allSettled([...this.writes.values()])
      this.turnBuffers.clear()
      this.sessionHeaders.clear()
      this.attemptBuffers.clear()
      this.writes.clear()
      this.runtimeConfigDisposer?.()
      this.runtimeConfigDisposer = undefined
      await this.spool?.close()
    }, 'conversationPersistence lifecycle')
  }

  async [Service.init](): Promise<void> { await this.ready }

  private async initialize(): Promise<void> {
    await this.ctx.mysql.connection(connection => ensureSchema(connection))
    await this.ctx.users.requireActive(this.userId)
    await this.spool?.init()
  }

  /** Queue event projection work so one session's turns preserve event order. */
  private scheduleEvent(session: Session, event: SessionEvent): void {
    this.sessionHeaders.set(session.id, session.header)
    const previous = this.writes.get(session.id) ?? Promise.resolve()
    const next = previous.then(() => this.handleSessionEvent(session, event))
    const settled = next.then(() => undefined, (error) => {
      this.ctx.logger.warn(`conversation "${session.id}" projection failed: ${String(error)}`)
    })
    this.writes.set(session.id, settled)
    void settled.finally(() => {
      if (this.writes.get(session.id) === settled) this.writes.delete(session.id)
    })
  }

  /** Convert only durable surface messages and title events; raw chunks are ignored. */
  private async handleSessionEvent(session: Session, event: SessionEvent): Promise<void> {
    await this.ready
    const owner = session.header.userId
    if (owner === undefined || String(owner) !== String(this.userId)) return
    const rawEvent = event as unknown as { type: string; data: { title: string; source: { kind: string } } }
    if (rawEvent.type === 'session/title') {
      const source = rawEvent.data.source.kind
      await this.ensureConversation(session.header)
      await this.updateTitle(
        session.id,
        rawEvent.data.title,
        source === 'user' ? 'manual' : source === 'provider' ? 'generated' : 'fallback',
        source,
      )
      return
    }
    if (event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result') {
      const pending = this.turnBuffers.get(session.id) ?? []
      pending.push(this.messageFromEvent(event, session))
      this.turnBuffers.set(session.id, pending)
      if (event.type === 'assistant/message') {
        const attempt = this.attemptFromAssistant(event)
        const attempts = this.attemptBuffers.get(session.id) ?? new Map<string, ModelAttempt>()
        attempts.set(`${event.data.turn}:${event.data.step}`, attempt)
        this.attemptBuffers.set(session.id, attempts)
      }
      return
    }
    if (event.type === 'turn/end') {
      const pending = this.turnBuffers.get(session.id)
      if (pending === undefined || pending.length === 0) return
      this.turnBuffers.delete(session.id)
      if (event.data.reason.kind !== 'completed') {
        for (const message of pending) {
          if (message.eventType === 'assistant/message') message.status = 'partial'
        }
      }
      const attempts = this.attemptBuffers.get(session.id)
      this.attemptBuffers.delete(session.id)
      try {
        await this.persistTurn(session.header, pending, attempts, event.data.reason)
      } catch (error: unknown) {
        if (this.spool !== undefined) {
          await this.spool.enqueue({
            userId: String(this.userId), sessionId: session.id, messages: pending,
            attempts: attempts === undefined ? [] : [...attempts.values()], reason: event.data.reason,
          })
          this.ctx.logger.warn(`conversation "${session.id}" queued in durable message spool after MySQL failure: ${String(error)}`)
          return
        }
        throw error
      }
    }
  }

  private attemptFromAssistant(event: Extract<SessionEvent, { type: 'assistant/message' }>): ModelAttempt {
    const source = event.data.message.source
    const usage = event.data.usage ?? null
    const status = 'completed'
    return {
      attemptId: `attempt-${event.data.message.id}`,
      sessionId: '',
      turnNo: event.data.turn,
      stepNo: event.data.step,
      retryNo: 0,
      provider: source.provider,
      model: source.model,
      status,
      startedAt: event.time,
      firstTokenAt: event.time,
      finishedAt: event.time,
      finishReason: null,
      usage,
      finalMessageId: String(event.data.message.id),
      partialContent: null,
      errorCode: null,
      errorMessage: null,
      extensions: {},
    }
  }

  private messageFromEvent(
    event: Extract<SessionEvent, { type: 'user/message' | 'assistant/message' | 'tool/result' }>,
    session: Session,
  ): AppendMessageInput {
    if (event.type === 'user/message') {
      const step = session.events.findLast(item => item.type === 'step/start')
      const turn = session.events.findLast(item => item.type === 'turn/start')
      const source = event.data.source as UserMessage['source'] & { fileIds?: unknown }
      const fileIds = Array.isArray(source.fileIds)
        ? source.fileIds.filter((fileId): fileId is string => typeof fileId === 'string')
        : undefined
      return {
        messageId: String(event.data.id), eventType: event.type, role: 'user',
        turnNo: turn?.type === 'turn/start' ? turn.data.turn : 0,
        stepNo: step?.type === 'step/start' ? step.data.step : 0, content: event.data.content,
        source: event.data.source, visibility: event.data.source.kind === 'user' ? 'user' : 'internal',
        ...(fileIds === undefined || fileIds.length === 0 ? {} : { fileIds }),
      }
    }
    if (event.type === 'assistant/message') {
      return {
        messageId: String(event.data.message.id), eventType: event.type, role: 'assistant',
        turnNo: event.data.turn, stepNo: event.data.step, content: event.data.message.content,
        source: event.data.message.source, usage: event.data.usage ?? null,
      }
    }
    const source = event.data.message.source
    return {
      messageId: String(event.data.message.id), eventType: event.type, role: 'tool',
      turnNo: event.data.turn, stepNo: event.data.step, content: event.data.message.content,
      source, toolCallId: String(source.callId), status: event.data.error === undefined ? 'completed' : 'failed',
      visibility: 'internal', extensions: event.data.meta === undefined ? {} : { 'tool:meta': event.data.meta },
    }
  }

  private async persistTurn(
    header: SessionHeader,
    messages: readonly AppendMessageInput[],
    attempts?: ReadonlyMap<string, ModelAttempt>,
    reason?: { kind: string; error?: { code?: string; message?: string } },
  ): Promise<void> {
    const sessionId = String(header.id)
    await this.ensureConversation(header)
    await this.appendMessagesAtomic(sessionId, messages, attempts, reason)
  }

  /**
   * Wait until all event projections already admitted for one session settle.
   * @param sessionId Session whose pending projection writes should settle.
   */
  async flushSession(sessionId: string): Promise<void> {
    for (;;) {
      const pending = this.writes.get(sessionId)
      if (pending === undefined) break
      await pending
    }
    const buffered = this.turnBuffers.get(sessionId)
    if (buffered !== undefined && buffered.length > 0) {
      const header = this.sessionHeaders.get(sessionId)
      if (header !== undefined) {
        this.turnBuffers.delete(sessionId)
        const attempts = this.attemptBuffers.get(sessionId)
        this.attemptBuffers.delete(sessionId)
        await this.persistTurn(header, buffered, attempts, { kind: 'completed' })
      }
    }
  }

  /**
   * List model attempts belonging to one user-owned session.
   * @param sessionId Session to query.
   * @returns Attempts ordered by turn, step, and retry number.
   */
  async listAttempts(sessionId: string): Promise<ModelAttempt[]> {
    await this.ready
    const [rows] = await this.ctx.mysql.connection(connection => connection.query<Array<{
      attempt_id: string; session_id: string; turn_no: number; step_no: number; retry_no: number
      provider: string; model: string; status: ModelAttempt['status']; started_at: number
      first_token_at: number | null; finished_at: number | null; finish_reason: string | null
      usage_json: unknown; final_message_id: string | null; partial_content_json: unknown
      error_code: string | null; error_message: string | null; extensions: unknown
    } & import('mysql2').RowDataPacket>>(
      `SELECT a.* FROM ${ATTEMPTS_TABLE} a
       WHERE a.session_id = ? AND a.user_id = ? ORDER BY a.turn_no, a.step_no, a.retry_no`,
      [sessionId, this.userId],
    ))
    return rows.map(row => ({
      attemptId: row.attempt_id, sessionId: row.session_id, turnNo: row.turn_no, stepNo: row.step_no,
      retryNo: row.retry_no, provider: row.provider, model: row.model, status: row.status,
      startedAt: row.started_at, firstTokenAt: row.first_token_at, finishedAt: row.finished_at,
      finishReason: row.finish_reason, usage: row.usage_json === null ? null : parseJson(row.usage_json, 'attempt.usage'),
      finalMessageId: row.final_message_id, partialContent: row.partial_content_json === null ? null : parseJson(row.partial_content_json, 'attempt.partialContent'),
      errorCode: row.error_code, errorMessage: row.error_message, extensions: parseObject(row.extensions, 'attempt.extensions'),
    }))
  }

  /**
   * Read committed semantic outbox events for this user.
   * @param options Cursor and page-size options.
   * @returns A bounded page of outbox events.
   */
  async readOutbox(options: { afterSequence?: number; afterOccurredAt?: number; afterEventId?: string; limit?: number } = {}): Promise<ConversationOutboxEvent[]> {
    await this.ready
    const hasSequenceCursor = options.afterSequence !== undefined
    const afterSequence = Math.max(Math.trunc(options.afterSequence ?? -1), -1)
    const after = Math.max(Math.trunc(options.afterOccurredAt ?? -1), -1)
    const afterEventId = options.afterEventId ?? ''
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 1000)
    const [rows] = await this.ctx.mysql.connection(connection => connection.query<Array<{
      outbox_seq: number; outbox_id: string; schema_version: number; event_type: ConversationOutboxEvent['eventType']
      occurred_at: number; user_id: string; session_id: string; message_id: string | null
      aggregate_revision: number; payload_json: unknown; extensions: unknown
    } & import('mysql2').RowDataPacket>>(
      `SELECT * FROM ${OUTBOX_TABLE}
       WHERE user_id = ? AND ${hasSequenceCursor
          ? 'outbox_seq > ?'
          : '(occurred_at > ? OR (occurred_at = ? AND outbox_id > ?))'}
      ORDER BY ${hasSequenceCursor ? 'outbox_seq' : 'occurred_at, outbox_id'} LIMIT ?`,
      hasSequenceCursor
        ? [this.userId, afterSequence, limit]
        : [this.userId, after, after, afterEventId, limit],
    ))
    return rows.map(row => ({
      schemaVersion: row.schema_version, eventId: row.outbox_id, outboxSequence: row.outbox_seq,
      eventType: row.event_type, occurredAt: row.occurred_at, userId: row.user_id,
      sessionId: row.session_id, ...(row.message_id === null ? {} : { messageId: row.message_id }),
      aggregateRevision: row.aggregate_revision,
      payload: payloadObject(parseJson(row.payload_json, 'outbox.payload'), 'outbox.payload'),
      extensions: object(parseJson(row.extensions, 'outbox.extensions'), 'outbox.extensions'),
    }))
  }

  private async ensureConversation(header: SessionHeader): Promise<Conversation> {
    const sessionId = String(header.id)
    const existing = await this.getConversation(sessionId)
    if (existing !== undefined) return existing
    const parent = header.parentSession === undefined || await this.getConversation(String(header.parentSession)) !== undefined
      ? header.parentSession ?? null
      : null
    try {
      return await this.createConversation({
        sessionId, version: SESSION_FORMAT_VERSION, cwd: header.cwd ?? null, parentSessionId: parent,
        seedLength: header.seedLength ?? null, origin: header.origin ?? null,
        delegationDepth: header.delegationDepth ?? null, agentPreset: header.agentPreset ?? null,
        createdAt: header.createdAt,
      })
    } catch (error: unknown) {
      const retry = await this.getConversation(sessionId)
      if (retry !== undefined) return retry
      throw error
    }
  }

  /**
   * Create one user-owned conversation.
   * @param input Conversation metadata and optional title.
   * @returns The committed conversation row.
   */
  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    await this.ready
    await this.runtimeConfigReady
    validId(input.sessionId, 'sessionId')
    const now = input.createdAt ?? Date.now()
    const suppliedTitle = input.title?.trim()
    const usesDefaultTitle = suppliedTitle === undefined || suppliedTitle.length === 0
    const title = usesDefaultTitle ? this.defaultConversationTitle : suppliedTitle
    const titleStatus = input.titleStatus ?? 'fallback'
    const titleSource = input.titleSource ?? (usesDefaultTitle ? 'config' : titleStatus)
    const extensions = object(input.extensions ?? {}, 'conversation.extensions')
    await this.ctx.users.requireActive(this.userId)
    await this.ctx.mysql.transaction(async (connection) => {
      if (input.parentSessionId !== null && input.parentSessionId !== undefined) {
        const [parents] = await connection.query<ConversationRow[]>(
          `SELECT session_id FROM ${CONVERSATIONS_TABLE} WHERE session_id = ? AND user_id = ? FOR SHARE`,
          [input.parentSessionId, this.userId],
        )
        if (parents[0] === undefined) throw new Error(`parent conversation "${input.parentSessionId}" not found`)
      }
      await connection.query(
        `INSERT INTO ${CONVERSATIONS_TABLE}
         (session_id, version, user_id, title, title_status, title_source,
          title_revision, title_updated_at, status, cwd, parent_session_id, seed_length,
          origin, delegation_depth, agent_preset, incarnation, revision, next_message_ordinal,
          extensions, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'active', ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
        [input.sessionId, input.version ?? SESSION_FORMAT_VERSION, this.userId, title, titleStatus,
          titleSource, now, input.cwd ?? null, input.parentSessionId ?? null,
          input.seedLength ?? null, input.origin ?? null, input.delegationDepth ?? null,
          input.agentPreset ?? null, randomUUID(), JSON.stringify(extensions), now, now],
      )
    })
    const conversation = await this.getConversation(input.sessionId)
    if (conversation === undefined) throw new Error(`conversation "${input.sessionId}" disappeared after creation`)
    return conversation
  }

  /**
   * Read one user-owned conversation.
   * @param sessionId Conversation identifier.
   * @returns The conversation, or undefined when it is not owned by this user.
   */
  async getConversation(sessionId: string): Promise<Conversation | undefined> {
    await this.ready
    const [rows] = await this.ctx.mysql.connection(connection => connection.query<ConversationRow[]>(
      `SELECT * FROM ${CONVERSATIONS_TABLE} WHERE session_id = ? AND user_id = ?`,
      [sessionId, this.userId],
    ))
    return rows[0] === undefined ? undefined : mapConversation(rows[0])
  }

  /**
   * List this user's conversations.
   * @param options Deletion filter and pagination options.
   * @returns Conversations ordered by most recent update.
   */
  async listConversations(options: { includeDeleted?: boolean; limit?: number; offset?: number } = {}): Promise<Conversation[]> {
    await this.ready
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500)
    const offset = Math.max(Math.trunc(options.offset ?? 0), 0)
    const status = options.includeDeleted ? undefined : 'deleted'
    const [rows] = await this.ctx.mysql.connection(connection => connection.query<ConversationRow[]>(
      `SELECT * FROM ${CONVERSATIONS_TABLE}
       WHERE user_id = ? ${status === undefined ? '' : 'AND status <> ?'}
       ORDER BY updated_at DESC, session_id LIMIT ? OFFSET ?`,
      status === undefined ? [this.userId, limit, offset] : [this.userId, status, limit, offset],
    ))
    return rows.map(mapConversation)
  }

  /**
   * Read final semantic messages for one conversation.
   * @param sessionId Conversation identifier.
   * @param options Cursor and page-size options.
   * @returns Messages ordered by their conversation ordinal.
   */
  async readMessages(sessionId: string, options: { afterOrdinal?: number; limit?: number } = {}): Promise<ConversationMessage[]> {
    await this.ready
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 500), 1), 2000)
    const after = Math.max(Math.trunc(options.afterOrdinal ?? -1), -1)
    const [rows] = await this.ctx.mysql.connection(connection => connection.query<MessageRow[]>(
      `SELECT m.* FROM ${MESSAGES_TABLE} m
       WHERE m.session_id = ? AND m.user_id = ? AND m.ordinal > ? ORDER BY m.ordinal LIMIT ?`,
      [sessionId, this.userId, after, limit],
    ))
    return rows.map(mapMessage)
  }

  /**
   * Rebuild a compact, contiguous SessionEvent log from semantic rows. This
   * is intentionally a projection, not a token replay: assistant/chunk rows
   * are absent by construction and only final messages/tool results remain.
   * @param sessionId Conversation identifier.
   * @returns A restored header and message-only event list, or undefined when absent/deleted.
   */
  async hydrate(sessionId: string): Promise<HydratedSession | undefined> {
    const conversation = await this.getConversation(sessionId)
    if (conversation === undefined || conversation.status === 'deleted') return undefined
    const messages = await this.readMessages(sessionId, { limit: 2000 })
    const events: SessionEvent[] = []
    const append = (type: string, data: unknown, surface = false): void => {
      events.push({
        type, seq: events.length, time: Date.now(), data,
        ...(surface ? { surfaceOp: 'append' as const } : {}),
        ...(type === 'assistant/message' ? { sourceEventSeqs: [] } : {}),
      } as unknown as SessionEvent)
    }
    const byTurn = new Map<number, ConversationMessage[]>()
    for (const message of messages) {
      const bucket = byTurn.get(message.turnNo) ?? []
      bucket.push(message)
      byTurn.set(message.turnNo, bucket)
    }
    for (const [turnNo, turnMessages] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
      append('turn/start', { turn: turnNo })
      const byStep = new Map<number, ConversationMessage[]>()
      for (const message of turnMessages) {
        const bucket = byStep.get(message.stepNo) ?? []
        bucket.push(message)
        byStep.set(message.stepNo, bucket)
      }
      let interrupted = false
      for (const [stepNo, stepMessages] of [...byStep.entries()].sort((a, b) => a[0] - b[0])) {
        append('step/start', { turn: turnNo, step: stepNo })
        for (const message of stepMessages.sort((a, b) => a.ordinal - b.ordinal)) {
          const content = Array.isArray(message.content)
            ? message.content as ContentBlock[]
            : [{ type: 'text', text: JSON.stringify(message.content) } satisfies ContentBlock]
          if (message.status !== 'completed') interrupted = true
          if (message.eventType === 'user/message') {
            append('user/message', {
              id: MessageId(message.messageId), role: 'user', content,
              source: (message.source ?? { kind: 'user' }) as UserMessage['source'],
            } satisfies UserMessage, true)
          } else if (message.eventType === 'assistant/message') {
            const assistant = {
              id: MessageId(message.messageId), role: 'assistant', content,
              source: (message.source ?? { kind: 'model', provider: 'unknown', model: 'unknown' }) as AssistantMessage['source'],
            } satisfies AssistantMessage
            append('assistant/message', {
              turn: message.turnNo, step: message.stepNo, message: assistant,
              ...(message.usage === null ? {} : { usage: message.usage }),
            }, true)
            for (const block of content) {
              if (block.type !== 'tool-call') continue
              append('tool/call', {
                turn: message.turnNo, step: message.stepNo,
                callId: CallId(block.id), name: block.name, arguments: block.arguments,
              })
            }
          } else {
            const source = (message.source ?? { kind: 'tool', callId: message.toolCallId ?? 'unknown' }) as ToolResultMessage['source']
            const toolContent: ToolResultMessage['content'] = content.length === 1 && content[0]?.type === 'tool-result'
              ? content as ToolResultMessage['content']
              : [{
                type: 'tool-result', toolCallId: source.callId,
                content: content.length === 0 ? [{ type: 'text', text: JSON.stringify(message.content) }] : content,
                ...(message.status === 'failed' ? { isError: true } : {}),
              }]
            append('tool/result', {
              turn: message.turnNo, step: message.stepNo,
              message: {
                id: MessageId(message.messageId), role: 'user', content: toolContent,
                source,
              } satisfies ToolResultMessage,
              ...(message.status === 'failed' ? { error: { name: 'ToolError', code: 'TOOL_FAILED' } } : {}),
            }, true)
          }
        }
        append('step/end', { turn: turnNo, step: stepNo })
      }
      append('turn/end', { turn: turnNo, reason: interrupted ? { kind: 'interrupted' } : { kind: 'completed' } })
    }
    // A config-supplied placeholder is visible in the conversation list, but
    // must not become a durable Session title event. Keeping it out of the
    // restored event stream lets the title service derive a fallback from the
    // first user message and later replace it with an LLM-generated title.
    const isConfigPlaceholder = conversation.titleStatus === 'fallback'
      && conversation.titleSource === 'config'
    if (conversation.title.length > 0 && !isConfigPlaceholder) {
      const titleSource = conversation.titleStatus === 'manual'
        ? { kind: 'user' }
        : conversation.titleStatus === 'generated'
          ? { kind: 'provider', provider: conversation.titleSource }
          : { kind: 'fallback' }
      const messageSeqs = events.filter(event => event.type === 'user/message').map(event => event.seq)
      append('session/title', { title: conversation.title, messageSeqs, source: titleSource })
    }
    const meta: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: SessionId(conversation.sessionId),
      userId: brandUserId(conversation.userId),
      createdAt: conversation.createdAt,
      ...conversation.cwd === null ? {} : { cwd: conversation.cwd },
      ...conversation.parentSessionId === null ? {} : { parentSession: SessionId(conversation.parentSessionId) },
      ...conversation.seedLength === null ? {} : { seedLength: conversation.seedLength },
      ...conversation.origin === null ? {} : { origin: conversation.origin as 'subagent' },
      ...conversation.delegationDepth === null ? {} : { delegationDepth: conversation.delegationDepth },
      ...conversation.agentPreset === null ? {} : { agentPreset: conversation.agentPreset },
    }
    return { meta, events }
  }

  /**
   * Append one final semantic message.
   * @param sessionId Conversation identifier.
   * @param input Message and optional file links.
   * @returns The committed message row.
   */
  async appendMessage(sessionId: string, input: AppendMessageInput): Promise<ConversationMessage> {
    const messages = await this.appendMessages(sessionId, [input])
    return messages[0]!
  }

  /**
   * Append a final-message batch atomically.
   * @param sessionId Conversation identifier.
   * @param inputs Messages in their intended turn order.
   * @param expectedRevision Optional optimistic conversation revision.
   * @returns The committed message rows.
   */
  async appendMessages(sessionId: string, inputs: readonly AppendMessageInput[], expectedRevision?: number): Promise<ConversationMessage[]> {
    return this.appendMessagesAtomic(sessionId, inputs, undefined, undefined, expectedRevision)
  }

  /**
   * Commit final messages, model attempts, and semantic outbox records in one
   * transaction. The operation is idempotent by message id: a retry that sees
   * the complete batch already present returns without creating duplicate
   * attempts or outbox events. Streaming chunks never enter this path.
   */
  private async appendMessagesAtomic(
    sessionId: string,
    inputs: readonly AppendMessageInput[],
    attempts?: ReadonlyMap<string, ModelAttempt>,
    reason?: { kind: string; error?: { code?: string; message?: string } },
    expectedRevision?: number,
  ): Promise<ConversationMessage[]> {
    await this.ready
    if (inputs.length === 0) return []
    await this.ctx.users.requireActive(this.userId)
    const ids = new Set<string>()
    const prepared = inputs.map(input => ({ ...input, messageId: validId(input.messageId ?? randomUUID(), 'messageId', 128) }))
    for (const input of prepared) {
      const id = input.messageId
      if (ids.has(id)) throw new Error(`duplicate messageId "${id}" in batch`)
      ids.add(id)
      const expectedRole = input.eventType === 'user/message' ? 'user'
        : input.eventType === 'assistant/message' ? 'assistant' : 'tool'
      if (input.role !== expectedRole) throw new Error(`${input.eventType} requires role ${expectedRole}`)
      object(input.extensions ?? {}, 'message.extensions')
      json(input.content, 'message.content')
      if (input.source !== undefined && input.source !== null) json(input.source, 'message.source')
      if (input.usage !== undefined && input.usage !== null) json(input.usage, 'message.usage')
      if (input.fileIds !== undefined) {
        if (input.eventType !== 'user/message') throw new Error('fileIds can only be attached to user messages')
        if (input.fileIds.length > 64) throw new Error('a message cannot reference more than 64 files')
        const fileIds = new Set<string>()
        for (const fileId of input.fileIds) {
          const normalized = validId(fileId, 'fileId', 128)
          if (fileIds.has(normalized)) throw new Error(`duplicate fileId "${normalized}" in message`)
          fileIds.add(normalized)
        }
      }
    }
    const now = Date.now()
    await this.ctx.mysql.transaction(async (connection) => {
      const [rows] = await connection.query<ConversationRow[]>(
        `SELECT * FROM ${CONVERSATIONS_TABLE} WHERE session_id = ? AND user_id = ? FOR UPDATE`,
        [sessionId, this.userId],
      )
      const conversation = rows[0]
      if (conversation === undefined || conversation.status === 'deleted') throw new Error(`conversation "${sessionId}" not found`)
      if (expectedRevision !== undefined && conversation.revision !== expectedRevision) {
        throw new Error(`conversation "${sessionId}" revision conflict: expected ${expectedRevision}, got ${conversation.revision}`)
      }
      const [existingMessages] = await connection.query<MessageRow[]>(
        `SELECT * FROM ${MESSAGES_TABLE}
         WHERE session_id = ? AND user_id = ? AND message_id IN (${prepared.map(() => '?').join(',')})`,
        [sessionId, this.userId, ...prepared.map(input => input.messageId)],
      )
      if (existingMessages.length > 0) {
        if (existingMessages.length !== prepared.length) {
          throw new Error(`conversation "${sessionId}" message batch partially duplicates an existing message`)
        }
        const existingById = new Map(existingMessages.map(message => [message.message_id, message]))
        for (const input of prepared) {
          const existing = existingById.get(input.messageId)
          if (existing === undefined || existing.event_type !== input.eventType
            || existing.role !== input.role || json(parseJson(existing.content_json, 'message.content'), 'message.content') !== json(input.content, 'message.content')) {
            throw new Error(`conversation "${sessionId}" message "${input.messageId}" conflicts with an existing row`)
          }
        }
        return
      }
      let ordinal = conversation.next_message_ordinal
      for (const input of prepared) {
        const messageId = input.messageId
        await connection.query(
          `INSERT INTO ${MESSAGES_TABLE}
           (message_id, session_id, user_id, ordinal, event_type, role, turn_no, step_no,
            content_json, source_json, tool_call_id, usage_json, visibility, status,
            extensions, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [messageId, sessionId, this.userId, ordinal++, input.eventType, input.role, input.turnNo ?? 0,
            input.stepNo ?? 0, json(input.content, 'message.content'),
            input.source === undefined || input.source === null ? null : json(input.source, 'message.source'),
            input.toolCallId ?? null, input.usage === undefined || input.usage === null ? null : json(input.usage, 'message.usage'),
            input.visibility ?? 'user', input.status ?? 'completed',
            json(input.extensions ?? {}, 'message.extensions'), now, now],
        )
        if (input.fileIds !== undefined) {
          for (let fileOrdinal = 0; fileOrdinal < input.fileIds.length; fileOrdinal += 1) {
            const fileId = input.fileIds[fileOrdinal]!
            const [files] = await connection.query<ConversationFileRow[]>(
              `SELECT file_id FROM ${CONVERSATION_FILES_TABLE}
               WHERE file_id = ? AND session_id = ? AND user_id = ? AND status = 'ready' FOR SHARE`,
              [fileId, sessionId, this.userId],
            )
            if (files[0] === undefined) throw new Error(`file "${fileId}" not found`)
            await connection.query(
              `INSERT INTO ${MESSAGE_FILES_TABLE}
               (session_id, message_id, file_id, ordinal, relation, created_at)
               VALUES (?, ?, ?, ?, 'content', ?)`,
              [sessionId, messageId, fileId, fileOrdinal, now],
            )
          }
        }
      }
      await connection.query(
        `UPDATE ${CONVERSATIONS_TABLE} SET next_message_ordinal = ?, revision = revision + 1, updated_at = ?
         WHERE session_id = ? AND user_id = ?`,
        [ordinal, now, sessionId, this.userId],
      )

      const revision = conversation.revision + 1
      if (attempts !== undefined) {
        for (const attemptInput of attempts.values()) {
          const attempt: ModelAttempt = {
            ...attemptInput,
            sessionId,
            status: reason?.kind === 'completed' ? 'completed'
              : reason?.kind === 'aborted' || reason?.kind === 'interrupted' ? 'cancelled' : 'failed',
            finishedAt: now,
            finishReason: reason?.kind ?? attemptInput.finishReason,
            errorCode: reason?.error?.code ?? attemptInput.errorCode,
            errorMessage: reason?.error?.message ?? attemptInput.errorMessage,
          }
          await connection.query(
            `INSERT INTO ${ATTEMPTS_TABLE}
             (attempt_id, session_id, user_id, turn_no, step_no, retry_no, provider, model, status,
              started_at, first_token_at, finished_at, finish_reason, usage_json, final_message_id,
              partial_content_json, error_code, error_message, extensions)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE status = VALUES(status), finished_at = VALUES(finished_at),
               finish_reason = VALUES(finish_reason), usage_json = VALUES(usage_json),
               final_message_id = VALUES(final_message_id), partial_content_json = VALUES(partial_content_json),
               error_code = VALUES(error_code), error_message = VALUES(error_message)`,
            [attempt.attemptId, sessionId, this.userId, attempt.turnNo, attempt.stepNo, attempt.retryNo,
              attempt.provider, attempt.model, attempt.status, attempt.startedAt,
              attempt.firstTokenAt, attempt.finishedAt, attempt.finishReason,
              attempt.usage === null ? null : json(attempt.usage, 'attempt.usage'),
              attempt.finalMessageId, attempt.partialContent === null ? null : json(attempt.partialContent, 'attempt.partialContent'),
              attempt.errorCode, attempt.errorMessage, json(attempt.extensions, 'attempt.extensions')],
          )
        }
      }

      for (const input of prepared) {
        const outbox: ConversationOutboxEvent = {
          schemaVersion: 1,
          eventId: randomUUID(),
          eventType: 'conversation.message.committed',
          occurredAt: now,
          userId: String(this.userId),
          sessionId,
          messageId: input.messageId,
          aggregateRevision: revision,
          payload: { role: input.role, status: input.status ?? 'completed' },
          extensions: {},
        }
        await connection.query(
          `INSERT INTO ${OUTBOX_TABLE}
           (outbox_id, schema_version, event_type, aggregate_type, aggregate_id, user_id,
            session_id, message_id, aggregate_revision, payload_json, extensions, occurred_at)
           VALUES (?, ?, ?, 'conversation', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [outbox.eventId, outbox.schemaVersion, outbox.eventType, sessionId, this.userId,
            sessionId, input.messageId, outbox.aggregateRevision,
            json(outbox.payload, 'outbox.payload'), json(outbox.extensions, 'outbox.extensions'), now],
        )
      }
    })
    const [rows] = await this.ctx.mysql.connection(connection => connection.query<MessageRow[]>(
      `SELECT * FROM ${MESSAGES_TABLE}
       WHERE session_id = ? AND user_id = ? AND message_id IN (${prepared.map(() => '?').join(',')})`,
      [sessionId, this.userId, ...prepared.map(input => input.messageId)],
    ))
    const byId = new Map(rows.map(row => [row.message_id, mapMessage(row)]))
    return prepared.map((input) => {
      const message = byId.get(input.messageId)
      if (message === undefined) throw new Error(`message "${input.messageId}" disappeared after append`)
      return message
    })
  }

  /**
   * Update a conversation title and publish its semantic outbox event.
   * @param sessionId Conversation identifier.
   * @param title New title.
   * @param status Title state.
   * @param source Title source label.
   * @param expectedRevision Optional optimistic conversation revision.
   * @param expectedTitleRevision Optional optimistic title revision.
   * @returns The updated conversation row.
   */
  async updateTitle(
    sessionId: string,
    title: string,
    status: ConversationTitleStatus,
    source: string = status,
    expectedRevision?: number,
    expectedTitleRevision?: number,
  ): Promise<Conversation> {
    await this.ready
    validId(title, 'title', 256)
    await this.ctx.mysql.transaction(async (connection) => {
      const [rows] = await connection.query<ConversationRow[]>(
        `SELECT * FROM ${CONVERSATIONS_TABLE} WHERE session_id = ? AND user_id = ? FOR UPDATE`,
        [sessionId, this.userId],
      )
      const row = rows[0]
      if (row === undefined) throw new Error(`conversation "${sessionId}" not found`)
      if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new Error('conversation revision conflict')
      if (expectedTitleRevision !== undefined && row.title_revision !== expectedTitleRevision) {
        throw new Error('conversation title revision conflict')
      }
      if (row.title_status === 'manual' && status !== 'manual') return
      const now = Date.now()
      await connection.query(
        `UPDATE ${CONVERSATIONS_TABLE}
         SET title = ?, title_status = ?, title_source = ?, title_revision = title_revision + 1,
             title_updated_at = ?, revision = revision + 1, updated_at = ?
         WHERE session_id = ? AND user_id = ?`,
        [title, status, source, now, now, sessionId, this.userId],
      )
      const outbox: ConversationOutboxEvent = {
        schemaVersion: 1,
        eventId: randomUUID(),
        eventType: 'conversation.title.changed',
        occurredAt: now,
        userId: String(this.userId),
        sessionId,
        aggregateRevision: row.revision + 1,
        payload: { title, status, source },
        extensions: {},
      }
      await connection.query(
        `INSERT INTO ${OUTBOX_TABLE}
         (outbox_id, schema_version, event_type, aggregate_type, aggregate_id, user_id,
          session_id, message_id, aggregate_revision, payload_json, extensions, occurred_at)
         VALUES (?, ?, ?, 'conversation', ?, ?, ?, NULL, ?, ?, ?, ?)`,
        [outbox.eventId, outbox.schemaVersion, outbox.eventType, sessionId, this.userId,
          sessionId, outbox.aggregateRevision, json(outbox.payload, 'outbox.payload'),
          json(outbox.extensions, 'outbox.extensions'), now],
      )
    })
    const result = await this.getConversation(sessionId)
    if (result === undefined) throw new Error(`conversation "${sessionId}" not found`)
    return result
  }

  /**
   * Replace the conversation extension object.
   * @param sessionId Conversation identifier.
   * @param extensions JSON extension fields.
   * @param expectedRevision Optional optimistic conversation revision.
   * @returns The updated conversation row.
   */
  async updateExtensions(sessionId: string, extensions: JsonObject, expectedRevision?: number): Promise<Conversation> {
    await this.ready
    const encoded = json(object(extensions, 'conversation.extensions'), 'conversation.extensions')
    await this.ctx.mysql.transaction(async (connection) => {
      const [result] = await connection.query<ResultSetHeader>(
        `UPDATE ${CONVERSATIONS_TABLE} SET extensions = ?, revision = revision + 1, updated_at = ?
         WHERE session_id = ? AND user_id = ? ${expectedRevision === undefined ? '' : 'AND revision = ?'}`,
        expectedRevision === undefined ? [encoded, Date.now(), sessionId, this.userId] : [encoded, Date.now(), sessionId, this.userId, expectedRevision],
      )
      if (result.affectedRows === 0) throw new Error(`conversation "${sessionId}" not found or revision conflict`)
    })
    const result = await this.getConversation(sessionId)
    if (result === undefined) throw new Error(`conversation "${sessionId}" not found`)
    return result
  }

  /**
   * Publish file bytes through the independent file-storage service and commit metadata.
   * @param sessionId Conversation identifier.
   * @param input File metadata and bytes.
   * @returns The committed conversation-file metadata row.
   */
  async saveFile(sessionId: string, input: RegisterFileInput): Promise<ConversationFile> {
    await this.ready
    validId(input.originalName, 'originalName', 255)
    validId(input.mediaType, 'mediaType', 128)
    if (input.data.byteLength > this.maxFileBytes) throw new Error(`file exceeds ${this.maxFileBytes} bytes`)
    const published = await this.fileStorage.put(input.data, input.expectedSha256)
    const objectId = published.sha256
    const fileId = input.fileId ?? randomUUID()
    const now = Date.now()
    const extensions = json(object(input.extensions ?? {}, 'file.extensions'), 'file.extensions')
    await this.ctx.mysql.transaction(async (connection) => {
      const [conversations] = await connection.query<ConversationRow[]>(
        `SELECT session_id FROM ${CONVERSATIONS_TABLE} WHERE session_id = ? AND user_id = ? FOR SHARE`,
        [sessionId, this.userId],
      )
      if (conversations[0] === undefined) throw new Error(`conversation "${sessionId}" not found`)
      await connection.query(
        `INSERT INTO ${ATTACHMENT_OBJECTS_TABLE}
         (object_id, sha256, byte_size, media_type, storage_backend, storage_key, status, created_at, verified_at, extensions)
         VALUES (?, UNHEX(?), ?, ?, ?, ?, 'ready', ?, ?, '{}')
         ON DUPLICATE KEY UPDATE byte_size = VALUES(byte_size), media_type = VALUES(media_type),
           storage_backend = VALUES(storage_backend), storage_key = VALUES(storage_key),
           status = 'ready', verified_at = VALUES(verified_at)`,
        [objectId, published.sha256, published.byteSize, input.mediaType, published.storageBackend, published.storageKey, now, now],
      )
      await connection.query(
        `INSERT INTO ${CONVERSATION_FILES_TABLE}
         (file_id, user_id, session_id, object_id, original_name, media_type, byte_size, purpose, status, extensions, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
        [fileId, this.userId, sessionId, objectId, input.originalName, input.mediaType,
          published.byteSize, input.purpose ?? 'message', extensions, now],
      )
    })
    const file = await this.getFile(sessionId, fileId)
    if (file === undefined) throw new Error(`file "${fileId}" disappeared after creation`)
    return file
  }

  /**
   * Read one file metadata row owned by the current user.
   * @param sessionId Conversation identifier.
   * @param fileId File identifier.
   * @returns File metadata, or undefined when it is not owned by this user.
   */
  async getFile(sessionId: string, fileId: string): Promise<ConversationFile | undefined> {
    await this.ready
    const [rows] = await this.ctx.mysql.connection(connection => connection.query<ConversationFileRow[]>(
      `SELECT f.* FROM ${CONVERSATION_FILES_TABLE} f
       WHERE f.session_id = ? AND f.file_id = ? AND f.user_id = ?`,
      [sessionId, fileId, this.userId],
    ))
    return rows[0] === undefined ? undefined : mapFile(rows[0])
  }

  /**
   * List ready and quarantined file metadata for a conversation.
   * @param sessionId Conversation identifier.
   * @returns Files ordered by creation time.
   */
  async listFiles(sessionId: string): Promise<ConversationFile[]> {
    await this.ready
    const [rows] = await this.ctx.mysql.connection(connection => connection.query<ConversationFileRow[]>(
      `SELECT f.* FROM ${CONVERSATION_FILES_TABLE} f
       WHERE f.session_id = ? AND f.user_id = ? AND f.status <> 'deleted'
       ORDER BY f.created_at, f.file_id`, [sessionId, this.userId],
    ))
    return rows.map(mapFile)
  }

  /**
   * List files linked to one message.
   * @param sessionId Conversation identifier.
   * @param messageId Message identifier.
   * @returns Linked files in message ordinal order.
   */
  async listMessageFiles(sessionId: string, messageId: string): Promise<ConversationFile[]> {
    await this.ready
    const [rows] = await this.ctx.mysql.connection(connection => connection.query<ConversationFileRow[]>(
      `SELECT f.* FROM ${CONVERSATION_FILES_TABLE} f
       JOIN ${MESSAGE_FILES_TABLE} mf ON mf.file_id = f.file_id
       WHERE mf.session_id = ? AND mf.message_id = ? AND f.user_id = ?
       ORDER BY mf.ordinal`, [sessionId, messageId, this.userId],
    ))
    return rows.map(mapFile)
  }

  /**
   * Read file metadata and verified bytes.
   * @param sessionId Conversation identifier.
   * @param fileId File identifier.
   * @param signal Optional cancellation signal.
   * @returns Metadata and bytes from the independent file-storage service.
   */
  async readFile(sessionId: string, fileId: string, signal?: AbortSignal): Promise<{ metadata: ConversationFile; data: Buffer }> {
    signal?.throwIfAborted()
    const metadata = await this.getFile(sessionId, fileId)
    if (metadata === undefined) throw new Error(`file "${fileId}" not found`)
    const [rows] = await this.ctx.mysql.connection(connection => connection.query<Array<{ sha256: Buffer | string; storage_key: string } & import('mysql2').RowDataPacket>>(
      `SELECT o.sha256, o.storage_key FROM ${ATTACHMENT_OBJECTS_TABLE} o WHERE o.object_id = ? AND o.status = 'ready'`,
      [metadata.objectId],
    ))
    const row = rows[0]
    if (row === undefined) throw new Error(`file object "${metadata.objectId}" not found`)
    const sha256 = Buffer.isBuffer(row.sha256) ? row.sha256.toString('hex') : String(row.sha256)
    return { metadata, data: await this.fileStorage.get(row.storage_key, sha256, signal) }
  }

  /**
   * Link existing user-owned files to one message.
   * @param sessionId Conversation identifier.
   * @param messageId Message identifier.
   * @param fileIds File identifiers in display order.
   * @param relation Semantic relation label.
   */
  async linkMessageFiles(sessionId: string, messageId: string, fileIds: readonly string[], relation: string = 'content'): Promise<void> {
    await this.ready
    if (fileIds.length === 0) return
    await this.ctx.mysql.transaction(async (connection) => {
      const [messageRows] = await connection.query<MessageRow[]>(
        `SELECT message_id FROM ${MESSAGES_TABLE}
         WHERE message_id = ? AND session_id = ? AND user_id = ?`, [messageId, sessionId, this.userId],
      )
      if (messageRows[0] === undefined) throw new Error(`message "${messageId}" not found`)
      for (let ordinal = 0; ordinal < fileIds.length; ordinal += 1) {
        const [files] = await connection.query<ConversationFileRow[]>(
          `SELECT file_id FROM ${CONVERSATION_FILES_TABLE} WHERE file_id = ? AND session_id = ? AND user_id = ? AND status = 'ready'`,
          [fileIds[ordinal], sessionId, this.userId],
        )
        if (files[0] === undefined) throw new Error(`file "${fileIds[ordinal]}" not found`)
        await connection.query(
          `INSERT INTO ${MESSAGE_FILES_TABLE} (session_id, message_id, file_id, ordinal, relation, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`, [sessionId, messageId, fileIds[ordinal], ordinal, relation, Date.now()],
        )
      }
    })
  }
}

/** MySQL-backed runtime configuration store for title and other dynamic knobs. */
export class MysqlRuntimeConfigStore extends Service {
  static inject = ['mysql']
  override readonly name: string = 'runtimeConfigs'
  private readonly ready: Promise<void>
  private readonly listeners = new Set<RuntimeConfigListener>()

  constructor(ctx: Context) {
    super(ctx, 'runtimeConfigs')
    this.ready = ctx.mysql.connection(connection => ensureSchema(connection))
    ctx.effect(() => () => this.listeners.clear(), 'runtimeConfigs lifecycle')
  }

  async [Service.init](): Promise<void> { await this.ready }

  /**
   * Read one active runtime configuration value.
   * @param key Configuration key.
   * @returns The active value, or undefined when absent.
   */
  async get(key: string): Promise<RuntimeConfig | undefined> {
    await this.ready
    const [rows] = await this.ctx.mysql.connection(connection => connection.query<import('mysql2').RowDataPacket[]>(
      `SELECT * FROM ${CONFIG_TABLE} WHERE config_key = ? AND status = 'active'`, [key],
    ))
    const row = rows[0] as (import('mysql2').RowDataPacket & { config_key: string; value_json: unknown; value_type: string; schema_version: number; description: string; status: 'active' | 'disabled'; revision: number; updated_by: string | null; extensions: unknown; created_at: number; updated_at: number }) | undefined
    if (row === undefined) return undefined
    let value: JsonValue
    if (typeof row.value_json !== 'string') value = row.value_json
    else {
      try { value = JSON.parse(row.value_json) as JsonValue } catch {
        // mysql2 may return a JSON scalar string without its JSON quotes.
        value = row.value_json
      }
    }
    return { key: row.config_key, value, valueType: row.value_type, schemaVersion: row.schema_version, description: row.description, status: row.status, revision: row.revision, updatedBy: row.updated_by, extensions: parseObject(row.extensions, `${key}.extensions`), createdAt: row.created_at, updatedAt: row.updated_at }
  }

  /**
   * Create or update one runtime configuration value.
   * @param input Configuration value and optional optimistic revision.
   * @returns The committed configuration row.
   */
  async set(input: RuntimeConfigInput): Promise<RuntimeConfig> {
    await this.ready
    validId(input.key, 'config key', 128)
    const now = Date.now()
    const extensions = json(object(input.extensions ?? {}, 'config.extensions'), 'config.extensions')
    const value = json(input.value, 'config.value')
    await this.ctx.mysql.transaction(async (connection) => {
      const [current] = await connection.query<Array<{ revision: number } & import('mysql2').RowDataPacket>>(
        `SELECT revision FROM ${CONFIG_TABLE} WHERE config_key = ? FOR UPDATE`, [input.key],
      )
      const row = current[0]
      if (input.expectedRevision !== undefined && (row === undefined || row.revision !== input.expectedRevision)) {
        throw new Error(`config "${input.key}" revision conflict`)
      }
      if (row === undefined) {
        await connection.query(
          `INSERT INTO ${CONFIG_TABLE}
           (config_key, value_json, value_type, schema_version, description, status, revision, updated_by, extensions, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)`,
          [input.key, value, input.valueType ?? typeof input.value, input.schemaVersion ?? 1,
            input.description ?? '', input.updatedBy ?? null, extensions, now, now],
        )
      } else {
        await connection.query(
          `UPDATE ${CONFIG_TABLE}
           SET value_json = ?, value_type = ?, schema_version = ?, description = ?, status = 'active',
               revision = revision + 1, updated_by = ?, extensions = ?, updated_at = ?
           WHERE config_key = ?`,
          [value, input.valueType ?? typeof input.value, input.schemaVersion ?? 1, input.description ?? '',
            input.updatedBy ?? null, extensions, now, input.key],
        )
      }
    })
    const result = await this.get(input.key)
    if (result === undefined) throw new Error(`config "${input.key}" disappeared after update`)
    for (const listener of this.listeners) {
      try { listener(result) } catch (error: unknown) { this.ctx.logger.warn(`runtime config listener failed: ${String(error)}`) }
    }
    return result
  }

  /**
   * Subscribe to committed config changes; callers own the returned disposer.
   * @param listener Callback invoked after a configuration commit.
   * @returns A disposer that removes the listener.
   */
  subscribe(listener: RuntimeConfigListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

export default MysqlConversationPersistence
