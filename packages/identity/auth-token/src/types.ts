/** Opaque refresh-token family types shared by Providers and Consumers. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  AuthenticatedPrincipal,
  AuthenticationRequestId,
  CredentialId,
  CredentialInspectTarget,
  TokenFamilyId,
} from '@deepseek-ai/dsh-auth/types'

export type {
  AuthenticatedPrincipal,
  AuthenticationRequestId,
  CredentialId,
  CredentialInspectTarget,
  TokenFamilyId,
  UserId,
} from '@deepseek-ai/dsh-auth/types'

/** One-way SHA-256 digest of a high-entropy opaque refresh token. */
export type RefreshTokenDigest = Branded<'RefreshTokenDigest'>

/** Lifecycle state shared by all refresh credentials in one family. */
export type TokenFamilyStatus = 'active' | 'revoked'
/** Lifecycle state of one refresh credential. */
export type RefreshCredentialStatus = 'active' | 'rotated' | 'revoked'

/** Durable token-family state owned by a Provider. */
export interface TokenFamilyRecord {
  readonly tokenFamilyId: TokenFamilyId
  readonly principal: AuthenticatedPrincipal
  readonly status: TokenFamilyStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly expiresAt: number
  readonly revision: number
  readonly revokedAt?: number
  readonly revocationReason?: TokenRevocationReason
}

/** Durable refresh-credential state; it never contains the refresh secret. */
export interface RefreshCredentialRecord {
  readonly credentialId: CredentialId
  readonly tokenFamilyId: TokenFamilyId
  readonly digest: RefreshTokenDigest
  readonly status: RefreshCredentialStatus
  readonly issuedAt: number
  readonly expiresAt: number
  readonly rotatedAt?: number
  readonly replacedBy?: CredentialId
  readonly revokedAt?: number
}

/** Stable reason retained when a token family is revoked. */
export type TokenRevocationReason = 'requested' | 'refresh-token-reuse'

/** Stable token lifecycle failure safe for transport mapping. */
export type AuthTokenErrorCode =
  | 'invalid-input'
  | 'operation-cancelled'
  | 'refresh-token-invalid'
  | 'refresh-token-expired'
  | 'refresh-token-reused'
  | 'token-family-revoked'
  | 'provider-unavailable'

/** Request lifecycle fields shared by all token-family operations. */
export interface AuthTokenOperationRequest {
  readonly requestId: AuthenticationRequestId
  readonly signal: AbortSignal
}

/** Request to begin one refresh-token family after identity proof succeeds. */
export interface TokenFamilyIssueRequest extends AuthTokenOperationRequest {
  readonly principal: AuthenticatedPrincipal
  readonly expiresAt: number
}

/** Request to rotate one refresh token atomically. */
export interface RefreshTokenRotateRequest extends AuthTokenOperationRequest {
  readonly refreshToken: string
  readonly expiresAt: number
}

/** Request to inspect safe token-family state. */
export interface AuthTokenInspectRequest extends AuthTokenOperationRequest {
  readonly target: CredentialInspectTarget
}

/** Request to revoke one refresh credential, family, or principal. */
export interface AuthTokenRevokeRequest extends AuthTokenOperationRequest {
  readonly target: CredentialInspectTarget
}

/** Secret-bearing refresh credential returned only by issue or rotate. */
export interface IssuedRefreshToken {
  readonly credentialId: CredentialId
  readonly tokenFamilyId: TokenFamilyId
  readonly value: string
  readonly expiresAt: number
}

/** Committed family and its short-lived refresh-token output. */
export interface TokenFamilyIssueResult {
  readonly family: TokenFamilyInfo
  readonly refreshToken: IssuedRefreshToken
}

/** Safe token-family metadata returned to Consumers. */
export interface TokenFamilyInfo {
  readonly tokenFamilyId: TokenFamilyId
  readonly principal: AuthenticatedPrincipal
  readonly status: TokenFamilyStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly expiresAt: number
  readonly revision: number
  readonly revokedAt?: number
  readonly revocationReason?: TokenRevocationReason
}

/** Safe refresh-credential metadata without a secret or digest. */
export interface RefreshCredentialInfo {
  readonly credentialId: CredentialId
  readonly tokenFamilyId: TokenFamilyId
  readonly status: RefreshCredentialStatus
  readonly issuedAt: number
  readonly expiresAt: number
  readonly rotatedAt?: number
  readonly replacedBy?: CredentialId
  readonly revokedAt?: number
}

/** Detached token-family inspection result. */
export interface AuthTokenInspection {
  readonly families: readonly TokenFamilyInfo[]
  readonly credentials: readonly RefreshCredentialInfo[]
}

/** Provider input for atomically creating a token family and first credential. */
export interface TokenFamilyCreateInput {
  readonly family: TokenFamilyRecord
  readonly credential: RefreshCredentialRecord
}

/** Provider input for one atomic refresh-token consume-and-replace operation. */
export interface RefreshTokenRotationInput {
  readonly digest: RefreshTokenDigest
  readonly replacementCredentialId: CredentialId
  readonly replacementDigest: RefreshTokenDigest
  readonly time: number
  readonly expiresAt: number
}

/** Successful Provider rotation commit. */
export interface RefreshTokenRotatedCommit {
  readonly kind: 'rotated'
  readonly previousFamily: TokenFamilyRecord
  readonly currentFamily: TokenFamilyRecord
  readonly consumedCredential: RefreshCredentialRecord
  readonly replacementCredential: RefreshCredentialRecord
}

/** Provider commit after detecting reuse and revoking the whole family. */
export interface RefreshTokenReusedCommit {
  readonly kind: 'reused'
  readonly previousFamily: TokenFamilyRecord
  readonly currentFamily: TokenFamilyRecord
  readonly reusedCredential: RefreshCredentialRecord
}

/** Atomic Provider result for a refresh-token rotation attempt. */
export type RefreshTokenRotationCommit = RefreshTokenRotatedCommit | RefreshTokenReusedCommit

/** Provider input for idempotent revocation. */
export interface TokenRevocationInput {
  readonly target: CredentialInspectTarget
  readonly time: number
  readonly reason: 'requested'
}

/** One family changed by a Provider revocation transaction. */
export interface TokenFamilyMutationCommit {
  readonly previous: TokenFamilyRecord
  readonly current: TokenFamilyRecord
}

/** Provider result for credential, family, or principal revocation. */
export interface TokenRevocationCommit {
  readonly families: readonly TokenFamilyMutationCommit[]
}

/** Sanitized committed token-family event. */
export interface AuthTokenChangeEvent {
  readonly kind: 'issued' | 'rotated' | 'revoked' | 'reuse-detected'
  readonly requestId: AuthenticationRequestId
  readonly tokenFamilyId: TokenFamilyId
  readonly principal: AuthenticatedPrincipal
  readonly status: TokenFamilyStatus
  readonly revision: number
  readonly time: number
  readonly credentialId?: CredentialId
  readonly reason?: TokenRevocationReason
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Committed token-family change without refresh secrets or digests.
     * @param event - sanitized lifecycle fact safe for trusted audit listeners.
     * @mode emit
     */
    'auth-token/changed'(event: AuthTokenChangeEvent): void
  }
}
