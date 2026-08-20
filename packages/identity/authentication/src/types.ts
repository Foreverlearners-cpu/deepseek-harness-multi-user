/** Type contracts for authenticated Host calls. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Host-generated correlation id for one authenticated call. */
export type AuthenticationRequestId = Branded<'AuthenticationRequestId'>

/** Stable human account identity. */
export type UserId = Branded<'UserId'>

/** Stable non-human automation identity. */
export type ServiceAccountId = Branded<'ServiceAccountId'>

/** Stable principal identity used only by explicit local compositions. */
export type LocalPrincipalId = Branded<'LocalPrincipalId'>

/** Administrative and data-isolation identity. */
export type TenantId = Branded<'TenantId'>

/** Active relationship between one principal and one tenant. */
export type MembershipId = Branded<'MembershipId'>

/** Platform-level operator grant identity. */
export type OperatorGrantId = Branded<'OperatorGrantId'>

/** Verified authentication mechanism name. */
export type AuthenticationMethod = Branded<'AuthenticationMethod'>

/** Principal established by an Authentication Provider. */
export type AuthenticatedPrincipal =
  | { readonly kind: 'user'; readonly id: UserId }
  | { readonly kind: 'service-account'; readonly id: ServiceAccountId }
  | { readonly kind: 'local'; readonly id: LocalPrincipalId }

/** Trusted authorization scope selected during authentication. */
export type AuthenticatedScope =
  | {
    readonly kind: 'tenant'
    readonly tenantId: TenantId
    readonly membershipId: MembershipId
  }
  | {
    readonly kind: 'platform'
    readonly operatorGrantId: OperatorGrantId
  }

/** Merge-extensible carrier evidence owned by trusted transport adapters. */
export interface AuthenticationEvidenceMap {
  /** HTTP request retained by the Host adapter and never read from its JSON body. */
  http: { readonly kind: 'http'; readonly request: Request }
  /** Explicit same-process entry used by trusted local composition code. */
  'in-process': { readonly kind: 'in-process' }
}

/** Carrier family that supplied verified authentication evidence. */
export type AuthenticationChannel = Extract<keyof AuthenticationEvidenceMap, string>

/** One carrier-owned evidence value. */
export type AuthenticationEvidence = AuthenticationEvidenceMap[keyof AuthenticationEvidenceMap]

/** Trusted input submitted by a transport adapter to an Authentication Provider. */
export type AuthenticationAttempt = {
  [Channel in AuthenticationChannel]: {
    readonly requestId: AuthenticationRequestId
    readonly channel: Channel
    readonly evidence: AuthenticationEvidenceMap[Channel] & { readonly kind: Channel }
    readonly signal: AbortSignal
  }
}[AuthenticationChannel]

/** Identity facts returned by a Provider after it verifies one attempt. */
export interface VerifiedAuthentication {
  readonly principal: AuthenticatedPrincipal
  readonly method: AuthenticationMethod
  readonly scope: AuthenticatedScope
  /** Epoch milliseconds after which downstream checks must reject the call. */
  readonly expiresAt?: number
}

declare const AUTHENTICATED_CALL: unique symbol

/**
 * Immutable call context minted only by the active Authentication Service.
 * The private runtime issuer check is authoritative; this brand prevents
 * accidental structural construction in typed same-process code.
 */
export interface AuthenticatedCall extends VerifiedAuthentication {
  readonly [AUTHENTICATED_CALL]: true
  readonly requestId: AuthenticationRequestId
  readonly channel: AuthenticationChannel
  readonly signal: AbortSignal
}

/** Stable Authentication Provider failure category. */
export type AuthenticationErrorCode = 'unauthenticated' | 'authentication-unavailable'
