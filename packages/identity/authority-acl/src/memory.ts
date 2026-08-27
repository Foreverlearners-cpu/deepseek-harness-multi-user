import { teamId } from '@deepseek-ai/dsh-team'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import { aclSubjectRef, actionCode, resourceId, resourceType, roleId } from './ids.ts'
import type {
  AclGrant,
  AclResourceRef,
  AclRoleFactQuery,
  AclSubject,
  RoleId,
} from './types.ts'

function resourceKey(resource: AclResourceRef): string {
  return `${resource.type}\0${resource.id}`
}

function grantKey(grant: AclGrant): string {
  return `${resourceKey(grant.resource)}\0${aclSubjectRef(grant.subject)}`
}

function roleFactKey(query: AclRoleFactQuery, id: RoleId): string {
  return `${query.userId}\0${query.tenantId}\0${query.teamId}\0${id}`
}

function freezeSubject(subject: AclSubject): AclSubject {
  switch (subject.kind) {
    case 'everyone':
      return Object.freeze({ kind: 'everyone' })
    case 'user':
      return Object.freeze({ kind: 'user', id: userId(subject.id) })
    case 'role':
      return Object.freeze({ kind: 'role', id: roleId(subject.id) })
    case 'team':
      return Object.freeze({ kind: 'team', id: teamId(subject.id) })
    case 'tenant':
      return Object.freeze({ kind: 'tenant', id: tenantId(subject.id) })
  }
}

function freezeGrant(grant: AclGrant): AclGrant {
  return Object.freeze({
    resource: Object.freeze({
      type: resourceType(grant.resource.type),
      id: resourceId(grant.resource.id),
    }),
    subject: freezeSubject(grant.subject),
    use: Object.freeze(grant.use.map(entry => actionCode(entry))),
    delegate: Object.freeze(grant.delegate.map(entry => actionCode(entry))),
  })
}

/** Process-local object grants. Later MySQL replaces this source. */
export class MemoryAclPolicySource {
  private readonly grants = new Map<string, AclGrant>()

  /** Define or replace one grant row. A team subject stays one row.
   * @param grant - resource, subject, and the two action sets.
   */
  grant(grant: AclGrant): void {
    const current = freezeGrant(grant)
    this.grants.set(grantKey(current), current)
  }

  /** Remove one grant row when present.
   * @param resource - type and id that must both match.
   * @param subject - subject stored on the row.
   */
  revoke(resource: AclResourceRef, subject: AclSubject): void {
    this.grants.delete(grantKey({
      resource: {
        type: resourceType(resource.type),
        id: resourceId(resource.id),
      },
      subject,
      use: [],
      delegate: [],
    }))
  }

  /** List grants stored for this resource only.
   * @param resource - type and id that must both match the grant row.
   * @returns grants for that resource.
   */
  listGrants(resource: AclResourceRef): Promise<readonly AclGrant[]> {
    const type = resourceType(resource.type)
    const id = resourceId(resource.id)
    const matched: AclGrant[] = []
    for (const grant of this.grants.values()) {
      if (grant.resource.type === type && grant.resource.id === id) matched.push(grant)
    }
    return Promise.resolve(matched)
  }
}

/** Process-local role facts for matching role-subject grants. Not principal_roles. */
export class MemoryAclRoleFactSource {
  private readonly facts = new Map<string, RoleId>()

  /** Record that one user currently holds one role on one tenant-team pair.
   * @param query - user, tenant, and team T.
   * @param id - role held on that team.
   */
  assign(query: AclRoleFactQuery, id: RoleId): void {
    const current: AclRoleFactQuery = Object.freeze({
      userId: userId(query.userId),
      tenantId: tenantId(query.tenantId),
      teamId: teamId(query.teamId),
    })
    const role = roleId(id)
    this.facts.set(roleFactKey(current, role), role)
  }

  /** Drop one role fact when present.
   * @param query - user, tenant, and team T.
   * @param id - role previously held on that team.
   */
  revoke(query: AclRoleFactQuery, id: RoleId): void {
    this.facts.delete(roleFactKey({
      userId: userId(query.userId),
      tenantId: tenantId(query.tenantId),
      teamId: teamId(query.teamId),
    }, roleId(id)))
  }

  /** List role ids the user currently holds on this tenant and team only.
   * @param query - user, tenant, and team T.
   * @returns role ids on that one team.
   */
  listRolesOnTeam(query: AclRoleFactQuery): Promise<readonly RoleId[]> {
    const user = userId(query.userId)
    const tenant = tenantId(query.tenantId)
    const team = teamId(query.teamId)
    const roles: RoleId[] = []
    for (const [key, id] of this.facts) {
      if (key.startsWith(`${user}\0${tenant}\0${team}\0`)) roles.push(id)
    }
    return Promise.resolve(roles)
  }
}
