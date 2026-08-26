/** Host tenant-directory types shared by Providers and Consumers. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { UserId } from '@deepseek-ai/dsh-user/types'

/** Stable identity of one tenant. */
export type TenantId = Branded<'TenantId'>

/** Stable identity of one tenant membership slot. */
export type MembershipId = Branded<'MembershipId'>

/** Closed lifecycle state of one tenant. */
export type TenantStatus = 'active' | 'disabled' | 'deleted'

/** Closed lifecycle state of one tenant membership. */
export type MembershipStatus = 'active' | 'disabled' | 'removed'

/** Immutable committed tenant record. */
export interface TenantRecord {
  readonly tenantId: TenantId
  readonly displayName?: string
  readonly status: TenantStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly revision: number
}

/** Immutable committed membership of one user in one tenant. */
export interface MembershipRecord {
  readonly membershipId: MembershipId
  readonly tenantId: TenantId
  readonly userId: UserId
  readonly status: MembershipStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly revision: number
}

/** Optional trusted metadata describing who initiated a tenant mutation. */
export interface TenantOperationContext {
  readonly actorUserId?: UserId
  readonly correlationId?: string
  readonly reason?: string
}

/** Values accepted when creating a tenant. */
export interface TenantCreateInput {
  readonly displayName?: string
  readonly context?: TenantOperationContext
}

/** Optimistic lifecycle operation for one tenant. */
export interface TenantStatusRequest {
  readonly tenantId: TenantId
  readonly expectedRevision: number
  readonly context?: TenantOperationContext
}

/** Request that adds one user to one tenant. */
export interface TenantMemberAddRequest {
  readonly tenantId: TenantId
  readonly userId: UserId
  readonly context?: TenantOperationContext
}

/** Optimistic lifecycle operation for one current membership. */
export interface MembershipStatusRequest {
  readonly tenantId: TenantId
  readonly userId: UserId
  readonly expectedRevision: number
  readonly context?: TenantOperationContext
}

/** Bounded membership scan for one tenant. */
export interface TenantMemberListQuery {
  readonly tenantId: TenantId
  readonly status?: MembershipStatus
  readonly limit?: number
  readonly cursor?: string
}

/** Bounded membership scan for one user. */
export interface UserMembershipListQuery {
  readonly userId: UserId
  readonly status?: MembershipStatus
  readonly limit?: number
  readonly cursor?: string
}

/** One membership page with an opaque continuation cursor. */
export interface MembershipPage {
  readonly memberships: readonly MembershipRecord[]
  readonly nextCursor?: string
}

/** Stable tenant-directory failure category safe for transport mapping. */
export type TenantDirectoryErrorCode =
  | 'invalid-input'
  | 'tenant-not-found'
  | 'tenant-disabled'
  | 'tenant-deleted'
  | 'membership-not-found'
  | 'membership-disabled'
  | 'membership-removed'
  | 'membership-conflict'
  | 'status-conflict'
  | 'revision-conflict'
  | 'provider-unavailable'

/** Validated creation values passed from the Service Definition to a Provider. */
export interface TenantCreateRecordInput {
  readonly displayName?: string
}

/** Validated membership creation values passed to a Provider. */
export interface MembershipCreateRecordInput {
  readonly tenantId: TenantId
  readonly userId: UserId
}

/** Atomic tenant mutation command implemented by a directory Provider. */
export interface TenantMutation {
  readonly kind: 'status'
  readonly tenantId: TenantId
  readonly expectedRevision: number
  readonly status: TenantStatus
}

/** Atomic membership mutation command implemented by a directory Provider. */
export interface MembershipMutation {
  readonly kind: 'status'
  readonly tenantId: TenantId
  readonly userId: UserId
  readonly expectedRevision: number
  readonly status: MembershipStatus
}

/** Provider result proving the before and after records of one tenant mutation. */
export interface TenantMutationCommit {
  readonly previous: TenantRecord
  readonly current: TenantRecord
}

/** Provider result proving the before and after records of one membership mutation. */
export interface MembershipMutationCommit {
  readonly previous: MembershipRecord
  readonly current: MembershipRecord
}

/** Resolved membership page request sent to a Provider. */
export type MembershipListQuery =
  | {
    readonly scope: 'tenant'
    readonly tenantId: TenantId
    readonly status?: MembershipStatus
    readonly limit: number
    readonly cursor?: string
  }
  | {
    readonly scope: 'user'
    readonly userId: UserId
    readonly status?: MembershipStatus
    readonly limit: number
    readonly cursor?: string
  }

interface TenantEventBase {
  readonly tenantId: TenantId
  readonly revision: number
  readonly status: TenantStatus
  readonly time: number
  readonly actorUserId?: UserId
  readonly correlationId?: string
  readonly reason?: string
}

/** Sanitized committed tenant change emitted for audit and cache consumers. */
export type TenantChangeEvent =
  | TenantEventBase & { readonly kind: 'created' }
  | TenantEventBase & {
    readonly kind: 'status-changed'
    readonly previousStatus: Exclude<TenantStatus, 'deleted'>
  }

interface MembershipEventBase {
  readonly membershipId: MembershipId
  readonly tenantId: TenantId
  readonly userId: UserId
  readonly revision: number
  readonly status: MembershipStatus
  readonly time: number
  readonly actorUserId?: UserId
  readonly correlationId?: string
  readonly reason?: string
}

/** Sanitized committed membership change emitted for audit and cache consumers. */
export type TenantMembershipChangeEvent =
  | MembershipEventBase & { readonly kind: 'created' }
  | MembershipEventBase & {
    readonly kind: 'status-changed'
    readonly previousStatus: Exclude<MembershipStatus, 'removed'>
  }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Committed tenant-directory change without display names.
     * @param event - sanitized lifecycle fact safe for trusted audit listeners.
     * @mode emit
     */
    'tenant/changed'(event: TenantChangeEvent): void
    /**
     * Committed membership change without display names or roles.
     * @param event - sanitized membership fact safe for trusted audit listeners.
     * @mode emit
     */
    'tenant/membership-changed'(event: TenantMembershipChangeEvent): void
  }
}
