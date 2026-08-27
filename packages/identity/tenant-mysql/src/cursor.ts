import {
  TenantDirectoryError,
  membershipId,
  tenantId,
  type MembershipId,
  type MembershipListQuery,
  type MembershipStatus,
  type TenantId,
} from '@deepseek-ai/dsh-tenant'
import { userId, type UserId } from '@deepseek-ai/dsh-user'

interface CursorPayload {
  readonly v: 1
  readonly after: MembershipId
  readonly status: MembershipStatus | null
  readonly scope: 'tenant' | 'user'
  readonly scopeId: TenantId | UserId
}

function scopeId(query: MembershipListQuery): TenantId | UserId {
  return query.scope === 'tenant' ? query.tenantId : query.userId
}

/** Encode a scope-and-status-bound keyset cursor for the last returned membership.
 * @param after - final membership id in the current page.
 * @param query - list query whose scope and status bind the cursor.
 * @returns opaque URL-safe cursor.
 */
export function encodeCursor(after: MembershipId, query: MembershipListQuery): string {
  const payload: CursorPayload = {
    v: 1,
    after,
    status: query.status ?? null,
    scope: query.scope,
    scopeId: scopeId(query),
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** Decode and validate a scope-and-status-bound keyset cursor.
 * @param cursor - opaque cursor supplied by the directory Consumer.
 * @param query - current list query.
 * @returns exclusive lower membership-id bound.
 */
export function decodeCursor(cursor: string, query: MembershipListQuery): MembershipId {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object')
    const payload = value as Partial<CursorPayload>
    if (payload.v !== 1
      || typeof payload.after !== 'string'
      || payload.status !== (query.status ?? null)
      || payload.scope !== query.scope
      || payload.scopeId !== scopeId(query)) {
      throw new Error('cursor fields do not match the query')
    }
    if (query.scope === 'tenant') tenantId(payload.scopeId)
    else userId(payload.scopeId)
    return membershipId(payload.after)
  } catch (cause) {
    throw new TenantDirectoryError('invalid-input', 'tenant-mysql: invalid or mismatched list cursor', { cause })
  }
}
