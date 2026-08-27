import {
  TeamDirectoryError,
  teamId,
  teamMembershipId,
  type TeamId,
  type TeamMembershipId,
  type TeamMembershipListQuery,
  type TeamMembershipStatus,
} from '@deepseek-ai/dsh-team'
import { tenantId, type TenantId } from '@deepseek-ai/dsh-tenant'
import { userId, type UserId } from '@deepseek-ai/dsh-user'

interface CursorPayload {
  readonly v: 1
  readonly after: TeamMembershipId
  readonly status: TeamMembershipStatus | null
  readonly scope: 'team' | 'user'
  readonly scopeId: TeamId | UserId
  readonly tenantId: TenantId | null
}

function scopeId(query: TeamMembershipListQuery): TeamId | UserId {
  return query.scope === 'team' ? query.teamId : query.userId
}

function boundTenant(query: TeamMembershipListQuery): TenantId | null {
  return query.scope === 'user' ? query.tenantId : null
}

/** Encode a scope-and-status-bound keyset cursor for the last returned membership.
 * @param after - final membership id in the current page.
 * @param query - list query whose scope and status bind the cursor.
 * @returns opaque URL-safe cursor.
 */
export function encodeCursor(after: TeamMembershipId, query: TeamMembershipListQuery): string {
  const payload: CursorPayload = {
    v: 1,
    after,
    status: query.status ?? null,
    scope: query.scope,
    scopeId: scopeId(query),
    tenantId: boundTenant(query),
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

/** Decode and validate a scope-and-status-bound keyset cursor.
 * @param cursor - opaque cursor supplied by the directory Consumer.
 * @param query - current list query.
 * @returns exclusive lower membership-id bound.
 */
export function decodeCursor(cursor: string, query: TeamMembershipListQuery): TeamMembershipId {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not an object')
    const payload = value as Partial<CursorPayload>
    if (payload.v !== 1
      || typeof payload.after !== 'string'
      || payload.status !== (query.status ?? null)
      || payload.scope !== query.scope
      || payload.scopeId !== scopeId(query)
      || payload.tenantId !== boundTenant(query)) {
      throw new Error('cursor fields do not match the query')
    }
    if (query.scope === 'team') teamId(payload.scopeId)
    else {
      userId(payload.scopeId)
      tenantId(query.tenantId)
    }
    return teamMembershipId(payload.after)
  } catch (cause) {
    throw new TeamDirectoryError('invalid-input', 'team-mysql: invalid or mismatched list cursor', { cause })
  }
}
