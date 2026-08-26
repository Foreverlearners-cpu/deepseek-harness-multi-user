import { teamId } from '@deepseek-ai/dsh-team'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import { actionCode, roleId } from './ids.ts'
import type {
  PrincipalRoleBinding,
  PrincipalRoleQuery,
  RoleActionSets,
  RoleDefinition,
  RoleId,
} from './types.ts'

function bindingKey(binding: PrincipalRoleBinding): string {
  return `${binding.userId}\0${binding.tenantId}\0${binding.teamId}\0${binding.roleId}`
}

/** Process-local role catalog and principal-role bindings. Later MySQL replaces this source. */
export class MemoryRbacPolicySource {
  private readonly roles = new Map<RoleId, RoleActionSets>()
  private readonly bindings = new Map<string, PrincipalRoleBinding>()

  /** Define or replace one role's Use and Delegate sets.
   * @param definition - role id and the two action sets.
   */
  putRole(definition: RoleDefinition): void {
    const id = roleId(definition.roleId)
    this.roles.set(id, Object.freeze({
      use: Object.freeze(definition.use.map(entry => actionCode(entry))),
      delegate: Object.freeze(definition.delegate.map(entry => actionCode(entry))),
    }))
  }

  /** Bind one user to one role on exactly one tenant-team pair.
   * @param binding - user, tenant, team, and role.
   */
  assign(binding: PrincipalRoleBinding): void {
    const current: PrincipalRoleBinding = Object.freeze({
      userId: userId(binding.userId),
      tenantId: tenantId(binding.tenantId),
      teamId: teamId(binding.teamId),
      roleId: roleId(binding.roleId),
    })
    this.bindings.set(bindingKey(current), current)
  }

  /** Remove one principal-role binding when present.
   * @param binding - user, tenant, team, and role.
   */
  revoke(binding: PrincipalRoleBinding): void {
    this.bindings.delete(bindingKey({
      userId: userId(binding.userId),
      tenantId: tenantId(binding.tenantId),
      teamId: teamId(binding.teamId),
      roleId: roleId(binding.roleId),
    }))
  }

  /** List role ids bound to the user on this tenant and team only.
   * @param query - user, tenant, and team that must all match the binding.
   * @returns role ids for that one team.
   */
  listPrincipalRoles(query: PrincipalRoleQuery): Promise<readonly RoleId[]> {
    const user = userId(query.userId)
    const tenant = tenantId(query.tenantId)
    const team = teamId(query.teamId)
    const roles: RoleId[] = []
    for (const binding of this.bindings.values()) {
      if (binding.userId === user && binding.tenantId === tenant && binding.teamId === team) {
        roles.push(binding.roleId)
      }
    }
    return Promise.resolve(roles)
  }

  /** Return the Use and Delegate sets for one role.
   * @param id - catalogued role.
   * @returns action sets for that role.
   */
  listRoleActions(id: RoleId): Promise<RoleActionSets> {
    const grants = this.roles.get(roleId(id))
    if (grants === undefined) throw new Error(`auth-rbac: role "${id}" is not defined`)
    return Promise.resolve(grants)
  }
}
