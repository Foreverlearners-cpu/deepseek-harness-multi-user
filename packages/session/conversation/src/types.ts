/** Provider-neutral semantic conversation types. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Tenant that owns conversation data. */
export type ConversationTenantId = Branded<'ConversationTenantId'>
/** User that owns conversation data within a tenant. */
export type ConversationUserId = Branded<'ConversationUserId'>
/** Stable identity of one top-level or child conversation. */
export type ConversationId = Branded<'ConversationId'>
/** Stable identity of the runtime Session bound to a conversation. */
export type ConversationSessionId = Branded<'ConversationSessionId'>
/** Stable identity of one semantic Agent record. */
export type AgentRecordId = Branded<'AgentRecordId'>
/** Stable identity of one user-visible message. */
export type MessageId = Branded<'ConversationMessageId'>
/** Stable identity of one user turn. */
export type ConversationTurnId = Branded<'ConversationTurnId'>
/** Stable identity of one Agent step. */
export type ConversationStepId = Branded<'ConversationStepId'>
/** Stable identity of one tool invocation. */
export type ConversationToolCallId = Branded<'ConversationToolCallId'>
/** Stable identity of one approval request. */
export type ConversationApprovalId = Branded<'ConversationApprovalId'>
/** Stable identity of one subagent delegation. */
export type DelegationId = Branded<'ConversationDelegationId'>
/** Stable identity of one published file. */
export type ConversationFileId = Branded<'ConversationFileId'>
/** Opaque continuation token owned by a Provider. */
export type ConversationCursor = Branded<'ConversationCursor'>

/** JSON data accepted in semantic payloads and extensions. */
export type ConversationJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ConversationJsonValue[]
  | { readonly [key: string]: ConversationJsonValue }

/** Namespaced supplementary data that does not define indexed behavior. */
export type ConversationExtensions = Readonly<Record<string, ConversationJsonValue>>

/** Tenant and user ownership of one conversation. */
export interface ConversationOwner {
  readonly tenantId: ConversationTenantId
  readonly userId: ConversationUserId
}

/** Complete identity of one conversation. */
export interface ConversationIdentity extends ConversationOwner {
  readonly conversationId: ConversationId
}

/** Closed lifecycle state of a conversation. */
export type ConversationStatus = 'active' | 'archived' | 'deleted'
/** Origin of one conversation. */
export type ConversationOrigin = 'top-level' | 'subagent' | 'imported'

/** Retention decision attached to one conversation. */
export type ConversationRetention =
  | { readonly kind: 'permanent' }
  | {
    readonly kind: 'tenant-policy'
    readonly policyRevision: number
    readonly archiveAt?: number
    readonly deleteAt?: number
  }

/** Immutable current conversation metadata. */
export interface Conversation extends ConversationIdentity {
  readonly sessionId: ConversationSessionId
  readonly parentConversationId?: ConversationId
  readonly origin: ConversationOrigin
  readonly delegationDepth: number
  readonly title?: string
  readonly status: ConversationStatus
  readonly revision: number
  readonly nextSequence: number
  readonly retention: ConversationRetention
  readonly createdAt: number
  readonly updatedAt: number
  readonly extensions: ConversationExtensions
}

/** Values used to create a conversation. */
export interface ConversationCreateInput extends ConversationIdentity {
  readonly sessionId: ConversationSessionId
  readonly parentConversationId?: ConversationId
  readonly origin: ConversationOrigin
  readonly delegationDepth: number
  readonly title?: string
  readonly retention?: ConversationRetention
  readonly extensions?: ConversationExtensions
}

/** Explicit owner binding required before a root Session emits a business record. */
export interface RootConversationAttachment extends ConversationCreateInput {
  readonly origin: 'top-level' | 'imported'
}

/** Child Session binding whose owner is inherited from an attached parent Session. */
export interface ChildConversationAttachment {
  readonly sessionId: ConversationSessionId
  readonly conversationId: ConversationId
  readonly parentSessionId: ConversationSessionId
  readonly origin: 'subagent'
  readonly delegationDepth: number
  readonly title?: string
  readonly retention?: ConversationRetention
  readonly extensions?: ConversationExtensions
}

/** Session-to-conversation ownership binding accepted by {@link ConversationService.attach}. */
export type ConversationAttachment = RootConversationAttachment | ChildConversationAttachment

/** State shared by every complete semantic Agent record. */
export interface AgentRecordBase<
  TType extends string,
  TPayload,
  TStatus extends AgentRecordStatus = 'completed',
> extends ConversationIdentity {
  readonly recordId: AgentRecordId
  readonly sequence: number
  /**
   * Original Session event sequence used for source-level idempotency. One
   * source event may project to multiple adjacent records committed together.
   */
  readonly sourceSequence: number
  readonly turnId?: ConversationTurnId
  readonly stepId?: ConversationStepId
  readonly type: TType
  readonly status: TStatus
  readonly payload: TPayload
  readonly idempotencyKey?: string
  readonly occurredAt: number
  readonly extensions: ConversationExtensions
}

/** Durability state of one complete semantic record. */
export type AgentRecordStatus = 'completed' | 'interrupted' | 'unknown'

/** Complete semantic Agent record accepted by a Provider. */
export type AgentRecord =
  | AgentRecordBase<'user/message', {
    readonly messageId: MessageId
    readonly visibility: ConversationMessage['visibility']
    readonly text: string
  }>
  | AgentRecordBase<'assistant/message', {
    readonly messageId: MessageId
    readonly visibility: ConversationMessage['visibility']
    readonly text: string
  }>
  | AgentRecordBase<'conversation/title', { readonly title: string }>
  | AgentRecordBase<'assistant/interrupted', {
    readonly attemptId: string
    readonly errorCode?: string
    readonly generatedCharacters?: number
  }, 'interrupted'>
  | AgentRecordBase<'tool/call', {
    readonly toolCallId: ConversationToolCallId
    readonly toolName: string
    readonly arguments: ConversationJsonValue
    readonly effect: 'read-only' | 'external-side-effect'
  }>
  | AgentRecordBase<'tool/result', {
    readonly toolCallId: ConversationToolCallId
    readonly outcome: 'completed' | 'failed' | 'unknown'
    readonly result?: ConversationJsonValue
    readonly resultFileId?: ConversationFileId
  }>
  | AgentRecordBase<'approval/asked', {
    readonly approvalId: ConversationApprovalId
    readonly toolCallId?: ConversationToolCallId
    readonly summary: string
  }>
  | AgentRecordBase<'approval/decided', {
    readonly approvalId: ConversationApprovalId
    readonly decision: 'approved' | 'denied'
    readonly decidedBy: 'user' | 'administrator' | 'policy' | 'unknown'
  }>
  | AgentRecordBase<'subagent/started', {
    readonly delegationId: DelegationId
    readonly childConversationId: ConversationId
    readonly task: string
  }>
  | AgentRecordBase<'subagent/completed', {
    readonly delegationId: DelegationId
    readonly outcome: 'completed' | 'failed' | 'interrupted'
    readonly resultRecordId?: AgentRecordId
  }>
  | AgentRecordBase<'file/published', {
    readonly fileId: ConversationFileId
    readonly messageId?: MessageId
  }>
  | AgentRecordBase<'turn/completed', {
    readonly turnId: ConversationTurnId
    readonly outcome: 'completed' | 'failed' | 'interrupted'
  }>

/**
 * Atomic append request for a contiguous business-sequence range. Records are
 * ordered by non-decreasing source sequence; records sharing one source must
 * form one adjacent group in this append.
 */
export interface AgentRecordAppendRequest extends ConversationIdentity {
  readonly expectedNextSequence: number
  readonly records: readonly AgentRecord[]
}

/** Provider result for one atomic append. */
export interface AgentRecordAppendCommit {
  readonly conversation: Conversation
  readonly records: readonly AgentRecord[]
}

/** Complete user-interface message projection. */
export interface ConversationMessage extends ConversationIdentity {
  readonly messageId: MessageId
  readonly ordinal: number
  readonly revision: number
  readonly status: 'completed' | 'superseded'
  readonly visibility: 'user' | 'internal'
  readonly role: 'user' | 'assistant'
  readonly visibleText: string
  readonly occurredAt: number
  readonly extensions: ConversationExtensions
}

/** Current state of one parent-to-child delegation. */
export interface SubagentRun extends ConversationOwner {
  readonly delegationId: DelegationId
  readonly parentConversationId: ConversationId
  readonly childConversationId: ConversationId
  readonly taskRecordId: AgentRecordId
  readonly status: 'started' | 'completed' | 'failed' | 'interrupted' | 'unknown'
  readonly resultRecordId?: AgentRecordId
  readonly startedAt: number
  readonly completedAt?: number
  readonly extensions: ConversationExtensions
}

/** Bounded conversation list query. */
export interface ConversationListQuery extends ConversationOwner {
  readonly status?: ConversationStatus
  readonly limit?: number
  readonly cursor?: ConversationCursor
}

/** One ordered conversation page. */
export interface ConversationPage {
  readonly conversations: readonly Conversation[]
  readonly nextCursor?: ConversationCursor
}

/** Bounded semantic-record query scoped to one conversation. */
export interface AgentRecordListQuery extends ConversationIdentity {
  readonly types?: readonly AgentRecord['type'][]
  readonly limit?: number
  readonly cursor?: ConversationCursor
}

/** One sequence-ordered semantic-record page. */
export interface AgentRecordPage {
  readonly records: readonly AgentRecord[]
  readonly nextCursor?: ConversationCursor
}

/** Bounded message query scoped to one conversation. */
export interface ConversationMessageListQuery extends ConversationIdentity {
  readonly visibility?: ConversationMessage['visibility']
  readonly limit?: number
  readonly cursor?: ConversationCursor
}

/** One ordinal-ordered message page. */
export interface ConversationMessagePage {
  readonly messages: readonly ConversationMessage[]
  readonly nextCursor?: ConversationCursor
}

/** Bounded child-run query scoped to one parent conversation. */
export interface SubagentRunListQuery extends ConversationIdentity {
  readonly status?: SubagentRun['status']
  readonly limit?: number
  readonly cursor?: ConversationCursor
}

/** One stable delegation-ordered child-run page. */
export interface SubagentRunPage {
  readonly runs: readonly SubagentRun[]
  readonly nextCursor?: ConversationCursor
}

/** Stable conversation failure category safe for transport mapping. */
export type ConversationErrorCode =
  | 'invalid-input'
  | 'conversation-not-found'
  | 'conversation-conflict'
  | 'sequence-conflict'
  | 'record-conflict'
  | 'provider-unavailable'
