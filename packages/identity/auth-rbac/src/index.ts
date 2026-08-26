/**
 * Team-scoped role catalog aggregation and the authority role-route Provider.
 * @module @deepseek-ai/dsh-auth-rbac
 */

import { Service } from '@deepseek-ai/cordis'
import type { ActionCode, AuthorityRouteQuery, AuthorityRouteResult } from '@deepseek-ai/dsh-authority/types'
import { teamId } from '@deepseek-ai/dsh-team'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import { actionCode, roleId } from './ids.ts'
import { MemoryRbacPolicySource } from './memory.ts'
import type {
  AuthRbacErrorCode,
  PrincipalRoleQuery,
  RbacPolicySource,
  RoleActionSets,
  RoleId,
} from './types.ts'

export type * from './types.ts'
export { MemoryRbacPolicySource, roleId }

/** Public RBAC failure with a stable transport-safe category. */
export class AuthRbacError extends Error {
  /** Stable category safe for transport mapping. */
  readonly code: AuthRbacErrorCode

  /** Construct a failure without Provider diagnostics. */
  constructor(code: AuthRbacErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AuthRbacError'
    this.code = code
  }
}

function invalid(message: string, options?: ErrorOptions): AuthRbacError {
  return new AuthRbacError('invalid-input', `auth-rbac: ${message}`, options)
}

function unavailable(message: string, options?: ErrorOptions): AuthRbacError {
  return new AuthRbacError('provider-unavailable', `auth-rbac: ${message}`, options)
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
  if (!Array.isArray(value)) throw unavailable('policy source returned an invalid role list')
  return value.map((entry) => {
    if (typeof entry !== 'string') throw unavailable('policy source returned an invalid role list')
    try {
      return roleId(entry)
    } catch (cause) {
      throw unavailable('policy source returned an invalid role list', { cause })
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

function actionSets(value: unknown): RoleActionSets {
  if (!isPlainObject(value)) throw unavailable('policy source returned invalid role actions')
  return Object.freeze({
    use: actionList(value.use, 'use'),
    delegate: actionList(value.delegate, 'delegate'),
  })
}

function principalQuery(value: unknown): PrincipalRoleQuery {
  if (!isPlainObject(value) || typeof value.userId !== 'string'
    || typeof value.tenantId !== 'string' || typeof value.teamId !== 'string') {
    throw invalid('query must include userId, tenantId, and teamId')
  }
  return Object.freeze({
    userId: userId(value.userId),
    tenantId: tenantId(value.tenantId),
    teamId: teamId(value.teamId),
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Active team-scoped role route that reports RoleUse or RoleDelegate on one team. */
    authRbac: AuthRbac
  }
}

/**
 * Role-route runtime. It unions role actions for one user on the query
 * team only, registers that set on `ctx.authority`, and never computes
 * Effective or reads object grants.
 */
export class AuthRbac extends Service {
  static inject = ['authority']

  private source: RbacPolicySource | undefined

  /** @param ctx - owning Host context. */
  constructor(ctx: ConstructorParameters<typeof Service>[0]) {
    super(ctx, 'authRbac')
    this.ctx.effect(() => {
      const authority = this.ctx.get('authority') as {
        registerRoute(
          route: 'role',
          provider: { evaluate: (query: AuthorityRouteQuery) => Promise<AuthorityRouteResult> },
        ): () => void
      }
      return authority.registerRoute('role', {
        evaluate: query => this.evaluate(query),
      })
    })
  }

  /** Register the sole policy source used to read roles and bindings.
   * @param source - reader for role definitions and team-scoped principal bindings.
   * @returns idempotent disposer that removes this exact registration.
   */
  registerSource(source: RbacPolicySource): () => void {
    if (typeof source.listPrincipalRoles !== 'function' || typeof source.listRoleActions !== 'function') {
      throw invalid('policy source must implement listPrincipalRoles and listRoleActions')
    }
    if (this.source !== undefined) {
      throw new AuthRbacError('conflict', 'auth-rbac: a policy source is already registered')
    }
    this.source = source
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.source = undefined
    }
  }

  /** Return RoleUse(T) or RoleDelegate(T) for the query team only.
   * @param query - resolved user, tenant, team, action, resource, and set.
   * @returns union of matching role actions on that one team.
   */
  async evaluate(query: AuthorityRouteQuery): Promise<AuthorityRouteResult> {
    try {
      return await this.collect(query)
    } catch (cause) {
      if (cause instanceof AuthRbacError) throw cause
      if (cause instanceof TypeError) throw invalid('query fields are invalid', { cause })
      throw unavailable('policy source failed', { cause })
    }
  }

  private async collect(query: AuthorityRouteQuery): Promise<AuthorityRouteResult> {
    if (!isPlainObject(query)) throw invalid('query must be an object')
    const set = requestedSet(query.set)
    const lookup = principalQuery(query)
    const source = this.source
    if (source === undefined) throw unavailable('policy source is not registered')
    const roles = roleList(await source.listPrincipalRoles(lookup))
    const actions = new Set<ActionCode>()
    for (const id of roles) {
      const grants = actionSets(await source.listRoleActions(id))
      for (const action of grants[set]) actions.add(action)
    }
    return Object.freeze({ actions: Object.freeze([...actions]) })
  }
}

export default AuthRbac
