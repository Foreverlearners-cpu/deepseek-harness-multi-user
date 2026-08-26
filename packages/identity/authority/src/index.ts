/**
 * Provider-independent authorization decisions, action catalog, and same-team intersection.
 * @module @deepseek-ai/dsh-authority
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { AuthenticationError, type AuthenticatedCall } from '@deepseek-ai/dsh-auth'
import { teamId } from '@deepseek-ai/dsh-team'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId, type UserId } from '@deepseek-ai/dsh-user'
import type {
  ActionCode,
  ActionDefinition,
  AuthorityDecision,
  AuthorityDenyCode,
  AuthorityErrorCode,
  AuthorityPurpose,
  AuthorityRequest,
  AuthorityRoute,
  AuthorityRouteProvider,
  AuthorityRouteQuery,
  ResourceId,
  ResourceResolver,
  ResourceType,
  TrustedResourceRef,
} from './types.ts'

export type * from './types.ts'

const ACTION_PATTERN = /^[A-Za-z][A-Za-z0-9-]*:[A-Za-z][A-Za-z0-9-]*$/
const TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/

/** Brand a catalogued action after validation.
 * @param value - untrusted action candidate.
 * @returns validated action.
 */
export function actionCode(value: string): ActionCode {
  if (!ACTION_PATTERN.test(value)) {
    throw new TypeError(`authority: action must match ${String(ACTION_PATTERN)}`)
  }
  return value as ActionCode
}

/** Brand a resource class after validation.
 * @param value - untrusted resource type candidate.
 * @returns validated resource type.
 */
export function resourceType(value: string): ResourceType {
  if (!TYPE_PATTERN.test(value)) {
    throw new TypeError(`authority: resource type must match ${String(TYPE_PATTERN)}`)
  }
  return value as ResourceType
}

/** Brand a resolved resource id after validation.
 * @param value - untrusted resource id candidate.
 * @returns validated resource id.
 */
export function resourceId(value: string): ResourceId {
  if (!ID_PATTERN.test(value)) {
    throw new TypeError(`authority: resource id must match ${String(ID_PATTERN)}`)
  }
  return value as ResourceId
}

/** Public authorization failure with a stable transport-safe category. */
export class AuthorityError extends Error {
  /** Stable category safe for transport mapping. */
  readonly code: AuthorityErrorCode

  /** Construct a failure without Provider diagnostics. */
  constructor(code: AuthorityErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AuthorityError'
    this.code = code
  }
}

function invalid(message: string, options?: ErrorOptions): AuthorityError {
  return new AuthorityError('invalid-input', `authority: ${message}`, options)
}

function deny(code: AuthorityDenyCode): AuthorityDecision {
  return Object.freeze({ outcome: 'deny', code })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AuthorityError('provider-unavailable', 'authority: resolver returned an invalid revision')
  }
  return value as number
}

function requestedPurpose(value: unknown): AuthorityPurpose {
  if (value === undefined || value === 'use') return 'use'
  if (value === 'delegate') return 'delegate'
  throw invalid('purpose must be use or delegate')
}

function requestedRoute(value: unknown): AuthorityRoute {
  if (value !== 'role' && value !== 'object') throw invalid('route must be role or object')
  return value
}

function resourcePointer(value: unknown): { readonly type: ResourceType; readonly id: ResourceId } {
  if (!isPlainObject(value) || typeof value.type !== 'string' || typeof value.id !== 'string') {
    throw invalid('resource must include a type and id')
  }
  return Object.freeze({
    type: resourceType(value.type),
    id: resourceId(value.id),
  })
}

function trustedResource(value: unknown, expectedType: ResourceType, expectedId: ResourceId): TrustedResourceRef {
  try {
    if (!isPlainObject(value) || typeof value.type !== 'string' || typeof value.id !== 'string'
      || typeof value.tenantId !== 'string' || typeof value.teamId !== 'string') {
      throw new AuthorityError('provider-unavailable', 'authority: resolver returned an invalid resource')
    }
    const type = resourceType(value.type)
    const id = resourceId(value.id)
    if (type !== expectedType || id !== expectedId) {
      throw new AuthorityError('provider-unavailable', 'authority: resolver returned a different resource')
    }
    return Object.freeze({
      type,
      id,
      tenantId: tenantId(value.tenantId),
      teamId: teamId(value.teamId),
      revision: revision(value.revision),
    })
  } catch (cause) {
    if (cause instanceof AuthorityError) throw cause
    throw new AuthorityError('provider-unavailable', 'authority: resolver returned an invalid resource', { cause })
  }
}

function routeResult(value: unknown): ReadonlySet<ActionCode> {
  try {
    if (!isPlainObject(value) || !Array.isArray(value.actions)) {
      throw new AuthorityError('provider-unavailable', 'authority: route Provider returned an invalid action set')
    }
    const actions = new Set<ActionCode>()
    for (const entry of value.actions) {
      if (typeof entry !== 'string') {
        throw new AuthorityError('provider-unavailable', 'authority: route Provider returned an invalid action set')
      }
      actions.add(actionCode(entry))
    }
    return actions
  } catch (cause) {
    if (cause instanceof AuthorityError) throw cause
    throw new AuthorityError('provider-unavailable', 'authority: route Provider returned an invalid action set', { cause })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Active authorization decision runtime. */
    authority: Authority
  }
}

/**
 * Authorization runtime. Route Providers report per-team Use or Delegate
 * sets; this service intersects those sets on the resolved resource team
 * and never unions teams.
 */
export class Authority extends Service {
  static inject = ['auth']

  private readonly actions = new Map<ActionCode, ActionDefinition>()
  private readonly routes = new Map<AuthorityRoute, AuthorityRouteProvider>()
  private readonly resolvers = new Map<ResourceType, ResourceResolver>()

  /** @param ctx - owning Host context. */
  constructor(ctx: Context) {
    super(ctx, 'authority')
  }

  /** Register one catalogued action. Duplicate actions fail with conflict.
   * @param definition - action and the resource class it may target.
   * @returns idempotent disposer that removes this exact registration.
   */
  registerAction(definition: ActionDefinition): () => void {
    const action = actionCode(definition.action)
    const type = resourceType(definition.resourceType)
    if (this.actions.has(action)) {
      throw new AuthorityError('conflict', `authority: action "${action}" is already registered`)
    }
    const current: ActionDefinition = Object.freeze({ action, resourceType: type })
    this.actions.set(action, current)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.actions.delete(action)
    }
  }

  /** Register the sole Provider for one authorization route.
   * @param route - `role` or `object`.
   * @param provider - evaluator that returns the Use or Delegate set on one team.
   * @returns idempotent disposer that removes this exact registration.
   */
  registerRoute(route: AuthorityRoute, provider: AuthorityRouteProvider): () => void {
    const key = requestedRoute(route)
    if (typeof provider.evaluate !== 'function') throw invalid('route Provider must implement evaluate')
    if (this.routes.has(key)) {
      throw new AuthorityError('conflict', `authority: route "${key}" already has a Provider`)
    }
    this.routes.set(key, provider)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.routes.delete(key)
    }
  }

  /** Register the sole resolver for one resource class.
   * @param type - resource class this resolver owns.
   * @param resolver - domain lookup that returns tenant, team, and revision.
   * @returns idempotent disposer that removes this exact registration.
   */
  registerResolver(type: ResourceType, resolver: ResourceResolver): () => void {
    const key = resourceType(type)
    if (typeof resolver.resolve !== 'function') throw invalid('resource resolver must implement resolve')
    if (this.resolvers.has(key)) {
      throw new AuthorityError('conflict', `authority: resource type "${key}" already has a resolver`)
    }
    this.resolvers.set(key, resolver)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.resolvers.delete(key)
    }
  }

  /** Decide whether the request is allowed. Policy failures are deny, not throws.
   * @param request - current call, action, untrusted resource pointer, and purpose.
   * @returns allow with the trusted resource, or a deny category.
   */
  async decide(request: AuthorityRequest): Promise<AuthorityDecision> {
    try {
      return await this.evaluate(request)
    } catch (cause) {
      if (cause instanceof AuthorityError && cause.code === 'invalid-input') throw cause
      if (cause instanceof AuthorityError) return deny(cause.code as AuthorityDenyCode)
      if (cause instanceof AuthenticationError) return deny('unauthenticated')
      if (cause instanceof TypeError) throw invalid('request fields are invalid', { cause })
      return deny('provider-unavailable')
    }
  }

  /** Require an allow decision or throw the matching deny category.
   * @param request - current call, action, untrusted resource pointer, and purpose.
   * @returns trusted resource used for the allow decision.
   */
  async require(request: AuthorityRequest): Promise<TrustedResourceRef> {
    const decision = await this.decide(request)
    if (decision.outcome === 'deny') {
      throw new AuthorityError(decision.code, `authority: ${decision.code.replaceAll('-', ' ')}`)
    }
    return decision.resource
  }

  private async evaluate(request: AuthorityRequest): Promise<AuthorityDecision> {
    if (!isPlainObject(request)) throw invalid('request must be an object')
    const purpose = requestedPurpose(request.purpose)
    const action = actionCode(request.action)
    const pointer = resourcePointer(request.resource)
    const call = this.requireUserCall(request.call)
    const definition = this.actions.get(action)
    if (definition === undefined) return deny('unknown-action')
    if (definition.resourceType !== pointer.type) return deny('unknown-action')
    const resolver = this.resolvers.get(pointer.type)
    const role = this.routes.get('role')
    const object = this.routes.get('object')
    if (resolver === undefined || role === undefined || object === undefined) return deny('missing-provider')
    const resolved = await resolver.resolve(pointer)
    if (resolved === undefined) return deny('unresolved-resource')
    const resource = trustedResource(resolved, pointer.type, pointer.id)
    const query: AuthorityRouteQuery = Object.freeze({
      userId: call.principal.id,
      tenantId: resource.tenantId,
      teamId: resource.teamId,
      action,
      resource,
      set: purpose,
    })
    const roleSet = routeResult(await role.evaluate(query))
    const objectSet = routeResult(await object.evaluate(query))
    if (!roleSet.has(action) || !objectSet.has(action)) return deny('insufficient-permission')
    return Object.freeze({ outcome: 'allow', resource })
  }

  private requireUserCall(value: unknown): AuthenticatedCall & { readonly principal: { readonly kind: 'user'; readonly id: UserId } } {
    const call = this.ctx.auth.assertCurrent(value)
    if (call.principal.kind !== 'user') {
      throw new AuthorityError('insufficient-permission', 'authority: only a user principal may be authorized')
    }
    userId(call.principal.id)
    return call as AuthenticatedCall & { readonly principal: { readonly kind: 'user'; readonly id: UserId } }
  }
}

export default Authority
