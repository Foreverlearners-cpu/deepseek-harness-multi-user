import ConversationService, {
  type AgentRecord,
  type AgentRecordAppendCommit,
  type AgentRecordAppendRequest,
  type AgentRecordListQuery,
  type AgentRecordPage,
  type Conversation,
  type ConversationAttachment,
  type ConversationCreateInput,
  type ConversationIdentity,
  type ConversationListQuery,
  type ConversationMessageListQuery,
  type ConversationMessagePage,
  type ConversationPage,
  type SubagentRunListQuery,
  type SubagentRunPage,
} from '@deepseek-ai/dsh-conversation'

/** In-memory Provider exposing attachment state to starter tests. */
export class MemoryConversationService extends ConversationService {
  readonly bySession = new Map<string, Conversation>()
  readonly recordsByConversation = new Map<string, AgentRecord[]>()

  async attach(input: ConversationAttachment): Promise<Conversation> {
    const existing = this.bySession.get(input.sessionId)
    if (existing !== undefined) return structuredClone(existing)
    let conversation: Conversation
    if (input.origin === 'subagent') {
      const parent = this.bySession.get(input.parentSessionId)
      if (parent === undefined) throw new Error('memory conversation: parent Session is not attached')
      conversation = {
        tenantId: parent.tenantId,
        userId: parent.userId,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        parentConversationId: parent.conversationId,
        origin: input.origin,
        delegationDepth: input.delegationDepth,
        status: 'active',
        revision: 1,
        nextSequence: 1,
        retention: input.retention ?? { kind: 'permanent' },
        createdAt: 1,
        updatedAt: 1,
        extensions: input.extensions ?? {},
      }
    } else {
      conversation = {
        ...input,
        status: 'active',
        revision: 1,
        nextSequence: 1,
        retention: input.retention ?? { kind: 'permanent' },
        createdAt: 1,
        updatedAt: 1,
        extensions: input.extensions ?? {},
      }
    }
    this.bySession.set(input.sessionId, conversation)
    this.recordsByConversation.set(input.conversationId, [])
    return structuredClone(conversation)
  }

  async create(_input: ConversationCreateInput): Promise<Conversation> { throw new Error('not used') }
  async get(identity: ConversationIdentity): Promise<Conversation | undefined> {
    const value = [...this.bySession.values()].find(item => item.tenantId === identity.tenantId
      && item.userId === identity.userId && item.conversationId === identity.conversationId)
    return value === undefined ? undefined : structuredClone(value)
  }

  async append(request: AgentRecordAppendRequest): Promise<AgentRecordAppendCommit> {
    const current = this.recordsByConversation.get(request.conversationId) ?? []
    const duplicate = request.records.every(record => current.some(saved => saved.sourceSequence === record.sourceSequence))
    if (!duplicate) current.push(...structuredClone(request.records))
    this.recordsByConversation.set(request.conversationId, current)
    const conversation = [...this.bySession.values()].find(item => item.conversationId === request.conversationId)!
    const title = request.records.findLast(record => record.type === 'conversation/title')?.payload.title
    const updated = {
      ...conversation,
      ...(title === undefined ? {} : { title }),
      revision: conversation.revision + 1,
      nextSequence: conversation.nextSequence + request.records.length,
      updatedAt: conversation.updatedAt + 1,
    }
    this.bySession.set(conversation.sessionId, updated)
    return { conversation: structuredClone(updated), records: structuredClone(request.records) }
  }

  async records(query: AgentRecordListQuery): Promise<AgentRecordPage> {
    return { records: structuredClone(this.recordsByConversation.get(query.conversationId) ?? []) }
  }

  async list(_query: ConversationListQuery): Promise<ConversationPage> { return { conversations: [] } }
  async messages(_query: ConversationMessageListQuery): Promise<ConversationMessagePage> { return { messages: [] } }
  async subagents(_query: SubagentRunListQuery): Promise<SubagentRunPage> { return { runs: [] } }
}
