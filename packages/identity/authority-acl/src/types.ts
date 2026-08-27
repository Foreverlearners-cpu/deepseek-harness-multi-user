/** Host object-grant types shared by policy sources and the object route. */

import type { ActionCode, ResourceId, ResourceType } from '@deepseek-ai/dsh-authority/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { TeamId } from '@deepseek-ai/dsh-team/types'
import type { TenantId } from '@deepseek-ai/dsh-tenant/types'
import type { UserId } from '@deepseek-ai/dsh-user/types'

/** Stable role identity named by a role-subject grant, such as `runner`. */
export type RoleId = Branded<'RoleId'>

/** Stable encoded grant subject, such as `g:team-rd` or `everyone`. */
export type AclSubjectRef = Branded<'AclSubjectRef'>

/** Closed grant-subject kind stored on one object-grant row. */
export type AclSubjectKind = 'user' | 'role' | 'team' | 'tenant' | 'everyone'

/** Subject that holds one object grant. A team subject stays one row. */
export type AclSubject =
  | { readonly kind: 'user'; readonly id: UserId }
  | { readonly kind: 'role'; readonly id: RoleId }
  | { readonly kind: 'team'; readonly id: TeamId }
  | { readonly kind: 'tenant'; readonly id: TenantId }
  | { readonly kind: 'everyone' }

/** Resource identity used to list grants. Tenant and team are not stored here. */
export interface AclResourceRef {
  readonly type: ResourceType
  readonly id: ResourceId
}

/** One object grant: a resource, one subject, and separate Use and Delegate sets. */
export interface AclGrant {
  readonly resource: AclResourceRef
  readonly subject: AclSubject
  readonly use: readonly ActionCode[]
  readonly delegate: readonly ActionCode[]
}

/** Lookup that returns roles the current user holds on exactly one team. */
export interface AclRoleFactQuery {
  readonly userId: UserId
  readonly tenantId: TenantId
  readonly teamId: TeamId
}

/** Stable ACL failure category safe for transport mapping. */
export type AuthorityAclErrorCode =
  | 'invalid-input'
  | 'conflict'
  | 'provider-unavailable'

/** Read API for object grants. Team subjects stay encoded; members are not copied. */
export interface AclPolicySource {
  /** List grants stored for this resource only.
   * @param resource - type and id that must both match the grant row.
   * @returns grants for that resource; never expanded team-member copies.
   */
  listGrants(resource: AclResourceRef): Promise<readonly AclGrant[]>
}

/** Live role facts used only to match role-subject grants on team T. */
export interface AclRoleFactSource {
  /** List role ids the user currently holds on this tenant and team only.
   * @param query - user, tenant, and team T from the authority query.
   * @returns role ids on that one team; never roles from other teams.
   */
  listRolesOnTeam(query: AclRoleFactQuery): Promise<readonly RoleId[]>
}
