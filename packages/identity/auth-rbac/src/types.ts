/** Host team-scoped RBAC types shared by policy sources and the role route. */

import type { ActionCode } from '@deepseek-ai/dsh-authority/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { TeamId } from '@deepseek-ai/dsh-team/types'
import type { TenantId } from '@deepseek-ai/dsh-tenant/types'
import type { UserId } from '@deepseek-ai/dsh-user/types'

/** Stable role identity, such as `runner` or `viewer`. */
export type RoleId = Branded<'RoleId'>

/** Lookup that returns a user's roles on exactly one tenant-team pair. */
export interface PrincipalRoleQuery {
  readonly userId: UserId
  readonly tenantId: TenantId
  readonly teamId: TeamId
}

/** Use and Delegate action sets owned by one role. The sets never substitute for each other. */
export interface RoleActionSets {
  readonly use: readonly ActionCode[]
  readonly delegate: readonly ActionCode[]
}

/** Catalog entry that binds one role to its Use and Delegate actions. */
export interface RoleDefinition {
  readonly roleId: RoleId
  readonly use: readonly ActionCode[]
  readonly delegate: readonly ActionCode[]
}

/** Binding of one user to one role on exactly one tenant-team pair. */
export interface PrincipalRoleBinding {
  readonly userId: UserId
  readonly tenantId: TenantId
  readonly teamId: TeamId
  readonly roleId: RoleId
}

/** Stable RBAC failure category safe for transport mapping. */
export type AuthRbacErrorCode =
  | 'invalid-input'
  | 'conflict'
  | 'provider-unavailable'

/** Read API for role definitions and team-scoped principal bindings. */
export interface RbacPolicySource {
  /** List role ids bound to the user on this tenant and team only.
   * @param query - user, tenant, and team that must all match the binding.
   * @returns role ids for that one team; never roles from other teams.
   */
  listPrincipalRoles(query: PrincipalRoleQuery): Promise<readonly RoleId[]>
  /** Return the Use and Delegate sets for one role.
   * @param roleId - catalogued role.
   * @returns action sets for that role.
   */
  listRoleActions(roleId: RoleId): Promise<RoleActionSets>
}
