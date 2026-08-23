/** Host authentication types shared by Providers and Consumers. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Host-generated correlation id for one authentication attempt. */
export type AuthenticationRequestId = Branded<'AuthenticationRequestId'>
/** Stable human-account identity. */
export type UserId = Branded<'UserId'>
/** Stable non-human automation identity. */
export type ServiceAccountId = Branded<'ServiceAccountId'>
/** Stable identity used only by an explicit local Provider. */
export type LocalPrincipalId = Branded<'LocalPrincipalId'>
/** Stable authentication mechanism name, such as `jwt` or `api-key`. */
export type AuthenticationMethod = Branded<'AuthenticationMethod'>
/** Stable identity of one credential without exposing its secret. */
export type CredentialId = Branded<'CredentialId'>
/** Stable family identity shared by rotating access and refresh credentials. */
export type TokenFamilyId = Branded<'TokenFamilyId'>

/** Principal established by an Authentication Provider. */
export type AuthenticatedPrincipal =
  | { readonly kind: 'user'; readonly id: UserId }
  | { readonly kind: 'service-account'; readonly id: ServiceAccountId }
  | { readonly kind: 'local'; readonly id: LocalPrincipalId }

/** Merge-extensible evidence owned by trusted transport adapters. */
export interface AuthenticationEvidenceMap {
  /** Explicit same-process evidence used by local and test Providers. */
  'in-process': { readonly kind: 'in-process' }
}

/** Evidence kind used to select exactly one Authentication Provider. */
export type AuthenticationEvidenceKind = Extract<keyof AuthenticationEvidenceMap, string>
/** Carrier family that supplied authentication evidence. */
export type AuthenticationChannel = 'http' | 'websocket' | 'sdk' | 'acp' | 'in-process'

/** Trusted input submitted by a transport Consumer for one evidence kind. */
export type AuthenticationAttempt<K extends AuthenticationEvidenceKind = AuthenticationEvidenceKind> =
  K extends AuthenticationEvidenceKind ? {
    readonly requestId: AuthenticationRequestId
    readonly channel: AuthenticationChannel
    readonly evidence: AuthenticationEvidenceMap[K]
    readonly signal: AbortSignal
    readonly audience?: string
  } : never

/** Identity facts returned after a Provider verifies carrier evidence. */
export interface VerifiedAuthentication {
  readonly principal: AuthenticatedPrincipal
  readonly credentialId?: CredentialId
  readonly authenticatedAt: number
  readonly expiresAt?: number
}

declare const AUTHENTICATED_CALL: unique symbol

/** Immutable request identity minted only by the active authentication service. */
export interface AuthenticatedCall extends VerifiedAuthentication {
  readonly [AUTHENTICATED_CALL]: true
  readonly requestId: AuthenticationRequestId
  readonly channel: AuthenticationChannel
  readonly method: AuthenticationMethod
  readonly signal: AbortSignal
}

/** Stable authentication failure category safe for transport mapping. */
export type AuthenticationErrorCode =
  | 'unauthenticated'
  | 'authentication-unavailable'
  | 'provider-conflict'
  | 'credential-operation-unsupported'

/** Secret-bearing credential returned only by issue or refresh operations. */
export interface IssuedCredential {
  readonly kind: 'access' | 'refresh' | 'api-key'
  readonly id: CredentialId
  readonly value: string
  readonly expiresAt?: number
  readonly tokenFamilyId?: TokenFamilyId
}

/** Detached credentials returned by one lifecycle operation. */
export interface IssuedCredentialSet {
  readonly credentials: readonly IssuedCredential[]
}

/** Shared correlation and cancellation fields for credential lifecycle operations. */
export interface CredentialOperationRequest {
  readonly requestId: AuthenticationRequestId
  readonly signal: AbortSignal
}

/** Request to issue credentials after an upstream identity proof succeeds. */
export interface CredentialIssueRequest extends CredentialOperationRequest {
  readonly principal: AuthenticatedPrincipal
}

/** Request to rotate one refresh credential. */
export interface CredentialRefreshRequest extends CredentialOperationRequest {
  readonly refreshToken: string
}

/** Target used to inspect credential state without exposing its secret. */
export type CredentialInspectTarget =
  | { readonly kind: 'credential'; readonly credentialId: CredentialId }
  | { readonly kind: 'token-family'; readonly tokenFamilyId: TokenFamilyId }
  | { readonly kind: 'principal'; readonly principal: AuthenticatedPrincipal }

/** Request to inspect current credential metadata. */
export interface CredentialInspectRequest extends CredentialOperationRequest {
  readonly target: CredentialInspectTarget
}

/** Safe credential metadata returned by lifecycle inspection. */
export interface AuthenticationCredentialInfo {
  readonly id: CredentialId
  readonly kind: IssuedCredential['kind']
  readonly active: boolean
  readonly expiresAt?: number
  readonly tokenFamilyId?: TokenFamilyId
}

/** Request to revoke one credential, token family, or principal's credentials. */
export interface CredentialRevokeRequest extends CredentialOperationRequest {
  readonly target: CredentialInspectTarget
}

/** Optional lifecycle capabilities implemented by one authentication Provider. */
export interface CredentialLifecycleProvider {
  issue?(request: CredentialIssueRequest): Promise<IssuedCredentialSet>
  refresh?(request: CredentialRefreshRequest): Promise<IssuedCredentialSet>
  inspect?(request: CredentialInspectRequest): Promise<readonly AuthenticationCredentialInfo[]>
  revoke?(request: CredentialRevokeRequest): Promise<void>
}

/** Provider for one exact carrier-evidence kind. */
export interface AuthenticationProvider<K extends AuthenticationEvidenceKind = AuthenticationEvidenceKind> {
  readonly method: AuthenticationMethod
  readonly credentials?: CredentialLifecycleProvider
  verify(attempt: AuthenticationAttempt<K>): Promise<VerifiedAuthentication>
}

/** Sanitized authentication event record. */
export interface AuthenticationEventRecord {
  readonly requestId: AuthenticationRequestId
  readonly channel: AuthenticationChannel
  readonly evidenceKind: AuthenticationEvidenceKind
  readonly method?: AuthenticationMethod
  readonly principal?: AuthenticatedPrincipal
  readonly credentialId?: CredentialId
  readonly outcome: 'succeeded' | 'failed'
  readonly reason?: AuthenticationErrorCode
  readonly time: number
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Completed authentication result without raw credential material.
     * @param record - sanitized result safe for audit listeners.
     * @mode emit
     */
    'auth/result'(record: AuthenticationEventRecord): void
  }
}
