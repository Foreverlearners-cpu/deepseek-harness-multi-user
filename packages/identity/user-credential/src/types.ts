/** Provider-neutral login identifier and password credential types. */

import type { UserId, UserOperationContext } from '@deepseek-ai/dsh-user/types'

export type { UserId, UserOperationContext } from '@deepseek-ai/dsh-user/types'

/** Extensible login identifier kind such as `username` or `email`. */
export type LoginIdentifierKind = string

/** Raw login identifier accepted for normalization. */
export interface LoginIdentifierInput {
  readonly kind: LoginIdentifierKind
  readonly value: string
}

/** Canonical login identifier returned by the active Provider. */
export interface LoginIdentifier {
  readonly kind: LoginIdentifierKind
  readonly value: string
}

/** Non-secret metadata for one login identifier. */
export interface LoginIdentifierMetadata extends LoginIdentifier {
  readonly createdAt: number
}

/** Detached credential metadata. Password verifier material is never represented. */
export interface UserCredentialRecord {
  readonly userId: UserId
  readonly revision: number
  readonly identifiers: readonly LoginIdentifierMetadata[]
  readonly passwordEnabled: boolean
  readonly updatedAt: number
  readonly passwordChangedAt?: number
}

/** Stable credential failure category safe for transport mapping. */
export type UserCredentialErrorCode =
  | 'invalid-input'
  | 'credential-not-found'
  | 'identifier-conflict'
  | 'identifier-not-found'
  | 'password-not-set'
  | 'invalid-credential'
  | 'revision-conflict'
  | 'provider-unavailable'

interface CredentialMutationBase {
  readonly userId: UserId
  readonly expectedRevision: number
}

/** Atomic credential mutation implemented by a Provider. */
export type UserCredentialMutation =
  | CredentialMutationBase & { readonly kind: 'identifier-add'; readonly identifier: LoginIdentifier }
  | CredentialMutationBase & { readonly kind: 'identifier-remove'; readonly identifier: LoginIdentifier }
  | CredentialMutationBase & { readonly kind: 'password-set'; readonly password: string }
  | CredentialMutationBase & {
    readonly kind: 'password-change'
    readonly currentPassword: string
    readonly newPassword: string
  }
  | CredentialMutationBase & { readonly kind: 'password-disable' }

/** Provider result proving the metadata before and after one atomic mutation. */
export interface UserCredentialMutationCommit {
  readonly previous?: UserCredentialRecord
  readonly current: UserCredentialRecord
}

/** Optimistic login-identifier addition. Revision zero creates the aggregate. */
export interface AddLoginIdentifierRequest extends LoginIdentifierInput {
  readonly userId: UserId
  readonly expectedRevision: number
  readonly context?: UserOperationContext
}

/** Optimistic login-identifier removal. */
export interface RemoveLoginIdentifierRequest extends AddLoginIdentifierRequest {}

/** Password establishment or administrative reset. */
export interface SetPasswordRequest {
  readonly userId: UserId
  readonly expectedRevision: number
  readonly password: string
  readonly context?: UserOperationContext
}

/** Password change requiring the current secret. */
export interface ChangePasswordRequest {
  readonly userId: UserId
  readonly expectedRevision: number
  readonly currentPassword: string
  readonly newPassword: string
  readonly context?: UserOperationContext
}

/** Optimistic password disablement. */
export interface DisablePasswordRequest {
  readonly userId: UserId
  readonly expectedRevision: number
  readonly context?: UserOperationContext
}

/** Password verification input whose result never distinguishes absent state. */
export interface VerifyPasswordRequest {
  readonly userId: UserId
  readonly password: string
}

/** Sanitized committed credential change. */
export interface UserCredentialChangeEvent {
  readonly kind: 'identifier-added' | 'identifier-removed' | 'password-set' | 'password-changed' | 'password-disabled'
  readonly userId: UserId
  readonly revision: number
  readonly time: number
  readonly actorUserId?: UserId
  readonly correlationId?: string
  readonly reason?: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Committed credential metadata change without identifiers or password material.
     * @param event - sanitized fact safe for trusted audit listeners.
     * @mode emit
     */
    'user-credential/changed'(event: UserCredentialChangeEvent): void
  }
}
