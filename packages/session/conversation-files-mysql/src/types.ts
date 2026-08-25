/** Public owner-scoped conversation file metadata types. */

import type {
  ConversationCursor,
  ConversationFileId,
  ConversationIdentity,
  MessageId,
} from '@deepseek-ai/dsh-conversation'
import type { FileObjectContent, FileObjectRef } from '@deepseek-ai/dsh-file-storage'

/** Metadata for one immutable object published into a conversation. */
export interface ConversationFile extends ConversationIdentity {
  readonly fileId: ConversationFileId
  readonly object: FileObjectRef
  readonly mediaType: string
  readonly fileName?: string
  readonly createdAt: number
}

/** Publish complete bytes and associate the resulting immutable object with one conversation. */
export interface ConversationFilePublishRequest extends ConversationIdentity {
  readonly fileId: ConversationFileId
  readonly content: AsyncIterable<Uint8Array>
  readonly mediaType: string
  readonly fileName?: string
  readonly messageId?: MessageId
  readonly signal?: AbortSignal
}

/** Identify one file without permitting cross-owner lookup. */
export interface ConversationFileIdentity extends ConversationIdentity {
  readonly fileId: ConversationFileId
}

/** Bounded keyset query for files attached to one conversation. */
export interface ConversationFileListQuery extends ConversationIdentity {
  readonly limit?: number
  readonly cursor?: ConversationCursor
}

/** Stable file-id ordered page. */
export interface ConversationFilePage {
  readonly files: readonly ConversationFile[]
  readonly nextCursor?: ConversationCursor
}

/** Bounded query for files attached to one message in one conversation. */
export interface ConversationMessageFileListQuery extends ConversationIdentity {
  readonly messageId: MessageId
  readonly limit?: number
  readonly cursor?: ConversationCursor
}

/** Ready object bytes paired with their owner-scoped metadata. */
export interface OpenConversationFile {
  readonly file: ConversationFile
  readonly content: FileObjectContent
}

/** Stable failure categories for conversation file metadata operations. */
export type ConversationFileErrorCode =
  | 'invalid-input'
  | 'conversation-not-found'
  | 'message-not-found'
  | 'file-not-found'
  | 'file-conflict'
  | 'provider-unavailable'
