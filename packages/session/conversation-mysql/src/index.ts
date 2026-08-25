/** MySQL Provider for permanent semantic conversations and projections. @module @deepseek-ai/dsh-conversation-mysql */

import { createHash } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import ConversationService, {
  ConversationError,
  agentRecordId,
  conversationId,
  conversationMessageId,
  conversationSessionId,
  conversationTenantId,
  conversationUserId,
  delegationId,
  type AgentRecord,
  type AgentRecordAppendCommit,
  type AgentRecordAppendRequest,
  type AgentRecordListQuery,
  type AgentRecordPage,
  type Conversation,
  type ConversationAttachment,
  type ConversationCreateInput,
  type ConversationExtensions,
  type ConversationIdentity,
  type ConversationListQuery,
  type ConversationMessage,
  type ConversationMessageListQuery,
  type ConversationMessagePage,
  type ConversationPage,
  type ConversationStatus,
  type SubagentRun,
  type SubagentRunListQuery,
  type SubagentRunPage,
} from '@deepseek-ai/dsh-conversation'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { decodeCursor, encodeCursor } from './cursor.ts'
import { initializeSchema } from './schema.ts'

export { CONVERSATION_MYSQL_SCHEMA_VERSION } from './schema.ts'

const INSERT_BATCH_SIZE = 64
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 1_000
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
type SqlValue = number | string | null

interface ConversationRow extends RowDataPacket {
  tenant_id: string
  user_id: string
  conversation_id: string
  session_id: string
  parent_conversation_id: string | null
  origin: Conversation['origin']
  delegation_depth: number | string
  title: string | null
  status: ConversationStatus
  revision: number | string
  next_sequence: number | string
  retention: unknown
  created_at: string
  updated_at: string
  extensions: unknown
}

interface RecordRow extends RowDataPacket {
  sequence: number | string
  source_seq: number | string
  record_id: string
  group_hash: string
  record_json: unknown
}

interface MessageRow extends RowDataPacket {
  tenant_id: string
  user_id: string
  conversation_id: string
  message_id: string
  ordinal: number | string
  revision: number | string
  status: ConversationMessage['status']
  visibility: ConversationMessage['visibility']
  role: ConversationMessage['role']
  visible_text: string
  occurred_at: string
  extensions: unknown
}

interface RunRow extends RowDataPacket {
  tenant_id: string
  user_id: string
  delegation_id: string
  parent_conversation_id: string
  child_conversation_id: string
  task_record_id: string
  status: SubagentRun['status']
  result_record_id: string | null
  started_at: string
  completed_at: string | null
  extensions: unknown
}

const CONVERSATION_COLUMNS = `tenant_id, user_id, conversation_id, session_id, parent_conversation_id,
  origin, delegation_depth, title, status, revision, next_sequence, retention, created_at, updated_at, extensions`

function unavailable(message: string, cause?: unknown): ConversationError {
  return new ConversationError('provider-unavailable', `conversation-mysql: ${message}`, cause === undefined ? undefined : { cause })
}

function safeInteger(value: number | string, field: string): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw unavailable(`invalid stored ${field}`)
  return numeric
}

function parseJson(value: unknown, field: string): unknown {
  try {
    return typeof value === 'string' ? JSON.parse(value) as unknown : value
  } catch (cause) {
    throw unavailable(`invalid stored ${field}`, cause)
  }
}

function timestamp(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new ConversationError('record-conflict', 'conversation-mysql: timestamp is invalid')
  return new Date(value).toISOString()
}

function parseTimestamp(value: string, field: string): number {
  const numeric = Date.parse(value)
  if (!ISO_UTC_RE.test(value) || !Number.isSafeInteger(numeric) || new Date(numeric).toISOString() !== value) {
    throw unavailable(`invalid stored ${field}`)
  }
  return numeric
}

function fromConversationRow(row: ConversationRow): Conversation {
  const retention = parseJson(row.retention, 'retention') as Conversation['retention']
  if (retention.kind !== 'permanent') throw unavailable('non-permanent retention in V1 row')
  return {
    tenantId: conversationTenantId(row.tenant_id),
    userId: conversationUserId(row.user_id),
    conversationId: conversationId(row.conversation_id),
    sessionId: conversationSessionId(row.session_id),
    ...(row.parent_conversation_id === null ? {} : { parentConversationId: conversationId(row.parent_conversation_id) }),
    origin: row.origin,
    delegationDepth: safeInteger(row.delegation_depth, 'delegation_depth'),
    ...(row.title === null ? {} : { title: row.title }),
    status: row.status,
    revision: safeInteger(row.revision, 'revision'),
    nextSequence: safeInteger(row.next_sequence, 'next_sequence'),
    retention,
    createdAt: parseTimestamp(row.created_at, 'created_at'),
    updatedAt: parseTimestamp(row.updated_at, 'updated_at'),
    extensions: parseJson(row.extensions, 'extensions') as ConversationExtensions,
  }
}

function fromRecordRow(row: RecordRow): AgentRecord {
  const record = parseJson(row.record_json, 'record_json') as AgentRecord
  if (record.sequence !== safeInteger(row.sequence, 'record sequence')
    || record.sourceSequence !== safeInteger(row.source_seq, 'source sequence')
    || record.recordId !== row.record_id) throw unavailable('record columns differ from record_json')
  return record
}

function fromMessageRow(row: MessageRow): ConversationMessage {
  return {
    tenantId: conversationTenantId(row.tenant_id),
    userId: conversationUserId(row.user_id),
    conversationId: conversationId(row.conversation_id),
    messageId: conversationMessageId(row.message_id),
    ordinal: safeInteger(row.ordinal, 'message ordinal'),
    revision: safeInteger(row.revision, 'message revision'),
    status: row.status,
    visibility: row.visibility,
    role: row.role,
    visibleText: row.visible_text,
    occurredAt: parseTimestamp(row.occurred_at, 'message occurred_at'),
    extensions: parseJson(row.extensions, 'message extensions') as ConversationExtensions,
  }
}

function fromRunRow(row: RunRow): SubagentRun {
  return {
    tenantId: conversationTenantId(row.tenant_id),
    userId: conversationUserId(row.user_id),
    delegationId: delegationId(row.delegation_id),
    parentConversationId: conversationId(row.parent_conversation_id),
    childConversationId: conversationId(row.child_conversation_id),
    taskRecordId: agentRecordId(row.task_record_id),
    status: row.status,
    ...(row.result_record_id === null ? {} : { resultRecordId: agentRecordId(row.result_record_id) }),
    startedAt: parseTimestamp(row.started_at, 'subagent started_at'),
    ...(row.completed_at === null ? {} : { completedAt: parseTimestamp(row.completed_at, 'subagent completed_at') }),
    extensions: parseJson(row.extensions, 'subagent extensions') as ConversationExtensions,
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item ?? null)).join(',')}]`
  const fields = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

function recordGroups(records: readonly AgentRecord[]): Map<number, { hash: string; records: readonly AgentRecord[] }> {
  const groups = new Map<number, AgentRecord[]>()
  for (const record of records) {
    const values = groups.get(record.sourceSequence) ?? []
    values.push(record)
    groups.set(record.sourceSequence, values)
  }
  return new Map([...groups].map(([source, values]) => [source, {
    hash: createHash('sha256').update(canonicalJson(values)).digest('hex'),
    records: values,
  }]))
}

function queryLimit(value?: number): number {
  const limit = value ?? DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ConversationError('invalid-input', `conversation-mysql: limit must be between 1 and ${String(MAX_LIMIT)}`)
  }
  return limit
}

function ownerKey(value: { tenantId: string; userId: string }): string {
  return canonicalJson([value.tenantId, value.userId])
}

function identityKey(value: ConversationIdentity): string {
  return canonicalJson([value.tenantId, value.userId, value.conversationId])
}

function hasMysqlCode(cause: unknown, code: string): boolean {
  return (cause as { code?: unknown } | null)?.code === code
}

async function rollback(connection: MysqlConnection, cause: unknown): Promise<never> {
  try {
    await connection.rollback()
  } catch (rollbackCause) {
    throw unavailable('transaction rollback failed', new AggregateError([cause, rollbackCause]))
  }
  if (cause instanceof ConversationError) throw cause
  throw unavailable('transaction failed', cause)
}

async function transaction<T>(connection: MysqlConnection, callback: () => Promise<T>): Promise<T> {
  await connection.beginTransaction()
  try {
    const result = await callback()
    await connection.commit()
    return result
  } catch (cause) {
    return rollback(connection, cause)
  }
}

/** Permanent semantic conversation Provider backed by `ctx.mysql`. */
export class ConversationMysql extends ConversationService {
  static inject = ['mysql']

  /** Initialize and verify the Provider-owned schema. */
  async [Service.init](): Promise<void> {
    await this.storage(initializeSchema)
  }

  async attach(input: ConversationAttachment): Promise<Conversation> {
    return this.storage(connection => transaction(connection, async () => {
      const existing = await this.bySession(connection, input.sessionId, true)
      if (existing !== undefined) {
        const ownerMatches = input.origin === 'subagent'
          || (existing.tenantId === input.tenantId && existing.userId === input.userId)
        if (!ownerMatches || existing.conversationId !== input.conversationId) {
          throw new ConversationError('conversation-conflict', 'conversation-mysql: Session is attached elsewhere')
        }
        return existing
      }
      let creation: ConversationCreateInput
      if (input.origin === 'subagent') {
        const parent = await this.bySession(connection, input.parentSessionId, true)
        if (parent === undefined) {
          throw new ConversationError('conversation-not-found', 'conversation-mysql: parent Session is not attached')
        }
        creation = {
          ...input,
          tenantId: parent.tenantId,
          userId: parent.userId,
          parentConversationId: parent.conversationId,
        }
      } else {
        creation = input
      }
      return this.insertConversation(connection, creation)
    }))
  }

  async create(input: ConversationCreateInput): Promise<Conversation> {
    return this.storage(connection => transaction(connection, () => this.insertConversation(connection, input)))
  }

  async get(identity: ConversationIdentity): Promise<Conversation | undefined> {
    return this.storage(async (connection) => {
      const [rows] = await connection.execute<ConversationRow[]>(
        `SELECT ${CONVERSATION_COLUMNS} FROM dsh_conversations
         WHERE tenant_id = ? AND user_id = ? AND conversation_id = ?`,
        [identity.tenantId, identity.userId, identity.conversationId],
      )
      return rows[0] === undefined ? undefined : fromConversationRow(rows[0])
    })
  }

  async append(request: AgentRecordAppendRequest): Promise<AgentRecordAppendCommit> {
    return this.storage(connection => transaction(connection, async () => {
      const current = await this.lockConversation(connection, request)
      if (current === undefined) {
        throw new ConversationError('conversation-not-found', 'conversation-mysql: conversation was not found')
      }
      this.validateAppend(request)
      const retry = await this.exactRetry(connection, current, request)
      if (retry !== undefined) return retry
      if (request.expectedNextSequence !== current.nextSequence) {
        throw new ConversationError('sequence-conflict', 'conversation-mysql: next sequence changed')
      }

      const groups = recordGroups(request.records)
      await this.insertRecords(connection, current, request.records, groups)
      await this.projectMessages(connection, current, request.records)
      await this.projectSubagents(connection, request.records)
      const updatedAt = timestamp(Math.max(Date.now(), current.updatedAt))
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE dsh_conversations SET revision = revision + 1, next_sequence = next_sequence + ?, updated_at = ?
         WHERE tenant_id = ? AND user_id = ? AND conversation_id = ? AND revision = ? AND next_sequence = ?`,
        [request.records.length, updatedAt, request.tenantId, request.userId, request.conversationId,
          current.revision, current.nextSequence],
      )
      if (updated.affectedRows !== 1) throw unavailable('locked conversation did not advance')
      const conversation: Conversation = {
        ...current,
        revision: current.revision + 1,
        nextSequence: current.nextSequence + request.records.length,
        updatedAt: parseTimestamp(updatedAt, 'updated_at'),
      }
      return { conversation, records: structuredClone(request.records) }
    }))
  }

  async list(query: ConversationListQuery): Promise<ConversationPage> {
    const limit = queryLimit(query.limit)
    const scope = canonicalJson([ownerKey(query), query.status ?? null])
    const after = decodeCursor(query.cursor, 'conversations', scope)
    if (after !== undefined && typeof after !== 'string') throw new ConversationError('invalid-input', 'conversation-mysql: cursor key is invalid')
    const clauses = ['tenant_id = ?', 'user_id = ?']
    const parameters: SqlValue[] = [query.tenantId, query.userId]
    if (query.status !== undefined) { clauses.push('status = ?'); parameters.push(query.status) }
    if (after !== undefined) { clauses.push('conversation_id > ?'); parameters.push(after) }
    return this.storage(async (connection) => {
      const [rows] = await connection.execute<ConversationRow[]>(
        `SELECT ${CONVERSATION_COLUMNS} FROM dsh_conversations WHERE ${clauses.join(' AND ')}
         ORDER BY conversation_id ASC LIMIT ${String(limit + 1)}`, parameters,
      )
      const conversations = rows.slice(0, limit).map(fromConversationRow)
      const last = conversations.at(-1)
      return {
        conversations,
        ...(rows.length > limit && last !== undefined
          ? { nextCursor: encodeCursor({ kind: 'conversations', scope, after: String(last.conversationId) }) }
          : {}),
      }
    })
  }

  async records(query: AgentRecordListQuery): Promise<AgentRecordPage> {
    const limit = queryLimit(query.limit)
    const types = query.types === undefined ? undefined : [...new Set(query.types)].sort()
    const scope = canonicalJson([identityKey(query), types ?? null])
    const after = decodeCursor(query.cursor, 'records', scope)
    if (after !== undefined && (typeof after !== 'number' || !Number.isSafeInteger(after))) {
      throw new ConversationError('invalid-input', 'conversation-mysql: cursor key is invalid')
    }
    return this.storage(async (connection) => {
      const conversation = await this.requireConversation(connection, query)
      const clauses = ['tenant_id = ?', 'user_id = ?', 'conversation_id = ?']
      const parameters: SqlValue[] = [query.tenantId, query.userId, query.conversationId]
      if (types !== undefined) {
        if (types.length === 0) return { records: [] }
        clauses.push(`record_type IN (${types.map(() => '?').join(', ')})`)
        parameters.push(...types)
      }
      if (after !== undefined) { clauses.push('sequence > ?'); parameters.push(after) }
      const [rows] = await connection.execute<RecordRow[]>(
        `SELECT sequence, source_seq, record_id, group_hash, record_json FROM dsh_agent_records
         WHERE ${clauses.join(' AND ')} ORDER BY sequence ASC LIMIT ${String(limit + 1)}`, parameters,
      )
      const records = rows.slice(0, limit).map(fromRecordRow)
      const last = records.at(-1)
      void conversation
      return {
        records,
        ...(rows.length > limit && last !== undefined
          ? { nextCursor: encodeCursor({ kind: 'records', scope, after: last.sequence }) }
          : {}),
      }
    })
  }

  async messages(query: ConversationMessageListQuery): Promise<ConversationMessagePage> {
    const limit = queryLimit(query.limit)
    const scope = canonicalJson([identityKey(query), query.visibility ?? null])
    const after = decodeCursor(query.cursor, 'messages', scope)
    if (after !== undefined && (typeof after !== 'number' || !Number.isSafeInteger(after))) {
      throw new ConversationError('invalid-input', 'conversation-mysql: cursor key is invalid')
    }
    return this.storage(async (connection) => {
      const conversation = await this.requireConversation(connection, query)
      const clauses = ['m.tenant_id = ?', 'm.user_id = ?', 'm.session_id = ?']
      const parameters: SqlValue[] = [query.tenantId, query.userId, conversation.sessionId]
      if (query.visibility !== undefined) { clauses.push('m.visibility = ?'); parameters.push(query.visibility) }
      if (after !== undefined) { clauses.push('s.ordinal > ?'); parameters.push(after) }
      const [rows] = await connection.execute<MessageRow[]>(
        `SELECT m.tenant_id, m.user_id, s.conversation_id, m.message_id, s.ordinal, m.revision,
          m.status, m.visibility, m.role, m.visible_text, m.occurred_at, s.extensions
         FROM dsh_conversation_messages m
         INNER JOIN dsh_conversation_message_state s
           ON s.tenant_id = m.tenant_id AND s.user_id = m.user_id AND s.session_id = m.session_id
             AND s.message_id = m.message_id
         WHERE ${clauses.join(' AND ')} ORDER BY s.ordinal ASC LIMIT ${String(limit + 1)}`, parameters,
      )
      const messages = rows.slice(0, limit).map(fromMessageRow)
      const last = messages.at(-1)
      return {
        messages,
        ...(rows.length > limit && last !== undefined
          ? { nextCursor: encodeCursor({ kind: 'messages', scope, after: last.ordinal }) }
          : {}),
      }
    })
  }

  async subagents(query: SubagentRunListQuery): Promise<SubagentRunPage> {
    const limit = queryLimit(query.limit)
    const scope = canonicalJson([identityKey(query), query.status ?? null])
    const after = decodeCursor(query.cursor, 'subagents', scope)
    if (after !== undefined && typeof after !== 'string') throw new ConversationError('invalid-input', 'conversation-mysql: cursor key is invalid')
    return this.storage(async (connection) => {
      await this.requireConversation(connection, query)
      const clauses = ['tenant_id = ?', 'user_id = ?', 'parent_conversation_id = ?']
      const parameters: SqlValue[] = [query.tenantId, query.userId, query.conversationId]
      if (query.status !== undefined) { clauses.push('status = ?'); parameters.push(query.status) }
      if (after !== undefined) { clauses.push('delegation_id > ?'); parameters.push(after) }
      const [rows] = await connection.execute<RunRow[]>(
        `SELECT tenant_id, user_id, delegation_id, parent_conversation_id, child_conversation_id,
          task_record_id, status, result_record_id, started_at, completed_at, extensions
         FROM dsh_subagent_runs WHERE ${clauses.join(' AND ')} ORDER BY delegation_id ASC LIMIT ${String(limit + 1)}`, parameters,
      )
      const runs = rows.slice(0, limit).map(fromRunRow)
      const last = runs.at(-1)
      return {
        runs,
        ...(rows.length > limit && last !== undefined
          ? { nextCursor: encodeCursor({ kind: 'subagents', scope, after: String(last.delegationId) }) }
          : {}),
      }
    })
  }

  private async storage<T>(callback: (connection: MysqlConnection) => Promise<T>): Promise<T> {
    try {
      return await this.ctx.mysql.connection(callback)
    } catch (cause) {
      if (cause instanceof ConversationError) throw cause
      throw unavailable('storage operation failed', cause)
    }
  }

  private async insertConversation(connection: MysqlConnection, input: ConversationCreateInput): Promise<Conversation> {
    if (input.retention !== undefined && input.retention.kind !== 'permanent') {
      throw new ConversationError('invalid-input', 'conversation-mysql: V1 retention must be permanent')
    }
    if (input.origin === 'subagent' && input.parentConversationId === undefined) {
      throw new ConversationError('invalid-input', 'conversation-mysql: subagent conversation requires a parent')
    }
    const now = Date.now()
    const value: Conversation = {
      ...input,
      status: 'active',
      revision: 1,
      nextSequence: 1,
      retention: { kind: 'permanent' },
      createdAt: now,
      updatedAt: now,
      extensions: input.extensions ?? {},
    }
    try {
      await connection.execute(
        `INSERT INTO dsh_conversations
          (tenant_id, user_id, conversation_id, session_id, parent_conversation_id, origin, delegation_depth,
           title, status, revision, next_sequence, retention, created_at, updated_at, extensions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, 1, ?, ?, ?, ?)`,
        [value.tenantId, value.userId, value.conversationId, value.sessionId, value.parentConversationId ?? null,
          value.origin, value.delegationDepth, value.title ?? null, canonicalJson(value.retention), timestamp(now),
          timestamp(now), canonicalJson(value.extensions)],
      )
    } catch (cause) {
      if (hasMysqlCode(cause, 'ER_DUP_ENTRY')) {
        throw new ConversationError('conversation-conflict', 'conversation-mysql: conversation or Session already exists', { cause })
      }
      throw cause
    }
    return value
  }

  private async bySession(connection: MysqlConnection, sessionId: string, lock: boolean): Promise<Conversation | undefined> {
    const [rows] = await connection.execute<ConversationRow[]>(
      `SELECT ${CONVERSATION_COLUMNS} FROM dsh_conversations WHERE session_id = ?${lock ? ' FOR UPDATE' : ''}`,
      [sessionId],
    )
    return rows[0] === undefined ? undefined : fromConversationRow(rows[0])
  }

  private async requireConversation(connection: MysqlConnection, identity: ConversationIdentity): Promise<Conversation> {
    const [rows] = await connection.execute<ConversationRow[]>(
      `SELECT ${CONVERSATION_COLUMNS} FROM dsh_conversations
       WHERE tenant_id = ? AND user_id = ? AND conversation_id = ?`,
      [identity.tenantId, identity.userId, identity.conversationId],
    )
    if (rows[0] === undefined) throw new ConversationError('conversation-not-found', 'conversation-mysql: conversation was not found')
    return fromConversationRow(rows[0])
  }

  private async lockConversation(connection: MysqlConnection, identity: ConversationIdentity): Promise<Conversation | undefined> {
    const [rows] = await connection.execute<ConversationRow[]>(
      `SELECT ${CONVERSATION_COLUMNS} FROM dsh_conversations
       WHERE tenant_id = ? AND user_id = ? AND conversation_id = ? FOR UPDATE`,
      [identity.tenantId, identity.userId, identity.conversationId],
    )
    return rows[0] === undefined ? undefined : fromConversationRow(rows[0])
  }

  private validateAppend(request: AgentRecordAppendRequest): void {
    if (request.records.length === 0) throw new ConversationError('invalid-input', 'conversation-mysql: append requires records')
    if (!Number.isSafeInteger(request.expectedNextSequence) || request.expectedNextSequence < 1) {
      throw new ConversationError('invalid-input', 'conversation-mysql: expected sequence is invalid')
    }
    const seenSources = new Set<number>()
    let previousSource: number | undefined
    request.records.forEach((record, index) => {
      if (record.tenantId !== request.tenantId || record.userId !== request.userId
        || record.conversationId !== request.conversationId || record.sequence !== request.expectedNextSequence + index) {
        throw new ConversationError('record-conflict', 'conversation-mysql: record owner or sequence differs')
      }
      if (!Number.isSafeInteger(record.sourceSequence) || record.sourceSequence < 0) {
        throw new ConversationError('record-conflict', 'conversation-mysql: source sequence is invalid')
      }
      timestamp(record.occurredAt)
      if (previousSource !== undefined && record.sourceSequence < previousSource) {
        throw new ConversationError('record-conflict', 'conversation-mysql: source sequence order differs')
      }
      if (record.sourceSequence !== previousSource && seenSources.has(record.sourceSequence)) {
        throw new ConversationError('record-conflict', 'conversation-mysql: source group is not adjacent')
      }
      seenSources.add(record.sourceSequence)
      previousSource = record.sourceSequence
    })
  }

  private async exactRetry(
    connection: MysqlConnection,
    conversation: Conversation,
    request: AgentRecordAppendRequest,
  ): Promise<AgentRecordAppendCommit | undefined> {
    const [rows] = await connection.execute<RecordRow[]>(
      `SELECT sequence, source_seq, record_id, group_hash, record_json FROM dsh_agent_records
       WHERE tenant_id = ? AND user_id = ? AND conversation_id = ? AND sequence >= ? AND sequence < ?
       ORDER BY sequence ASC`,
      [request.tenantId, request.userId, request.conversationId, request.expectedNextSequence,
        request.expectedNextSequence + request.records.length],
    )
    if (rows.length === 0) return undefined
    if (rows.length !== request.records.length) throw new ConversationError('sequence-conflict', 'conversation-mysql: retry range is partial')
    const groups = recordGroups(request.records)
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      const expected = request.records[index]
      if (row === undefined || expected === undefined) throw unavailable('retry row count changed')
      const group = groups.get(expected.sourceSequence)
      if (group === undefined) throw unavailable('retry source group disappeared')
      if (safeInteger(row.sequence, 'record sequence') !== expected.sequence
        || safeInteger(row.source_seq, 'source sequence') !== expected.sourceSequence
        || row.record_id !== expected.recordId
        || row.group_hash !== group.hash
        || canonicalJson(parseJson(row.record_json, 'record_json')) !== canonicalJson(expected)) {
        throw new ConversationError('sequence-conflict', 'conversation-mysql: retry differs from committed records')
      }
    }
    return { conversation, records: structuredClone(request.records) }
  }

  private async insertRecords(
    connection: MysqlConnection,
    conversation: Conversation,
    records: readonly AgentRecord[],
    groups: Map<number, { hash: string }>,
  ): Promise<void> {
    for (let offset = 0; offset < records.length; offset += INSERT_BATCH_SIZE) {
      const batch = records.slice(offset, offset + INSERT_BATCH_SIZE)
      const values: SqlValue[] = []
      for (const record of batch) {
        const group = groups.get(record.sourceSequence)
        if (group === undefined) throw unavailable('record source group disappeared')
        values.push(record.tenantId, record.userId, record.conversationId, conversation.sessionId, record.sequence,
          record.sourceSequence, record.recordId, record.type, group.hash,
          canonicalJson(record), timestamp(record.occurredAt))
      }
      await connection.execute(
        `INSERT INTO dsh_agent_records
          (tenant_id, user_id, conversation_id, session_id, sequence, source_seq, record_id, record_type,
           group_hash, record_json, occurred_at) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        values,
      )
    }
  }

  private async projectMessages(
    connection: MysqlConnection,
    conversation: Conversation,
    records: readonly AgentRecord[],
  ): Promise<void> {
    const messages = records.filter((record): record is Extract<AgentRecord, { type: 'user/message' | 'assistant/message' }> =>
      record.type === 'user/message' || record.type === 'assistant/message')
    for (let offset = 0; offset < messages.length; offset += INSERT_BATCH_SIZE) {
      const batch = messages.slice(offset, offset + INSERT_BATCH_SIZE)
      const values: SqlValue[] = []
      const stateValues: SqlValue[] = []
      for (const record of batch) {
        values.push(record.tenantId, record.userId, conversation.sessionId, record.payload.messageId,
          record.type === 'user/message' ? 'user' : 'assistant', record.payload.text, timestamp(record.occurredAt))
        stateValues.push(record.tenantId, record.userId, conversation.sessionId, record.payload.messageId,
          record.conversationId, record.sequence, '{}')
      }
      const placeholders = batch.map(() => "(?, ?, ?, ?, 1, 'completed', 'user', ?, ?, ?)").join(', ')
      await connection.execute(
        `INSERT INTO dsh_conversation_messages
          (tenant_id, user_id, session_id, message_id, revision, status, visibility, role, visible_text, occurred_at)
         VALUES ${placeholders}`,
        values,
      )
      await connection.execute(
        `INSERT INTO dsh_conversation_message_state
          (tenant_id, user_id, session_id, message_id, conversation_id, ordinal, extensions)
         VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        stateValues,
      )
    }
  }

  private async projectSubagents(connection: MysqlConnection, records: readonly AgentRecord[]): Promise<void> {
    for (const record of records) {
      if (record.type === 'subagent/started') {
        await connection.execute(
          `INSERT INTO dsh_subagent_runs
            (tenant_id, user_id, parent_conversation_id, delegation_id, child_conversation_id, task_record_id,
             status, result_record_id, started_at, completed_at, extensions)
           VALUES (?, ?, ?, ?, ?, ?, 'started', NULL, ?, NULL, '{}')`,
          [record.tenantId, record.userId, record.conversationId, record.payload.delegationId,
            record.payload.childConversationId, record.recordId, timestamp(record.occurredAt)],
        )
      } else if (record.type === 'subagent/completed') {
        const [updated] = await connection.execute<ResultSetHeader>(
          `UPDATE dsh_subagent_runs SET status = ?, result_record_id = ?, completed_at = ?
           WHERE tenant_id = ? AND user_id = ? AND parent_conversation_id = ? AND delegation_id = ? AND status = 'started'`,
          [record.payload.outcome, record.payload.resultRecordId ?? null, timestamp(record.occurredAt),
            record.tenantId, record.userId, record.conversationId, record.payload.delegationId],
        )
        if (updated.affectedRows !== 1) throw new ConversationError('record-conflict', 'conversation-mysql: delegation completion has no start')
      }
    }
  }
}

export default ConversationMysql
