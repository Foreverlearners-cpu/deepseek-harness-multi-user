/** Host-only account orchestration types. */

import type {
  AuthenticatedCall,
  AuthenticationChannel,
  AuthenticationRequestId,
  IssuedCredentialSet,
} from '@deepseek-ai/dsh-auth/types'
import type { LoginIdentifierInput, UserCredentialRecord } from '@deepseek-ai/dsh-user-credential/types'
import type { UserExtensions, UserId, UserProfilePatch, UserRecord } from '@deepseek-ai/dsh-user/types'

export type { AuthenticatedCall, AuthenticationChannel, AuthenticationRequestId, IssuedCredentialSet }
export type { LoginIdentifierInput, UserCredentialRecord }
export type { UserExtensions, UserId, UserProfilePatch, UserRecord }

/** Stable account-orchestration failure safe for transport mapping. */
export type AccountErrorCode =
  | 'invalid-input'
  | 'unauthenticated'
  | 'account-inactive'
  | 'conflict'
  | 'registration-incomplete'
  | 'session-revocation-incomplete'
  | 'unavailable'

/** Non-secret state retained when a multi-service operation only partly succeeds. */
export interface AccountRecoveryState {
  readonly userId: UserId
  readonly operation: 'registration' | 'credential-issue' | 'password-change' | 'disable' | 'password-reset'
  readonly userStatus: UserRecord['status']
  readonly credentialsConfigured: boolean
  readonly compensationComplete: boolean
}

/** Correlation and cancellation fields shared by account entry points. */
export interface AccountOperationRequest {
  readonly requestId: AuthenticationRequestId
  readonly signal: AbortSignal
}

/** Profile and secret material needed to establish one account. */
export interface AccountRegistrationInput extends AccountOperationRequest {
  readonly identifier: LoginIdentifierInput
  readonly password: string
  readonly displayName?: string
  readonly extensions?: UserExtensions
}

/** Password-login request extracted by a trusted transport. */
export interface AccountLoginRequest extends AccountOperationRequest {
  readonly channel: AuthenticationChannel
  readonly identifier: LoginIdentifierInput
  readonly password: string
}

/** Refresh request whose secret is consumed only by the JWT Provider. */
export interface AccountRefreshRequest extends AccountOperationRequest {
  readonly refreshToken: string
}

/** Account state and newly issued access/refresh credentials. */
export interface AccountSessionResult {
  readonly user: UserRecord
  readonly credentials: IssuedCredentialSet
}

/** Self-service profile update authorized by the exact current call. */
export interface AccountProfileUpdateRequest {
  readonly call: AuthenticatedCall
  readonly expectedRevision: number
  readonly patch: UserProfilePatch
}

/** Self-service password change authorized by the exact current call. */
export interface AccountPasswordChangeRequest extends AccountOperationRequest {
  readonly call: AuthenticatedCall
  readonly expectedCredentialRevision: number
  readonly currentPassword: string
  readonly newPassword: string
}

/** Administrator-created account; the caller has already authorized `actor`. */
export interface AdminAccountCreateRequest extends AccountRegistrationInput {
  readonly actor: AuthenticatedCall
}

/** Administrator profile mutation; the caller has already authorized `actor`. */
export interface AdminAccountUpdateRequest {
  readonly actor: AuthenticatedCall
  readonly userId: UserId
  readonly expectedRevision: number
  readonly patch: UserProfilePatch
  readonly reason?: string
}

/** Administrator lifecycle mutation; the caller has already authorized `actor`. */
export interface AdminAccountStatusRequest {
  readonly actor: AuthenticatedCall
  readonly userId: UserId
  readonly expectedRevision: number
  readonly requestId: AuthenticationRequestId
  readonly signal: AbortSignal
  readonly reason?: string
}

/** Administrator password reset; the caller has already authorized `actor`. */
export interface AdminPasswordResetRequest extends AccountOperationRequest {
  readonly actor: AuthenticatedCall
  readonly userId: UserId
  readonly expectedCredentialRevision: number
  readonly newPassword: string
  readonly reason?: string
}

/** Administrator session revocation; the caller has already authorized `actor`. */
export interface AdminSessionRevokeRequest extends AccountOperationRequest {
  readonly actor: AuthenticatedCall
  readonly userId: UserId
  readonly reason?: string
}

/** Sanitized account-level fact without identifiers, passwords, or token values. */
export interface AccountChangeEvent {
  readonly kind:
    | 'registered'
    | 'logged-in'
    | 'logged-out'
    | 'profile-updated'
    | 'password-changed'
    | 'admin-created'
    | 'admin-updated'
    | 'admin-disabled'
    | 'admin-enabled'
    | 'admin-password-reset'
    | 'admin-sessions-revoked'
  readonly requestId: AuthenticationRequestId
  readonly userId: UserId
  readonly actorUserId?: UserId
  readonly time: number
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Completed account orchestration fact without credential material.
     * @param event - sanitized account operation safe for audit listeners.
     * @mode emit
     */
    'account/changed'(event: AccountChangeEvent): void
  }
}
