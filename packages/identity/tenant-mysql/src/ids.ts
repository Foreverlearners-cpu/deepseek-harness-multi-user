import { membershipId, tenantId, type MembershipId, type TenantId } from '@deepseek-ai/dsh-tenant'
import { randomUUID } from 'node:crypto'

/** Generate one Provider-owned tenant id.
 * @returns branded tenant id from a UUID.
 */
export function newTenantId(): TenantId {
  return tenantId(randomUUID())
}

/** Generate one Provider-owned membership id.
 * @returns branded membership id from a UUID.
 */
export function newMembershipId(): MembershipId {
  return membershipId(randomUUID())
}
