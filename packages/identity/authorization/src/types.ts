/** Type contracts for product action authorization. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  AuthenticatedCall,
  AuthenticationRequestId,
  AuthenticationChannel,
} from '@deepseek-ai/dsh-authentication'

/** Stable product action owned by one domain package. */
export type PermissionCode = Branded<'PermissionCode'>

/** Opaque version of the live permission catalog and Provider policy. */
export type PolicyVersion = Branded<'PolicyVersion'>

/** Merge-extensible domain resource payload map keyed by resource kind. */
export interface AuthorizationResourceMap {}

/** One domain-owned resource reference, or `never` before a domain augments the map. */
export type AuthorizationResource = {
  [K in keyof AuthorizationResourceMap]: Readonly<{ kind: K } & AuthorizationResourceMap[K]>
}[keyof AuthorizationResourceMap]

/** Merge-extensible trusted environment fields supplied by enforcement owners. */
export interface AuthorizationEnvironmentMap {}

/** Trusted enforcement context that is not part of the client payload. */
export type AuthorizationEnvironment = Readonly<{
  [K in keyof AuthorizationEnvironmentMap]?: AuthorizationEnvironmentMap[K]
}>

/** Merge-extensible bounded obligation payload map. */
export interface AuthorizationObligationMap {}

/** Provider instruction represented only as immutable data. */
export type AuthorizationObligation = {
  [K in keyof AuthorizationObligationMap]: Readonly<{ kind: K } & AuthorizationObligationMap[K]>
}[keyof AuthorizationObligationMap]

/** Disclosure class administered for one permission. */
export type PermissionDisclosure =
  | 'none'
  | 'discovery'
  | 'metadata'
  | 'content'
  | 'source'
  | 'secret-use'
  | 'administration'

/** Live permission definition contributed by its owning domain package. */
export interface PermissionDefinition {
  readonly code: PermissionCode
  readonly owner: string
  readonly description: string
  readonly disclosure: PermissionDisclosure
  readonly resourceKind?: keyof AuthorizationResourceMap
}

/** One complete action decision request. */
export interface AuthorizationRequest {
  readonly call: AuthenticatedCall
  readonly permission: PermissionCode
  readonly resource?: AuthorizationResource
  readonly environment?: AuthorizationEnvironment
}

/** Stable internal reason retained for diagnostics and security audit consumers. */
export type AuthorizationDenialReason =
  | 'unauthenticated'
  | 'credential-expired'
  | 'permission-unregistered'
  | 'provider-denied'
  | 'provider-failed'
  | 'principal-unsupported'
  | 'policy-stale'

/** Public denial category safe to expose through a carrier. */
export interface AuthorizationPublicError {
  readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN'
}

/** Successful authorization decision. */
export interface AuthorizationAllowDecision {
  readonly effect: 'allow'
  readonly policyVersion: PolicyVersion
  readonly obligations: readonly AuthorizationObligation[]
}

/** Revocable lifetime bound to one previously allowed authorization request. */
export interface AuthorizationLease {
  /** Aborts when the call is cancelled, its credential expires, or its policy becomes stale. */
  readonly signal: AbortSignal
  /** Stop observing revocation without aborting the signal. */
  release(): void
}

/** Refused authorization decision. */
export interface AuthorizationDenyDecision {
  readonly effect: 'deny'
  readonly policyVersion: PolicyVersion
  readonly reason: AuthorizationDenialReason
  readonly publicError: AuthorizationPublicError
  readonly obligations: readonly AuthorizationObligation[]
}

/** Complete normalized authorization decision. */
export type AuthorizationDecision = AuthorizationAllowDecision | AuthorizationDenyDecision

/** Result returned by a concrete Provider after base checks succeed. */
export type AuthorizationProviderEffect =
  | { readonly effect: 'allow'; readonly obligations?: readonly AuthorizationObligation[] }
  | {
    readonly effect: 'deny'
    readonly reason: Exclude<AuthorizationDenialReason, 'unauthenticated' | 'credential-expired' | 'permission-unregistered' | 'provider-failed' | 'policy-stale'>
    readonly obligations?: readonly AuthorizationObligation[]
  }

/** Safe decision record emitted for audit and observability Consumers. */
export interface AuthorizationDecisionRecord {
  readonly requestId?: AuthenticationRequestId
  readonly channel?: AuthenticationChannel
  readonly principalKind?: AuthenticatedCall['principal']['kind']
  readonly permission: PermissionCode
  readonly effect: AuthorizationDecision['effect']
  readonly reason?: AuthorizationDenialReason
  readonly policyVersion: PolicyVersion
}

/** Effect-owned live permission directory. */
export interface PermissionCatalog {
  /** @param definition - Domain-owned permission metadata. @returns Effect disposer removing this exact definition. */
  register(definition: PermissionDefinition): () => Promise<void> | void
  /** @param code - Permission to resolve. @returns The live immutable definition, or `undefined`. */
  get(code: PermissionCode): PermissionDefinition | undefined
  /** @returns Definitions in registration order. */
  list(): readonly PermissionDefinition[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Committed permission-catalog or Provider-policy invalidation.
     * @param next - Current version after the commit.
     * @param previous - Version invalidated by the commit.
     * @mode emit
     */
    'authorization/invalidated'(next: PolicyVersion, previous: PolicyVersion): void

    /**
     * One normalized decision without resource contents or role-policy internals.
     * @param record - Safe decision record for audit Consumers.
     * @mode emit
     */
    'authorization/decision'(record: AuthorizationDecisionRecord): void
  }
}
