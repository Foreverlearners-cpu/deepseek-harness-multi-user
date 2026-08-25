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

/** Minimal observable Provider for conversation-persistence behavior tests. */
export class RecordingConversationService extends ConversationService {
  readonly committed = new Map<string, AgentRecord[]>()
  readonly starts: string[] = []
  appendGate: Promise<void> | undefined
  appendFailure: Error | undefined

  async attach(input: ConversationAttachment): Promise<Conversation> {
    if (input.origin === 'subagent') throw new Error('child attachment is not used by this fixture')
    const conversation: Conversation = {
      ...input,
      status: 'active',
      revision: 1,
      nextSequence: (this.committed.get(input.conversationId)?.length ?? 0) + 1,
      retention: input.retention ?? { kind: 'permanent' },
      createdAt: 1,
      updatedAt: 1,
      extensions: input.extensions ?? {},
    }
    this.committed.set(input.conversationId, this.committed.get(input.conversationId) ?? [])
    return structuredClone(conversation)
  }

  async create(_input: ConversationCreateInput): Promise<Conversation> { throw new Error('not used') }
  async get(_identity: ConversationIdentity): Promise<Conversation | undefined> { return undefined }

  async append(request: AgentRecordAppendRequest): Promise<AgentRecordAppendCommit> {
    this.starts.push(request.conversationId)
    await this.appendGate
    if (this.appendFailure !== undefined) throw this.appendFailure
    const records = this.committed.get(request.conversationId) ?? []
    records.push(...structuredClone(request.records))
    this.committed.set(request.conversationId, records)
    const conversation: Conversation = {
      tenantId: request.tenantId,
      userId: request.userId,
      conversationId: request.conversationId,
      sessionId: request.records[0]!.recordId.split('~')[0] as Conversation['sessionId'],
      origin: 'top-level',
      delegationDepth: 0,
      status: 'active',
      revision: 2,
      nextSequence: request.expectedNextSequence + request.records.length,
      retention: { kind: 'permanent' },
      createdAt: 1,
      updatedAt: 2,
      extensions: {},
    }
    return { conversation, records: structuredClone(request.records) }
  }

  async records(query: AgentRecordListQuery): Promise<AgentRecordPage> {
    return { records: structuredClone(this.committed.get(query.conversationId) ?? []) }
  }

  async list(_query: ConversationListQuery): Promise<ConversationPage> { return { conversations: [] } }
  async messages(_query: ConversationMessageListQuery): Promise<ConversationMessagePage> { return { messages: [] } }
  async subagents(_query: SubagentRunListQuery): Promise<SubagentRunPage> { return { runs: [] } }
}
