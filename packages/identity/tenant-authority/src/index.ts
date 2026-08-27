/**
 * Cross-tenant deny guard and the authority decide entry that hides existence.
 * @module @deepseek-ai/dsh-tenant-authority
 */

import { Service } from '@deepseek-ai/cordis'
import { AuthenticationError, type AuthenticatedCall } from '@deepseek-ai/dsh-auth'
import type {
  AuthorityDecision,
  AuthorityRequest,
  ResourceRef,
  ResourceResolver,
  ResourceType,
  TrustedResourceRef,
} from '@deepseek-ai/dsh-authority/types'
import { TenantDirectoryError, tenantId, type TenantId } from '@deepseek-ai/dsh-tenant'
import { userId, type UserId } from '@deepseek-ai/dsh-user'
import { actionCode, resourceId, resourceType } from './ids.ts'
import type {
  TenantAuthorityDecision,
  TenantAuthorityErrorCode,
  TenantAuthorityRequest,
  TenantAuthorityScope,
  TenantScopeDecision,
  TenantScopeQuery,
} from './types.ts'

export type * from './types.ts'

const ABSENT_MEMBERSHIP = new Set([
  'tenant-not-found',
  'tenant-disabled',
  'tenant-deleted',
  'membership-not-found',
  'membership-disabled',
  'membership-removed',
])

const HIDDEN_DENY: Extract<TenantScopeDecision, { outcome: 'deny' }> = Object.freeze({
  outcome: 'deny',
  code: 'unresolved-resource',
})

/** Public tenant-guard failure with a stable transport-safe category. */
export class TenantAuthorityError extends Error {
  /** Stable category safe for transport mapping. */
  readonly code: TenantAuthorityErrorCode

  /** Construct a failure without Provider diagnostics. */
  constructor(code: TenantAuthorityErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TenantAuthorityError'
    this.code = code
  }
}

function invalid(message: string, options?: ErrorOptions): TenantAuthorityError {
  return new TenantAuthorityError('invalid-input', `tenant-authority: ${message}`, options)
}

function unavailable(message: string, options?: ErrorOptions): TenantAuthorityError {
  return new TenantAuthorityError('provider-unavailable', `tenant-authority: ${message}`, options)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function requestedScope(value: unknown): TenantAuthorityScope {
  if (!isPlainObject(value) || typeof value.kind !== 'string') {
    throw invalid('scope must be tenant or platform')
  }
  if (value.kind === 'platform') return Object.freeze({ kind: 'platform' })
  if (value.kind !== 'tenant' || typeof value.tenantId !== 'string') {
    throw invalid('tenant scope must include tenantId')
  }
  return Object.freeze({ kind: 'tenant', tenantId: tenantId(value.tenantId) })
}

function resourcePointer(value: unknown): { readonly type: ResourceType; readonly id: ReturnType<typeof resourceId> } {
  if (!isPlainObject(value) || typeof value.type !== 'string' || typeof value.id !== 'string') {
    throw invalid('resource must include a type and id')
  }
  return Object.freeze({
    type: resourceType(value.type),
    id: resourceId(value.id),
  })
}

function trustedResource(
  value: unknown,
  expectedType: ResourceType,
  expectedId: ReturnType<typeof resourceId>,
): TrustedResourceRef {
  if (!isPlainObject(value) || typeof value.type !== 'string' || typeof value.id !== 'string'
    || typeof value.tenantId !== 'string' || typeof value.teamId !== 'string') {
    throw unavailable('resolver returned an invalid resource')
  }
  const type = resourceType(value.type)
  const id = resourceId(value.id)
  if (type !== expectedType || id !== expectedId) {
    throw unavailable('resolver returned a different resource')
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) {
    throw unavailable('resolver returned an invalid revision')
  }
  return Object.freeze({
    type,
    id,
    tenantId: tenantId(value.tenantId),
    teamId: value.teamId as TrustedResourceRef['teamId'],
    revision: value.revision as number,
  })
}

function scopeQuery(value: unknown): TenantScopeQuery {
  if (!isPlainObject(value) || typeof value.userId !== 'string' || typeof value.resourceTenantId !== 'string') {
    throw invalid('query must include userId, scope, and resourceTenantId')
  }
  return Object.freeze({
    userId: userId(value.userId),
    scope: requestedScope(value.scope),
    resourceTenantId: tenantId(value.resourceTenantId),
  })
}

interface TenantMembershipLookup {
  requireActiveMembership(id: TenantId, member: UserId): Promise<unknown>
}

interface AuthorityFace {
  decide(request: AuthorityRequest): Promise<AuthorityDecision>
  registerResolver(type: ResourceType, resolver: ResourceResolver): () => void
}

interface AuthFace {
  assertCurrent(value: unknown): AuthenticatedCall
}

async function isActiveTenantMember(
  tenants: TenantMembershipLookup,
  id: TenantId,
  member: UserId,
): Promise<boolean> {
  try {
    await tenants.requireActiveMembership(id, member)
    return true
  } catch (cause) {
    if (cause instanceof TenantDirectoryError && ABSENT_MEMBERSHIP.has(cause.code)) return false
    throw cause
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Active tenant-guard decide entry that hides cross-tenant existence. */
    tenantAuthority: TenantAuthority
  }
}

/**
 * Tenant-guard runtime. It compares the trusted actor scope to the resolved
 * resource tenant, registers resolvers on `ctx.authority`, and never computes
 * Effective or treats platform scope as tenant membership.
 */
export class TenantAuthority extends Service {
  static inject = ['auth', 'authority', 'tenants']

  private readonly resolvers = new Map<ResourceType, ResourceResolver>()
  private readonly resolverDisposers: Array<() => void> = []

  /** @param ctx - owning Host context. */
  constructor(ctx: ConstructorParameters<typeof Service>[0]) {
    super(ctx, 'tenantAuthority')
    this.ctx.effect(() => () => {
      for (const dispose of this.resolverDisposers.splice(0)) dispose()
      this.resolvers.clear()
    })
  }

  /** Register the sole resolver for one resource class on this guard and authority.
   * @param type - resource class this resolver owns.
   * @param resolver - domain lookup that returns tenant, team, and revision.
   * @returns idempotent disposer that removes this exact registration.
   */
  registerResolver(type: ResourceType, resolver: ResourceResolver): () => void {
    const key = resourceType(type)
    if (typeof resolver.resolve !== 'function') throw invalid('resource resolver must implement resolve')
    if (this.resolvers.has(key)) {
      throw new TenantAuthorityError('conflict', `tenant-authority: resource type "${key}" already has a resolver`)
    }
    const disposeAuthority = this.authority().registerResolver(key, resolver)
    this.resolvers.set(key, resolver)
    const dispose = (): void => {
      disposeAuthority()
      this.resolvers.delete(key)
    }
    this.resolverDisposers.push(dispose)
    return () => {
      const index = this.resolverDisposers.indexOf(dispose)
      if (index === -1) return
      this.resolverDisposers.splice(index, 1)
      dispose()
    }
  }

  /** Return whether the actor scope matches the resolved resource tenant.
   * @param query - user, trusted scope, and resolved resource tenant.
   * @returns allow when the tenant scope matches and membership is active.
   */
  async match(query: TenantScopeQuery): Promise<TenantScopeDecision> {
    try {
      return await this.matchScope(query)
    } catch (cause) {
      if (cause instanceof TenantAuthorityError && cause.code === 'invalid-input') throw cause
      if (cause instanceof TypeError) throw invalid('query fields are invalid', { cause })
      return { outcome: 'deny', code: 'provider-unavailable' }
    }
  }

  /** Decide whether the request is allowed. Cross-tenant ids deny as unresolved.
   * @param request - current call, action, resource pointer, purpose, and actor scope.
   * @returns allow with the trusted resource, or a deny category.
   */
  async decide(request: TenantAuthorityRequest): Promise<TenantAuthorityDecision> {
    try {
      return await this.collect(request)
    } catch (cause) {
      if (cause instanceof TenantAuthorityError) {
        if (cause.code === 'invalid-input' || cause.code === 'conflict') throw cause
        return { outcome: 'deny', code: cause.code }
      }
      if (cause instanceof AuthenticationError) return { outcome: 'deny', code: 'unauthenticated' }
      if (cause instanceof TypeError) throw invalid('request fields are invalid', { cause })
      return { outcome: 'deny', code: 'provider-unavailable' }
    }
  }

  /** Require an allow decision or throw the matching deny category.
   * @param request - current call, action, resource pointer, purpose, and actor scope.
   * @returns trusted resource used for the allow decision.
   */
  async require(request: TenantAuthorityRequest): Promise<TrustedResourceRef> {
    const decision = await this.decide(request)
    if (decision.outcome === 'deny') {
      throw new TenantAuthorityError(decision.code, `tenant-authority: ${decision.code.replaceAll('-', ' ')}`)
    }
    return decision.resource
  }

  private async collect(request: TenantAuthorityRequest): Promise<TenantAuthorityDecision> {
    if (!isPlainObject(request)) throw invalid('request must be an object')
    const scope = requestedScope(request.scope)
    const action = actionCode(request.action)
    const pointer = resourcePointer(request.resource)
    const call = this.requireUserCall(request.call)
    if (call === undefined || scope.kind === 'platform') return HIDDEN_DENY
    const resolver = this.resolvers.get(pointer.type)
    if (resolver === undefined) return { outcome: 'deny', code: 'missing-provider' }
    const membership = await this.matchScope({
      userId: call.principal.id,
      scope,
      resourceTenantId: scope.tenantId,
    })
    if (membership.outcome === 'deny') return membership
    let resolved: TrustedResourceRef
    try {
      const value = await resolver.resolve(pointer)
      if (value === undefined) return HIDDEN_DENY
      resolved = trustedResource(value, pointer.type, pointer.id)
    } catch (cause) {
      if (cause instanceof TenantAuthorityError) throw cause
      throw unavailable('resolver failed', { cause })
    }
    const matched = await this.matchScope({
      userId: call.principal.id,
      scope,
      resourceTenantId: resolved.tenantId,
    })
    if (matched.outcome === 'deny') return matched
    return this.authority().decide({
      call,
      action,
      resource: { type: pointer.type, id: pointer.id } satisfies ResourceRef,
      ...(request.purpose === undefined ? {} : { purpose: request.purpose }),
    })
  }

  private async matchScope(query: TenantScopeQuery): Promise<TenantScopeDecision> {
    const current = scopeQuery(query)
    if (current.scope.kind === 'platform') return HIDDEN_DENY
    if (current.scope.tenantId !== current.resourceTenantId) return HIDDEN_DENY
    if (!await isActiveTenantMember(this.tenants(), current.scope.tenantId, current.userId)) {
      return HIDDEN_DENY
    }
    return Object.freeze({ outcome: 'allow' })
  }

  private requireUserCall(
    value: unknown,
  ): (AuthenticatedCall & { readonly principal: { readonly kind: 'user'; readonly id: UserId } }) | undefined {
    const call = this.auth().assertCurrent(value)
    if (call.principal.kind !== 'user') return undefined
    userId(call.principal.id)
    return call as AuthenticatedCall & { readonly principal: { readonly kind: 'user'; readonly id: UserId } }
  }

  private authority(): AuthorityFace {
    return this.ctx.get('authority') as AuthorityFace
  }

  private tenants(): TenantMembershipLookup {
    return this.ctx.get('tenants') as TenantMembershipLookup
  }

  private auth(): AuthFace {
    return this.ctx.get('auth') as AuthFace
  }
}

export default TenantAuthority
