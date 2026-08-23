/** Host user-directory types shared by Providers and Consumers. */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable identity of one human user account. */
export type UserId = Branded<'UserId'>

/** JSON value accepted in non-authoritative user extensions. */
export type UserExtensionValue =
  | null
  | boolean
  | number
  | string
  | readonly UserExtensionValue[]
  | { readonly [key: string]: UserExtensionValue }

/** Namespaced, non-sensitive supplementary user data. */
export type UserExtensions = Readonly<Record<string, UserExtensionValue>>

/** Closed lifecycle state of one human user account. */
export type UserStatus = 'active' | 'disabled' | 'deleted'

/** Immutable committed user-directory record. */
export interface UserRecord {
  readonly userId: UserId
  readonly displayName?: string
  readonly status: UserStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly revision: number
  readonly extensions: UserExtensions
}

/** Optional trusted metadata describing who initiated a user mutation. */
export interface UserOperationContext {
  readonly actorUserId?: UserId
  readonly correlationId?: string
  readonly reason?: string
}

/** Profile values accepted when creating a user. */
export interface UserCreateInput {
  readonly displayName?: string
  readonly extensions?: UserExtensions
  readonly context?: UserOperationContext
}

/** Mutable profile fields; `null` explicitly clears the display name. */
export interface UserProfilePatch {
  readonly displayName?: string | null
  readonly extensions?: UserExtensions
}

/** Optimistic profile update for one user. */
export interface UserUpdateRequest {
  readonly userId: UserId
  readonly expectedRevision: number
  readonly patch: UserProfilePatch
  readonly context?: UserOperationContext
}

/** Optimistic lifecycle operation for one user. */
export interface UserStatusRequest {
  readonly userId: UserId
  readonly expectedRevision: number
  readonly context?: UserOperationContext
}

/** Bounded directory scan request. */
export interface UserListQuery {
  readonly status?: UserStatus
  readonly limit?: number
  readonly cursor?: string
}

/** One directory page with an opaque continuation cursor. */
export interface UserPage {
  readonly users: readonly UserRecord[]
  readonly nextCursor?: string
}

/** Stable user-directory failure category safe for transport mapping. */
export type UserDirectoryErrorCode =
  | 'invalid-input'
  | 'user-not-found'
  | 'user-disabled'
  | 'user-deleted'
  | 'status-conflict'
  | 'revision-conflict'
  | 'provider-unavailable'

/** Validated creation values passed from the Service Definition to a Provider. */
export interface UserCreateRecordInput {
  readonly displayName?: string
  readonly extensions: UserExtensions
}

/** Atomic mutation command implemented by a directory Provider. */
export type UserMutation =
  | {
    readonly kind: 'profile'
    readonly userId: UserId
    readonly expectedRevision: number
    readonly patch: UserProfilePatch
  }
  | {
    readonly kind: 'status'
    readonly userId: UserId
    readonly expectedRevision: number
    readonly status: UserStatus
  }

/** Provider result proving the before and after records of one atomic mutation. */
export interface UserMutationCommit {
  readonly previous: UserRecord
  readonly current: UserRecord
}

interface UserEventBase {
  readonly userId: UserId
  readonly revision: number
  readonly status: UserStatus
  readonly time: number
  readonly actorUserId?: UserId
  readonly correlationId?: string
  readonly reason?: string
}

/** Sanitized committed user change emitted for audit and cache consumers. */
export type UserChangeEvent =
  | UserEventBase & { readonly kind: 'created' }
  | UserEventBase & { readonly kind: 'profile-updated' }
  | UserEventBase & {
    readonly kind: 'status-changed'
    readonly previousStatus: Exclude<UserStatus, 'deleted'>
  }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Committed user-directory change without profile or credential data.
     * @param event - sanitized lifecycle fact safe for trusted audit listeners.
     * @mode emit
     */
    'user/changed'(event: UserChangeEvent): void
  }
}
