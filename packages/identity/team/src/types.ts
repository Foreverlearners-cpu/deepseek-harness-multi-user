/** Host team-directory types shared by Providers and Consumers. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { TenantId } from '@deepseek-ai/dsh-tenant/types'
import type { UserId } from '@deepseek-ai/dsh-user/types'

/** Stable identity of one team. */
export type TeamId = Branded<'TeamId'>

/** Stable identity of one team membership slot. */
export type TeamMembershipId = Branded<'TeamMembershipId'>

/** Closed lifecycle state of one team. */
export type TeamStatus = 'active' | 'disabled' | 'deleted'

/** Closed lifecycle state of one team membership. */
export type TeamMembershipStatus = 'active' | 'disabled' | 'removed'

/** Immutable committed team record. */
export interface TeamRecord {
  readonly teamId: TeamId
  readonly tenantId: TenantId
  readonly displayName?: string
  readonly status: TeamStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly revision: number
}

/** Immutable committed membership of one user in one team. */
export interface TeamMembershipRecord {
  readonly membershipId: TeamMembershipId
  readonly teamId: TeamId
  readonly tenantId: TenantId
  readonly userId: UserId
  readonly status: TeamMembershipStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly revision: number
}

/** Optional trusted metadata describing who initiated a team mutation. */
export interface TeamOperationContext {
  readonly actorUserId?: UserId
  readonly correlationId?: string
  readonly reason?: string
}

/** Values accepted when creating a team under one tenant. */
export interface TeamCreateInput {
  readonly tenantId: TenantId
  readonly displayName?: string
  readonly context?: TeamOperationContext
}

/** Optimistic lifecycle operation for one team. */
export interface TeamStatusRequest {
  readonly teamId: TeamId
  readonly expectedRevision: number
  readonly context?: TeamOperationContext
}

/** Request that adds one user to one team in a claimed tenant. */
export interface TeamMemberAddRequest {
  readonly teamId: TeamId
  readonly tenantId: TenantId
  readonly userId: UserId
  readonly context?: TeamOperationContext
}

/** Optimistic lifecycle operation for one current team membership. */
export interface TeamMembershipStatusRequest {
  readonly teamId: TeamId
  readonly userId: UserId
  readonly expectedRevision: number
  readonly context?: TeamOperationContext
}

/** Bounded membership scan for one team. */
export interface TeamMemberListQuery {
  readonly teamId: TeamId
  readonly status?: TeamMembershipStatus
  readonly limit?: number
  readonly cursor?: string
}

/** Bounded membership scan for one user inside one tenant. */
export interface UserTeamListQuery {
  readonly userId: UserId
  readonly tenantId: TenantId
  readonly status?: TeamMembershipStatus
  readonly limit?: number
  readonly cursor?: string
}

/** One team-membership page with an opaque continuation cursor. */
export interface TeamMembershipPage {
  readonly memberships: readonly TeamMembershipRecord[]
  readonly nextCursor?: string
}

/** Stable team-directory failure category safe for transport mapping. */
export type TeamDirectoryErrorCode =
  | 'invalid-input'
  | 'team-not-found'
  | 'team-disabled'
  | 'team-deleted'
  | 'tenant-mismatch'
  | 'membership-not-found'
  | 'membership-disabled'
  | 'membership-removed'
  | 'membership-conflict'
  | 'status-conflict'
  | 'revision-conflict'
  | 'provider-unavailable'

/** Validated creation values passed from the Service Definition to a Provider. */
export interface TeamCreateRecordInput {
  readonly tenantId: TenantId
  readonly displayName?: string
}

/** Validated membership creation values passed to a Provider. */
export interface TeamMembershipCreateRecordInput {
  readonly teamId: TeamId
  readonly tenantId: TenantId
  readonly userId: UserId
}

/** Atomic team mutation command implemented by a directory Provider. */
export interface TeamMutation {
  readonly kind: 'status'
  readonly teamId: TeamId
  readonly expectedRevision: number
  readonly status: TeamStatus
}

/** Atomic membership mutation command implemented by a directory Provider. */
export interface TeamMembershipMutation {
  readonly kind: 'status'
  readonly teamId: TeamId
  readonly userId: UserId
  readonly expectedRevision: number
  readonly status: TeamMembershipStatus
}

/** Provider result proving the before and after records of one team mutation. */
export interface TeamMutationCommit {
  readonly previous: TeamRecord
  readonly current: TeamRecord
}

/** Provider result proving the before and after records of one membership mutation. */
export interface TeamMembershipMutationCommit {
  readonly previous: TeamMembershipRecord
  readonly current: TeamMembershipRecord
}

/** Resolved membership page request sent to a Provider. */
export type TeamMembershipListQuery =
  | {
    readonly scope: 'team'
    readonly teamId: TeamId
    readonly status?: TeamMembershipStatus
    readonly limit: number
    readonly cursor?: string
  }
  | {
    readonly scope: 'user'
    readonly userId: UserId
    readonly tenantId: TenantId
    readonly status?: TeamMembershipStatus
    readonly limit: number
    readonly cursor?: string
  }

interface TeamEventBase {
  readonly teamId: TeamId
  readonly tenantId: TenantId
  readonly revision: number
  readonly status: TeamStatus
  readonly time: number
  readonly actorUserId?: UserId
  readonly correlationId?: string
  readonly reason?: string
}

/** Sanitized committed team change emitted for audit and cache consumers. */
export type TeamChangeEvent =
  | TeamEventBase & { readonly kind: 'created' }
  | TeamEventBase & {
    readonly kind: 'status-changed'
    readonly previousStatus: Exclude<TeamStatus, 'deleted'>
  }

interface TeamMembershipEventBase {
  readonly membershipId: TeamMembershipId
  readonly teamId: TeamId
  readonly tenantId: TenantId
  readonly userId: UserId
  readonly revision: number
  readonly status: TeamMembershipStatus
  readonly time: number
  readonly actorUserId?: UserId
  readonly correlationId?: string
  readonly reason?: string
}

/** Sanitized committed membership change emitted for audit and cache consumers. */
export type TeamMembershipChangeEvent =
  | TeamMembershipEventBase & { readonly kind: 'created' }
  | TeamMembershipEventBase & {
    readonly kind: 'status-changed'
    readonly previousStatus: Exclude<TeamMembershipStatus, 'removed'>
  }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Committed team-directory change without display names.
     * @param event - sanitized lifecycle fact safe for trusted audit listeners.
     * @mode emit
     */
    'team/changed'(event: TeamChangeEvent): void
    /**
     * Committed membership change without display names, roles, or grants.
     * @param event - sanitized membership fact safe for trusted audit listeners.
     * @mode emit
     */
    'team/membership-changed'(event: TeamMembershipChangeEvent): void
  }
}
