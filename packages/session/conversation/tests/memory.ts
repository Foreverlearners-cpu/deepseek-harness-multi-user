import { isDeepStrictEqual } from 'node:util'
import ConversationService, {
  ConversationError,
  type AgentRecord,
  type AgentRecordAppendCommit,
  type AgentRecordAppendRequest,
  type AgentRecordListQuery,
  type AgentRecordPage,
  type Conversation,
  type ConversationAttachment,
  type ConversationCreateInput,
  type ConversationCursor,
  type ConversationIdentity,
  type ConversationListQuery,
  type ConversationMessage,
  type ConversationMessageListQuery,
  type ConversationMessagePage,
  type ConversationPage,
  type SubagentRun,
  type SubagentRunListQuery,
  type SubagentRunPage,
} from '../src/index.ts'

function key(value: ConversationIdentity): string {
  return JSON.stringify([value.tenantId, value.userId, value.conversationId])
}

function page<T>(values: readonly T[], limit = 50, cursor?: string): { values: readonly T[]; nextCursor?: string } {
  const offset = cursor === undefined ? 0 : Number(cursor)
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ConversationError('invalid-input', 'memory cursor is invalid')
  const selected = values.slice(offset, offset + limit)
  const next = offset + selected.length
  return { values: selected, ...(next < values.length ? { nextCursor: String(next) } : {}) }
}

/** In-memory Provider used by the shared conversation contract. */
export class MemoryConversationService extends ConversationService {
  private readonly conversations = new Map<string, Conversation>()
  private readonly recordSets = new Map<string, AgentRecord[]>()
  private readonly messageSets = new Map<string, ConversationMessage[]>()
  private readonly runSets = new Map<string, SubagentRun[]>()
  private readonly sessionBindings = new Map<string, Conversation>()
  private clock = 1_000

  async attach(input: ConversationAttachment): Promise<Conversation> {
    const existing = this.sessionBindings.get(input.sessionId)
    if (existing !== undefined) {
      if (existing.conversationId !== input.conversationId) {
        throw new ConversationError('conversation-conflict', 'Session is attached to another conversation')
      }
      return structuredClone(existing)
    }
    let creation: ConversationCreateInput
    if (input.origin === 'subagent') {
      const parent = this.sessionBindings.get(input.parentSessionId)
      if (parent === undefined) throw new ConversationError('conversation-not-found', 'parent Session is not attached')
      creation = {
        ...input,
        tenantId: parent.tenantId,
        userId: parent.userId,
        parentConversationId: parent.conversationId,
      }
    } else {
      creation = input
    }
    const conversation = await this.create(creation)
    this.sessionBindings.set(input.sessionId, conversation)
    return conversation
  }

  async create(input: ConversationCreateInput): Promise<Conversation> {
    const id = key(input)
    if (this.conversations.has(id)) throw new ConversationError('conversation-conflict', 'conversation already exists')
    const now = this.tick()
    const conversation: Conversation = {
      ...input,
      status: 'active',
      revision: 1,
      nextSequence: 1,
      retention: input.retention ?? { kind: 'permanent' },
      createdAt: now,
      updatedAt: now,
      extensions: input.extensions ?? {},
    }
    this.conversations.set(id, conversation)
    this.sessionBindings.set(input.sessionId, conversation)
    this.recordSets.set(id, [])
    this.messageSets.set(id, [])
    this.runSets.set(id, [])
    return structuredClone(conversation)
  }

  async get(identity: ConversationIdentity): Promise<Conversation | undefined> {
    const value = this.conversations.get(key(identity))
    return value === undefined ? undefined : structuredClone(value)
  }

  async append(request: AgentRecordAppendRequest): Promise<AgentRecordAppendCommit> {
    const id = key(request)
    const conversation = this.conversations.get(id)
    if (conversation === undefined) throw new ConversationError('conversation-not-found', 'conversation was not found')
    if (request.records.length === 0) throw new ConversationError('invalid-input', 'append must contain records')
    const records = this.recordSets.get(id)!
    const existing = request.records.map(candidate => records.find(record => candidate.recordId === record.recordId))
    if (existing.every((record, index): record is AgentRecord => (
      record !== undefined && isDeepStrictEqual(record, request.records[index])
    ))) {
      return { conversation: structuredClone(conversation), records: structuredClone(existing) }
    }
    if (request.expectedNextSequence !== conversation.nextSequence) {
      throw new ConversationError('sequence-conflict', 'next sequence changed')
    }
    request.records.forEach((record, index) => {
      if (key(record) !== id || record.sequence !== request.expectedNextSequence + index) {
        throw new ConversationError('record-conflict', 'record ownership or sequence is invalid')
      }
      if (records.some(current => current.recordId === record.recordId)) {
        throw new ConversationError('record-conflict', 'record id already exists')
      }
      if (records.some(current => current.sourceSequence === record.sourceSequence)) {
        throw new ConversationError('record-conflict', 'source sequence already exists')
      }
      const previous = request.records[index - 1]
      if (previous !== undefined && record.sourceSequence < previous.sourceSequence) {
        throw new ConversationError('record-conflict', 'source sequence order is invalid')
      }
      if (previous?.sourceSequence !== record.sourceSequence
        && request.records.slice(0, index).some(current => current.sourceSequence === record.sourceSequence)) {
        throw new ConversationError('record-conflict', 'source sequence group is not contiguous')
      }
    })
    const committed = structuredClone(request.records)
    records.push(...committed)
    this.project(id, committed)
    const current: Conversation = {
      ...conversation,
      revision: conversation.revision + 1,
      nextSequence: conversation.nextSequence + committed.length,
      updatedAt: this.tick(),
    }
    this.conversations.set(id, current)
    return { conversation: structuredClone(current), records: structuredClone(committed) }
  }

  async list(query: ConversationListQuery): Promise<ConversationPage> {
    const values = [...this.conversations.values()]
      .filter(value => value.tenantId === query.tenantId && value.userId === query.userId)
      .filter(value => query.status === undefined || value.status === query.status)
      .sort((left, right) => left.conversationId.localeCompare(right.conversationId))
    const result = page(values, query.limit, query.cursor)
    return { conversations: structuredClone(result.values), ...this.cursor(result.nextCursor) }
  }

  async records(query: AgentRecordListQuery): Promise<AgentRecordPage> {
    const values = this.recordSets.get(key(query))
    if (values === undefined) throw new ConversationError('conversation-not-found', 'conversation was not found')
    const filtered = values.filter(record => query.types === undefined || query.types.includes(record.type))
    const result = page(filtered, query.limit, query.cursor)
    return { records: structuredClone(result.values), ...this.cursor(result.nextCursor) }
  }

  async messages(query: ConversationMessageListQuery): Promise<ConversationMessagePage> {
    const values = this.messageSets.get(key(query))
    if (values === undefined) throw new ConversationError('conversation-not-found', 'conversation was not found')
    const filtered = values.filter(value => query.visibility === undefined || value.visibility === query.visibility)
    const result = page(filtered, query.limit, query.cursor)
    return { messages: structuredClone(result.values), ...this.cursor(result.nextCursor) }
  }

  async subagents(query: SubagentRunListQuery): Promise<SubagentRunPage> {
    const values = this.runSets.get(key(query))
    if (values === undefined) throw new ConversationError('conversation-not-found', 'conversation was not found')
    const filtered = values.filter(value => query.status === undefined || value.status === query.status)
    const result = page(filtered, query.limit, query.cursor)
    return { runs: structuredClone(result.values), ...this.cursor(result.nextCursor) }
  }

  private project(id: string, records: readonly AgentRecord[]): void {
    const messages = this.messageSets.get(id)!
    const runs = this.runSets.get(id)!
    for (const record of records) {
      if (record.type === 'user/message' || record.type === 'assistant/message') {
        messages.push({
          tenantId: record.tenantId,
          userId: record.userId,
          conversationId: record.conversationId,
          messageId: record.payload.messageId,
          ordinal: messages.length + 1,
          revision: 1,
          status: 'completed',
          visibility: 'user',
          role: record.type === 'user/message' ? 'user' : 'assistant',
          visibleText: record.payload.text,
          occurredAt: record.occurredAt,
          extensions: {},
        })
      } else if (record.type === 'subagent/started') {
        runs.push({
          tenantId: record.tenantId,
          userId: record.userId,
          delegationId: record.payload.delegationId,
          parentConversationId: record.conversationId,
          childConversationId: record.payload.childConversationId,
          taskRecordId: record.recordId,
          status: 'started',
          startedAt: record.occurredAt,
          extensions: {},
        })
      } else if (record.type === 'subagent/completed') {
        const index = runs.findIndex(run => run.delegationId === record.payload.delegationId)
        if (index < 0) throw new ConversationError('record-conflict', 'completed delegation was not started')
        const run = runs[index]!
        runs[index] = {
          ...run,
          status: record.payload.outcome,
          ...(record.payload.resultRecordId === undefined ? {} : { resultRecordId: record.payload.resultRecordId }),
          completedAt: record.occurredAt,
        }
      }
    }
  }

  private cursor(value: string | undefined): { nextCursor?: ConversationCursor } {
    return value === undefined ? {} : { nextCursor: value as ConversationCursor }
  }

  private tick(): number {
    this.clock += 1
    return this.clock
  }
}
