/**
 * Provider-independent semantic conversation records and query service.
 * @module @deepseek-ai/dsh-conversation
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  AgentRecordAppendCommit,
  AgentRecordAppendRequest,
  AgentRecordId,
  AgentRecordListQuery,
  AgentRecordPage,
  Conversation,
  ConversationApprovalId,
  ConversationAttachment,
  ConversationCreateInput,
  ConversationCursor,
  ConversationErrorCode,
  ConversationFileId,
  ConversationId,
  ConversationIdentity,
  ConversationListQuery,
  ConversationMessageListQuery,
  ConversationMessagePage,
  ConversationPage,
  ConversationSessionId,
  ConversationStepId,
  ConversationTenantId,
  ConversationToolCallId,
  ConversationTurnId,
  ConversationUserId,
  DelegationId,
  MessageId,
  SubagentRunListQuery,
  SubagentRunPage,
} from './types.ts'

export type * from './types.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/

function stableId(label: string, value: string): string {
  if (!ID_PATTERN.test(value)) throw new TypeError(`conversation: ${label} must match ${String(ID_PATTERN)}`)
  return value
}

/** Brand a validated tenant id. @param value - id candidate. @returns validated id. */
export const conversationTenantId = (value: string): ConversationTenantId =>
  stableId('tenant id', value) as ConversationTenantId
/** Brand a validated user id. @param value - id candidate. @returns validated id. */
export const conversationUserId = (value: string): ConversationUserId =>
  stableId('user id', value) as ConversationUserId
/** Brand a validated conversation id. @param value - id candidate. @returns validated id. */
export const conversationId = (value: string): ConversationId =>
  stableId('conversation id', value) as ConversationId
/** Brand a validated runtime Session id. @param value - id candidate. @returns validated id. */
export const conversationSessionId = (value: string): ConversationSessionId =>
  stableId('session id', value) as ConversationSessionId
/** Brand a validated semantic record id. @param value - id candidate. @returns validated id. */
export const agentRecordId = (value: string): AgentRecordId =>
  stableId('record id', value) as AgentRecordId
/** Brand a validated message id. @param value - id candidate. @returns validated id. */
export const conversationMessageId = (value: string): MessageId =>
  stableId('message id', value) as MessageId
/** Brand a validated turn id. @param value - id candidate. @returns validated id. */
export const conversationTurnId = (value: string): ConversationTurnId =>
  stableId('turn id', value) as ConversationTurnId
/** Brand a validated step id. @param value - id candidate. @returns validated id. */
export const conversationStepId = (value: string): ConversationStepId =>
  stableId('step id', value) as ConversationStepId
/** Brand a validated tool-call id. @param value - id candidate. @returns validated id. */
export const conversationToolCallId = (value: string): ConversationToolCallId =>
  stableId('tool-call id', value) as ConversationToolCallId
/** Brand a validated approval id. @param value - id candidate. @returns validated id. */
export const conversationApprovalId = (value: string): ConversationApprovalId =>
  stableId('approval id', value) as ConversationApprovalId
/** Brand a validated delegation id. @param value - id candidate. @returns validated id. */
export const delegationId = (value: string): DelegationId =>
  stableId('delegation id', value) as DelegationId
/** Brand a validated file id. @param value - id candidate. @returns validated id. */
export const conversationFileId = (value: string): ConversationFileId =>
  stableId('file id', value) as ConversationFileId
/** Brand an opaque non-empty Provider cursor. @param value - cursor candidate. @returns validated cursor. */
export const conversationCursor = (value: string): ConversationCursor =>
  stableId('cursor', value) as ConversationCursor

/** Public conversation failure with a stable transport-safe category. */
export class ConversationError extends Error {
  /** Stable category safe for transport mapping. */
  readonly code: ConversationErrorCode

  /** @param code - stable failure category. @param message - diagnostic without secrets. @param options - optional cause. */
  constructor(code: ConversationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ConversationError'
    this.code = code
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Active semantic conversation Provider. */
    conversations: ConversationService
  }
}

/**
 * Abstract semantic conversation store. Providers atomically own metadata,
 * contiguous record append, projections, and opaque keyset cursors.
 */
export abstract class ConversationService extends Service {
  /** @param ctx - owning Host context. */
  constructor(ctx: Context) {
    super(ctx, 'conversations')
  }

  /**
   * Bind a runtime Session before its first business record. Root attachments
   * declare tenant and user; child attachments inherit both from their parent.
   * Repeating the same binding is idempotent and a conflicting binding fails.
   * @param input - root ownership or child-parent binding.
   * @returns attached conversation metadata.
   */
  abstract attach(input: ConversationAttachment): Promise<Conversation>

  /** Create one conversation. @param input - explicit identity, origin, and ownership. @returns committed metadata. */
  abstract create(input: ConversationCreateInput): Promise<Conversation>
  /** Read one conversation. @param identity - tenant-scoped identity. @returns current metadata or undefined. */
  abstract get(identity: ConversationIdentity): Promise<Conversation | undefined>
  /**
   * Atomically append a non-empty contiguous record range.
   * @param request - expected sequence and complete records.
   * @returns committed range.
   */
  abstract append(
    request: AgentRecordAppendRequest,
  ): Promise<AgentRecordAppendCommit>
  /** List tenant-user conversations. @param query - filters and opaque cursor. @returns one stable page. */
  abstract list(query: ConversationListQuery): Promise<ConversationPage>
  /** List semantic records in sequence order. @param query - conversation scope and filters. @returns one stable page. */
  abstract records(
    query: AgentRecordListQuery,
  ): Promise<AgentRecordPage>
  /** List user-interface message projections in ordinal order. @param query - conversation scope and filters. @returns one stable page. */
  abstract messages(
    query: ConversationMessageListQuery,
  ): Promise<ConversationMessagePage>
  /** List direct child delegations. @param query - parent conversation scope and filters. @returns one stable page. */
  abstract subagents(
    query: SubagentRunListQuery,
  ): Promise<SubagentRunPage>
}

export default ConversationService
