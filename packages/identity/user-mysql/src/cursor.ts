import { UserDirectoryError, userId, type UserId, type UserStatus } from '@deepseek-ai/dsh-user'

interface CursorPayload {
  readonly v: 1
  readonly after: UserId
  readonly status: UserStatus | null
}

/** Encode a status-bound keyset cursor for the last returned user.
 * @param after - final user id in the current page.
 * @param status - status filter bound to the scan.
 * @returns opaque URL-safe cursor.
 */
export function encodeCursor(after: UserId, status: UserStatus | undefined): string {
  const payload: CursorPayload = { v: 1, after, status: status ?? null }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** Decode and validate a status-bound keyset cursor.
 * @param cursor - opaque cursor supplied by the directory Consumer.
 * @param status - current status filter.
 * @returns exclusive lower user-id bound.
 */
export function decodeCursor(cursor: string, status: UserStatus | undefined): UserId {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object')
    const payload = value as Partial<CursorPayload>
    if (payload.v !== 1 || typeof payload.after !== 'string' || payload.status !== (status ?? null)) {
      throw new Error('cursor fields do not match the query')
    }
    return userId(payload.after)
  } catch (cause) {
    throw new UserDirectoryError('invalid-input', 'user-mysql: invalid or mismatched list cursor', { cause })
  }
}
