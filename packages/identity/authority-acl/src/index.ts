/**
 * Object-grant catalog aggregation and the authority object-route Provider.
 * @module @deepseek-ai/dsh-authority-acl
 */

import { Service } from '@deepseek-ai/cordis'
import type { ActionCode, AuthorityRouteQuery, AuthorityRouteResult } from '@deepseek-ai/dsh-authority/types'
import { TeamDirectoryError, teamId, type TeamId } from '@deepseek-ai/dsh-team'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId, type UserId } from '@deepseek-ai/dsh-user'
import { aclSubjectFromRef, aclSubjectRef, actionCode, resourceId, resourceType, roleId } from './ids.ts'
import { MemoryAclPolicySource, MemoryAclRoleFactSource } from './memory.ts'
import type {
  AclGrant,
  AclPolicySource,
  AclResourceRef,
  AclRoleFactQuery,
  AclRoleFactSource,
  AclSubject,
  AuthorityAclErrorCode,
  RoleId,
} from './types.ts'

export type * from './types.ts'
export {
  aclSubjectFromRef,
  aclSubjectRef,
  MemoryAclPolicySource,
  MemoryAclRoleFactSource,
  roleId,
}

const ABSENT_MEMBERSHIP = new Set([
  'team-not-found',
  'team-disabled',
  'team-deleted',
  'membership-not-found',
  'membership-disabled',
  'membership-removed',
])

/** Public ACL failure with a stable transport-safe category. */
export class AuthorityAclError extends Error {
  /** Stable category safe for transport mapping. */
  readonly code: AuthorityAclErrorCode

  /** Construct a failure without Provider diagnostics. */
  constructor(code: AuthorityAclErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AuthorityAclError'
    this.code = code
  }
}

function invalid(message: string, options?: ErrorOptions): AuthorityAclError {
  return new AuthorityAclError('invalid-input', `authority-acl: ${message}`, options)
}

function unavailable(message: string, options?: ErrorOptions): AuthorityAclError {
  return new AuthorityAclError('provider-unavailable', `authority-acl: ${message}`, options)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requestedSet(value: unknown): 'use' | 'delegate' {
  if (value === 'use' || value === 'delegate') return value
  throw invalid('set must be use or delegate')
}

function roleList(value: unknown): readonly RoleId[] {
  if (!Array.isArray(value)) throw unavailable('role fact source returned an invalid role list')
  return value.map((entry) => {
    if (typeof entry !== 'string') throw unavailable('role fact source returned an invalid role list')
    try {
      return roleId(entry)
    } catch (cause) {
      throw unavailable('role fact source returned an invalid role list', { cause })
    }
  })
}

function actionList(value: unknown, label: string): readonly ActionCode[] {
  if (!Array.isArray(value)) throw unavailable(`policy source returned an invalid ${label} set`)
  return value.map((entry) => {
    if (typeof entry !== 'string') throw unavailable(`policy source returned an invalid ${label} set`)
    try {
      return actionCode(entry)
    } catch (cause) {
      throw unavailable(`policy source returned an invalid ${label} set`, { cause })
    }
  })
}

function aclSubject(value: unknown): AclSubject {
  if (!isPlainObject(value) || typeof value.kind !== 'string') {
    throw unavailable('policy source returned an invalid subject')
  }
  try {
    switch (value.kind) {
      case 'everyone':
        return Object.freeze({ kind: 'everyone' })
      case 'user':
        if (typeof value.id !== 'string') throw new TypeError('user subject id is required')
        return Object.freeze({ kind: 'user', id: userId(value.id) })
      case 'role':
        if (typeof value.id !== 'string') throw new TypeError('role subject id is required')
        return Object.freeze({ kind: 'role', id: roleId(value.id) })
      case 'team':
        if (typeof value.id !== 'string') throw new TypeError('team subject id is required')
        return Object.freeze({ kind: 'team', id: teamId(value.id) })
      case 'tenant':
        if (typeof value.id !== 'string') throw new TypeError('tenant subject id is required')
        return Object.freeze({ kind: 'tenant', id: tenantId(value.id) })
      default:
        throw new TypeError('subject kind is not supported')
    }
  } catch (cause) {
    throw unavailable('policy source returned an invalid subject', { cause })
  }
}

function aclResource(value: unknown): AclResourceRef {
  if (!isPlainObject(value) || typeof value.type !== 'string' || typeof value.id !== 'string') {
    throw unavailable('policy source returned an invalid resource')
  }
  try {
    return Object.freeze({
      type: resourceType(value.type),
      id: resourceId(value.id),
    })
  } catch (cause) {
    throw unavailable('policy source returned an invalid resource', { cause })
  }
}

function grantList(value: unknown): readonly AclGrant[] {
  if (!Array.isArray(value)) throw unavailable('policy source returned an invalid grant list')
  return value.map((entry) => {
    if (!isPlainObject(entry)) throw unavailable('policy source returned an invalid grant list')
    return Object.freeze({
      resource: aclResource(entry.resource),
      subject: aclSubject(entry.subject),
      use: actionList(entry.use, 'use'),
      delegate: actionList(entry.delegate, 'delegate'),
    })
  })
}

function roleFactQuery(value: Record<string, unknown>): AclRoleFactQuery {
  if (typeof value.userId !== 'string' || typeof value.tenantId !== 'string' || typeof value.teamId !== 'string') {
    throw invalid('query must include userId, tenantId, and teamId')
  }
  return Object.freeze({
    userId: userId(value.userId),
    tenantId: tenantId(value.tenantId),
    teamId: teamId(value.teamId),
  })
}

function queryResource(value: unknown): AclResourceRef {
  if (!isPlainObject(value)) throw invalid('query resource must be an object')
  if (typeof value.type !== 'string' || typeof value.id !== 'string') {
    throw invalid('query resource must include type and id')
  }
  return Object.freeze({
    type: resourceType(value.type),
    id: resourceId(value.id),
  })
}

interface TeamMembershipLookup {
  requireActiveMembership(id: TeamId, member: UserId): Promise<unknown>
}

async function isActiveTeamMember(teams: TeamMembershipLookup, id: TeamId, member: UserId): Promise<boolean> {
  try {
    await teams.requireActiveMembership(id, member)
    return true
  } catch (cause) {
    if (cause instanceof TeamDirectoryError && ABSENT_MEMBERSHIP.has(cause.code)) return false
    throw cause
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Active object-grant route that reports ObjectUse or ObjectDelegate on one team. */
    authorityAcl: AuthorityAcl
  }
}

/**
 * Object-route runtime. It unions object-grant actions that match the
 * query team and live subject facts, registers that set on `ctx.authority`,
 * and never computes Effective or reads principal_roles.
 */
export class AuthorityAcl extends Service {
  static inject = ['authority', 'teams']

  private source: AclPolicySource | undefined
  private roles: AclRoleFactSource | undefined

  /** @param ctx - owning Host context. */
  constructor(ctx: ConstructorParameters<typeof Service>[0]) {
    super(ctx, 'authorityAcl')
    this.ctx.effect(() => {
      const authority = this.ctx.get('authority') as {
        registerRoute(
          route: 'object',
          provider: { evaluate: (query: AuthorityRouteQuery) => Promise<AuthorityRouteResult> },
        ): () => void
      }
      return authority.registerRoute('object', {
        evaluate: query => this.evaluate(query),
      })
    })
  }

  /** Register the sole policy source used to read object grants.
   * @param source - reader for per-resource grant rows.
   * @returns idempotent disposer that removes this exact registration.
   */
  registerSource(source: AclPolicySource): () => void {
    if (typeof source.listGrants !== 'function') {
      throw invalid('policy source must implement listGrants')
    }
    if (this.source !== undefined) {
      throw new AuthorityAclError('conflict', 'authority-acl: a policy source is already registered')
    }
    this.source = source
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.source = undefined
    }
  }

  /** Register the sole role-fact source used to match role-subject grants.
   * @param source - reader for roles the user currently holds on team T.
   * @returns idempotent disposer that removes this exact registration.
   */
  registerRoleFacts(source: AclRoleFactSource): () => void {
    if (typeof source.listRolesOnTeam !== 'function') {
      throw invalid('role fact source must implement listRolesOnTeam')
    }
    if (this.roles !== undefined) {
      throw new AuthorityAclError('conflict', 'authority-acl: a role fact source is already registered')
    }
    this.roles = source
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.roles = undefined
    }
  }

  /** Return ObjectUse(T) or ObjectDelegate(T) for the query team only.
   * @param query - resolved user, tenant, team, action, resource, and set.
   * @returns union of matching object-grant actions on that one team.
   */
  async evaluate(query: AuthorityRouteQuery): Promise<AuthorityRouteResult> {
    try {
      return await this.collect(query)
    } catch (cause) {
      if (cause instanceof AuthorityAclError) throw cause
      if (cause instanceof TypeError) throw invalid('query fields are invalid', { cause })
      throw unavailable('policy source failed', { cause })
    }
  }

  private async collect(query: AuthorityRouteQuery): Promise<AuthorityRouteResult> {
    if (!isPlainObject(query)) throw invalid('query must be an object')
    const set = requestedSet(query.set)
    const lookup = roleFactQuery(query)
    const resource = queryResource(query.resource)
    const source = this.source
    if (source === undefined) throw unavailable('policy source is not registered')
    const grants = grantList(await source.listGrants(resource))
    const actions = new Set<ActionCode>()
    for (const grant of grants) {
      if (grant.resource.type !== resource.type || grant.resource.id !== resource.id) continue
      if (!await this.subjectMatches(grant.subject, lookup)) continue
      for (const action of grant[set]) actions.add(action)
    }
    return Object.freeze({ actions: Object.freeze([...actions]) })
  }

  private async subjectMatches(subject: AclSubject, query: AclRoleFactQuery): Promise<boolean> {
    switch (subject.kind) {
      case 'everyone':
        return true
      case 'user':
        return subject.id === query.userId
      case 'tenant':
        return subject.id === query.tenantId
      case 'team':
        if (subject.id !== query.teamId) return false
        return isActiveTeamMember(this.teams(), subject.id, query.userId)
      case 'role': {
        const roles = this.roles
        if (roles === undefined) throw unavailable('role fact source is not registered')
        return roleList(await roles.listRolesOnTeam(query)).includes(subject.id)
      }
    }
  }

  private teams(): TeamMembershipLookup {
    return this.ctx.get('teams') as TeamMembershipLookup
  }
}

export default AuthorityAcl
