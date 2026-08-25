/** Opaque keyset cursors for the MySQL conversation Provider. */

import { ConversationError, conversationCursor, type ConversationCursor } from '@deepseek-ai/dsh-conversation'

interface CursorPayload {
  readonly kind: 'conversations' | 'records' | 'messages' | 'subagents'
  readonly scope: string
  readonly after: string | number
}

/** Encode one filter-bound keyset cursor. @param payload - query identity and last key. @returns opaque cursor. */
export function encodeCursor(payload: CursorPayload): ConversationCursor {
  return conversationCursor(Buffer.from(JSON.stringify(payload)).toString('base64url'))
}

/**
 * Decode and bind a cursor to its exact query.
 * @param cursor - opaque cursor.
 * @param kind - query kind.
 * @param scope - canonical filters.
 * @returns exclusive key.
 */
export function decodeCursor(
  cursor: ConversationCursor | undefined,
  kind: CursorPayload['kind'],
  scope: string,
): string | number | undefined {
  if (cursor === undefined) return undefined
  try {
    const value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')) as Partial<CursorPayload>
    if (value.kind !== kind || value.scope !== scope || (typeof value.after !== 'string' && typeof value.after !== 'number')) {
      throw new Error('cursor fields differ')
    }
    return value.after
  } catch (cause) {
    throw new ConversationError('invalid-input', 'conversation-mysql: cursor is invalid for this query', { cause })
  }
}
