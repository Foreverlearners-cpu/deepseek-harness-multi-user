/**
 * Service Definition for product action authorization and the distributed
 * permission catalog. Providers decide only registered actions; the base
 * service owns call authenticity, policy versions, stale-decision rejection,
 * public denial errors, and safe decision events.
 * @module @deepseek-ai/dsh-authorization
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { isAuthenticatedCall } from '@deepseek-ai/dsh-authentication'
import type {
  AuthorizationAllowDecision,
  AuthorizationDecision,
  AuthorizationDecisionRecord,
  AuthorizationDenialReason,
  AuthorizationDenyDecision,
  AuthorizationLease,
  AuthorizationProviderEffect,
  AuthorizationRequest,
  PermissionCatalog,
  PermissionCode,
  PermissionDefinition,
  PermissionDisclosure,
  PolicyVersion,
} from './types.ts'

export type * from './types.ts'

const PERMISSION_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/
const OWNER_PATTERN = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9][a-z0-9._~-]*$/
const MAX_TIMER_DELAY_MS = 2_147_483_647
const DISCLOSURES = new Set<PermissionDisclosure>([
  'none',
  'discovery',
  'metadata',
  'content',
  'source',
  'secret-use',
  'administration',
])

/**
 * Validate and brand a product permission code.
 * @param value - Candidate `domain:action` value.
 * @returns Branded permission code.
 */
export function permissionCode(value: string): PermissionCode {
  if (!PERMISSION_PATTERN.test(value)) {
    throw new TypeError(`authorization: permission code ${JSON.stringify(value)} must match ${String(PERMISSION_PATTERN)}`)
  }
  return value as PermissionCode
}

function makePolicyVersion(epoch: string, revision: number): PolicyVersion {
  return `${epoch}:${String(revision)}` as PolicyVersion
}

/** Typed denial thrown by {@link AuthorizationProvider.require}. */
export class AuthorizationDeniedError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'AUTHORIZATION_DENIED'
  /** Host request correlation id, absent for a structurally forged call. */
  readonly requestId
  /** Requested product action. */
  readonly permission: PermissionCode
  /** Internal safe reason without resource or role details. */
  readonly reason: AuthorizationDenialReason
  /** Policy version that produced the denial. */
  readonly policyVersion: PolicyVersion
  /** Carrier-safe denial category. */
  readonly publicError: AuthorizationDenyDecision['publicError']

  /** @param request - Refused request. @param decision - Normalized denial. */
  constructor(request: AuthorizationRequest, decision: AuthorizationDenyDecision) {
    super(`authorization denied for ${request.permission}`)
    this.name = 'AuthorizationDeniedError'
    this.requestId = isAuthenticatedCall(request.call) ? request.call.requestId : undefined
    this.permission = request.permission
    this.reason = decision.reason
    this.policyVersion = decision.policyVersion
    this.publicError = decision.publicError
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Active action Authorization Provider and permission catalog. */
    authorization: AuthorizationProvider
  }
}

interface ActiveAuthorizationLease {
  readonly request: AuthorizationRequest
  readonly decision: AuthorizationAllowDecision
  readonly controller: AbortController
  readonly onCallAbort: () => void
  timeout: ReturnType<typeof setTimeout> | undefined
  released: boolean
}

/** Provider base owning default denial and live permission definitions. */
export abstract class AuthorizationProvider extends Service {
  private readonly definitions = new Map<PermissionCode, PermissionDefinition>()
  private readonly leases = new Set<ActiveAuthorizationLease>()
  private readonly epoch = randomUUID()
  private revision = 0

  /** @param ctx - Owning Host Context. */
  constructor(ctx: Context) {
    super(ctx, 'authorization')
    ctx.effect(() => () => {
      for (const lease of [...this.leases]) {
        const denial = this.deny('policy-stale', 'FORBIDDEN')
        this.publish(lease.request, denial)
        this.finishLease(lease, new AuthorizationDeniedError(lease.request, denial), true)
      }
    }, 'authorization: active leases')
  }

  /** Current opaque policy and permission-catalog version. */
  get policyVersion(): PolicyVersion {
    return makePolicyVersion(this.epoch, this.revision)
  }

  /** Permission directory whose registrations belong to the calling fiber. */
  get permissions(): PermissionCatalog {
    const owner = this.ctx
    return {
      register: definition => this.registerPermission(owner, definition),
      get: code => this.definitions.get(code),
      list: () => [...this.definitions.values()],
    }
  }

  /**
   * Decide one registered action. Invalid calls, expired credentials, unknown
   * permissions, Provider failures, and policy changes during evaluation deny.
   * @param request - Complete trusted authorization input.
   * @returns Normalized decision carrying the policy version used.
  */
  async decide(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    const authentication = this.ctx.get('authentication')
    if (authentication === undefined || !authentication.owns(request.call)) {
      return this.publish(request, this.deny('unauthenticated', 'UNAUTHENTICATED'))
    }
    if (request.call.expiresAt !== undefined && request.call.expiresAt <= Date.now()) {
      return this.publish(request, this.deny('credential-expired', 'UNAUTHENTICATED'))
    }
    const definition = this.definitions.get(request.permission)
    if (definition === undefined) {
      return this.publish(request, this.deny('permission-unregistered', 'FORBIDDEN'))
    }

    const version = this.policyVersion
    let effect: AuthorizationProviderEffect
    try {
      effect = await this.evaluate(request, definition)
    } catch (error) {
      this.ctx.logger.warn('authorization: Provider failed while deciding %s', request.permission)
      this.ctx.logger.warn(error)
      return this.publish(request, this.deny('provider-failed', 'FORBIDDEN'))
    }
    if (version !== this.policyVersion || this.definitions.get(request.permission) !== definition) {
      return this.publish(request, this.deny('policy-stale', 'FORBIDDEN'))
    }
    const obligations = Object.freeze([...(effect.obligations ?? [])])
    const decision: AuthorizationDecision = effect.effect === 'allow'
      ? Object.freeze({ effect: 'allow', policyVersion: version, obligations })
      : Object.freeze({
        effect: 'deny',
        policyVersion: version,
        reason: effect.reason,
        publicError: Object.freeze({ code: 'FORBIDDEN' as const }),
        obligations,
      })
    return this.publish(request, decision)
  }

  /**
   * Require one action and retain any bounded obligations on success.
   * @param request - Complete trusted authorization input.
   * @returns Allow decision.
   * @throws {@link AuthorizationDeniedError} for every denial.
   */
  async require(request: AuthorizationRequest): Promise<AuthorizationAllowDecision> {
    const decision = await this.decide(request)
    if (decision.effect === 'deny') throw new AuthorizationDeniedError(request, decision)
    return decision
  }

  /**
   * Re-validate an allow decision immediately before consuming it.
   *
   * Authorization often crosses asynchronous lookup boundaries.  A decision
   * therefore cannot be treated as a durable capability: credentials may
   * expire and the Provider policy or permission definition may be replaced
   * while a Gateway is resolving arguments.  Consumers call this method at
   * each execution boundary and stop on a typed denial when the decision is no
   * longer valid.
   *
   * @param request - The same authenticated action request used for `require`.
   * @param decision - The allow decision being consumed.
   * @throws {@link AuthorizationDeniedError} when the call or policy is stale.
   */
  assertCurrent(
    request: AuthorizationRequest,
    decision: AuthorizationAllowDecision,
  ): void {
    const authentication = this.ctx.get('authentication')
    let reason: AuthorizationDenialReason | undefined
    let publicCode: 'UNAUTHENTICATED' | 'FORBIDDEN' = 'FORBIDDEN'
    if (authentication === undefined || !authentication.owns(request.call)) {
      reason = 'unauthenticated'
      publicCode = 'UNAUTHENTICATED'
    } else if (request.call.expiresAt !== undefined && request.call.expiresAt <= Date.now()) {
      reason = 'credential-expired'
      publicCode = 'UNAUTHENTICATED'
    } else {
      const definition = this.definitions.get(request.permission)
      if (definition === undefined) reason = 'permission-unregistered'
      else if (decision.policyVersion !== this.policyVersion) reason = 'policy-stale'
      // A same-code replacement is a new policy even if a caller races the
      // revision update and observes the old version at another boundary.
      // The decision does not carry the definition object, so the version is
      // the authoritative replacement marker here.
    }
    if (reason === undefined) return
    const denial = this.deny(reason, publicCode)
    this.publish(request, denial)
    throw new AuthorizationDeniedError(request, denial)
  }

  /**
   * Keep a previously allowed decision live across a long-running operation.
   * The returned signal aborts on caller cancellation, credential expiry,
   * policy/catalog invalidation, or Provider disposal. Consumers must release
   * the lease when their operation ends.
   * @param request - The same authenticated request used for `require`.
   * @param decision - Current allow decision being consumed.
   * @returns Revocable authorization lifetime.
   * @throws {@link AuthorizationDeniedError} when the decision is already stale.
   */
  openLease(
    request: AuthorizationRequest,
    decision: AuthorizationAllowDecision,
  ): AuthorizationLease {
    this.assertCurrent(request, decision)
    const controller = new AbortController()
    const lease: ActiveAuthorizationLease = {
      request,
      decision,
      controller,
      onCallAbort: () => {
        this.finishLease(lease, request.call.signal.reason, true)
      },
      timeout: undefined,
      released: false,
    }
    this.leases.add(lease)
    request.call.signal.addEventListener('abort', lease.onCallAbort, { once: true })
    if (request.call.signal.aborted) lease.onCallAbort()
    else this.scheduleLeaseExpiry(lease)
    return Object.freeze({
      signal: controller.signal,
      release: () => { this.finishLease(lease) },
    })
  }

  /**
   * Compare a previously observed version with the live Provider policy.
   * @param version - Previously observed policy version.
   * @returns Whether it is still current.
   */
  isCurrent(version: PolicyVersion): boolean {
    return version === this.policyVersion
  }

  /**
   * Commit a Provider-owned grant or revocation invalidation.
   * @returns New policy version after emitting `authorization/invalidated`.
   */
  protected invalidatePolicy(): PolicyVersion {
    const previous = this.policyVersion
    this.revision += 1
    const next = this.policyVersion
    this.ctx.emit('authorization/invalidated', next, previous)
    for (const lease of [...this.leases]) this.abortStaleLease(lease)
    return next
  }

  /**
   * Evaluate a valid call against one current registered permission.
   * @param request - Authenticated request.
   * @param definition - Current immutable permission definition.
   * @returns Provider allow or deny effect.
   */
  protected abstract evaluate(
    request: AuthorizationRequest,
    definition: PermissionDefinition,
  ): Promise<AuthorizationProviderEffect>

  private registerPermission(owner: Context, definition: PermissionDefinition): () => Promise<void> | void {
    const normalized = normalizeDefinition(definition)
    return owner.effect(() => {
      if (this.definitions.has(normalized.code)) {
        throw new Error(`authorization: permission ${JSON.stringify(normalized.code)} already has an active owner`)
      }
      this.definitions.set(normalized.code, normalized)
      this.invalidatePolicy()
      return () => {
        if (this.definitions.get(normalized.code) !== normalized) return
        this.definitions.delete(normalized.code)
        this.invalidatePolicy()
      }
    }, `authorization.permissions.register(${normalized.code})`)
  }

  private scheduleLeaseExpiry(lease: ActiveAuthorizationLease): void {
    if (lease.released || lease.request.call.expiresAt === undefined) return
    const remaining = lease.request.call.expiresAt - Date.now()
    if (remaining <= 0) {
      this.abortStaleLease(lease)
      return
    }
    lease.timeout = setTimeout(() => {
      lease.timeout = undefined
      this.scheduleLeaseExpiry(lease)
    }, Math.min(remaining, MAX_TIMER_DELAY_MS))
  }

  private abortStaleLease(lease: ActiveAuthorizationLease): void {
    if (lease.released) return
    try {
      this.assertCurrent(lease.request, lease.decision)
    } catch (error) {
      this.finishLease(lease, error, true)
    }
  }

  private finishLease(lease: ActiveAuthorizationLease, reason?: unknown, abort = false): void {
    if (lease.released) return
    lease.released = true
    this.leases.delete(lease)
    lease.request.call.signal.removeEventListener('abort', lease.onCallAbort)
    if (lease.timeout !== undefined) clearTimeout(lease.timeout)
    lease.timeout = undefined
    if (abort && !lease.controller.signal.aborted) lease.controller.abort(reason)
  }

  private deny(reason: AuthorizationDenialReason, code: 'UNAUTHENTICATED' | 'FORBIDDEN'): AuthorizationDenyDecision {
    return Object.freeze({
      effect: 'deny',
      policyVersion: this.policyVersion,
      reason,
      publicError: Object.freeze({ code }),
      obligations: Object.freeze([]),
    })
  }

  private publish(request: AuthorizationRequest, decision: AuthorizationDecision): AuthorizationDecision {
    const valid = isAuthenticatedCall(request.call)
    const record: AuthorizationDecisionRecord = Object.freeze({
      ...(valid ? {
        requestId: request.call.requestId,
        channel: request.call.channel,
        principalKind: request.call.principal.kind,
      } : {}),
      permission: request.permission,
      effect: decision.effect,
      ...(decision.effect === 'deny' ? { reason: decision.reason } : {}),
      policyVersion: decision.policyVersion,
    })
    this.ctx.emit('authorization/decision', record)
    return decision
  }
}

function normalizeDefinition(definition: PermissionDefinition): PermissionDefinition {
  const code = permissionCode(definition.code)
  if (!OWNER_PATTERN.test(definition.owner)) {
    throw new TypeError(`authorization: permission owner ${JSON.stringify(definition.owner)} is not an npm package name`)
  }
  if (definition.description.trim().length === 0) {
    throw new TypeError(`authorization: permission ${JSON.stringify(code)} needs an administrative description`)
  }
  if (!DISCLOSURES.has(definition.disclosure)) {
    throw new TypeError(`authorization: permission ${JSON.stringify(code)} has an invalid disclosure class`)
  }
  return Object.freeze({
    code,
    owner: definition.owner,
    description: definition.description,
    disclosure: definition.disclosure,
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- downstream declaration merging can add resource kinds.
    ...(definition.resourceKind === undefined ? {} : { resourceKind: definition.resourceKind }),
  })
}

export default AuthorizationProvider
