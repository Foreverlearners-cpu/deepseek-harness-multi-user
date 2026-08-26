/**
 * Provider-independent team directory, membership lifecycle, and change events.
 * @module @deepseek-ai/dsh-team
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId, type UserId } from '@deepseek-ai/dsh-user'
import type {
  TeamChangeEvent,
  TeamCreateInput,
  TeamCreateRecordInput,
  TeamDirectoryErrorCode,
  TeamId,
  TeamMemberAddRequest,
  TeamMemberListQuery,
  TeamMembershipChangeEvent,
  TeamMembershipCreateRecordInput,
  TeamMembershipId,
  TeamMembershipListQuery,
  TeamMembershipMutation,
  TeamMembershipMutationCommit,
  TeamMembershipPage,
  TeamMembershipRecord,
  TeamMembershipStatus,
  TeamMembershipStatusRequest,
  TeamMutation,
  TeamMutationCommit,
  TeamOperationContext,
  TeamRecord,
  TeamStatus,
  TeamStatusRequest,
  UserTeamListQuery,
} from './types.ts'

export type * from './types.ts'

/** Maximum number of UTF-16 code units accepted for a team display name. */
export const MAX_TEAM_DISPLAY_NAME_LENGTH = 200
/** Maximum number of memberships returned by one list operation. */
export const MAX_MEMBERSHIP_LIST_LIMIT = 100

const DEFAULT_MEMBERSHIP_LIST_LIMIT = 50
const MAX_CORRELATION_ID_LENGTH = 128
const MAX_REASON_LENGTH = 500
const MAX_CURSOR_LENGTH = 1024
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/

/** Brand a stable team id after validation.
 * @param value - untrusted team id candidate.
 * @returns validated team id.
 */
export function teamId(value: string): TeamId {
  if (!ID_PATTERN.test(value)) {
    throw new TypeError(`team: team id must match ${String(ID_PATTERN)}`)
  }
  return value as TeamId
}

/** Brand a stable team membership id after validation.
 * @param value - untrusted membership id candidate.
 * @returns validated membership id.
 */
export function teamMembershipId(value: string): TeamMembershipId {
  if (!ID_PATTERN.test(value)) {
    throw new TypeError(`team: membership id must match ${String(ID_PATTERN)}`)
  }
  return value as TeamMembershipId
}

/** Public team-directory failure with a stable transport-safe category. */
export class TeamDirectoryError extends Error {
  /** Stable category safe for transport mapping. */
  readonly code: TeamDirectoryErrorCode

  /** Construct a failure without Provider diagnostics. */
  constructor(code: TeamDirectoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TeamDirectoryError'
    this.code = code
  }
}

function invalid(message: string, options?: ErrorOptions): TeamDirectoryError {
  return new TeamDirectoryError('invalid-input', `team: ${message}`, options)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function displayName(value: unknown): string {
  if (typeof value !== 'string') throw invalid('display name must be a string')
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > MAX_TEAM_DISPLAY_NAME_LENGTH) {
    throw invalid(`display name must contain 1-${String(MAX_TEAM_DISPLAY_NAME_LENGTH)} characters after trimming`)
  }
  return normalized
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalid('revision must be a positive safe integer')
  }
  return value as number
}

function timestamp(label: string, value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TeamDirectoryError('provider-unavailable', `team: Provider returned an invalid ${label}`)
  }
  return value as number
}

function teamStatus(value: unknown): TeamStatus {
  if (value !== 'active' && value !== 'disabled' && value !== 'deleted') {
    throw new TeamDirectoryError('provider-unavailable', 'team: Provider returned an invalid team status')
  }
  return value
}

function membershipStatus(value: unknown): TeamMembershipStatus {
  if (value !== 'active' && value !== 'disabled' && value !== 'removed') {
    throw new TeamDirectoryError('provider-unavailable', 'team: Provider returned an invalid membership status')
  }
  return value
}

function requestedMembershipStatus(value: unknown): TeamMembershipStatus {
  if (value !== 'active' && value !== 'disabled' && value !== 'removed') {
    throw invalid('membership status must be active, disabled, or removed')
  }
  return value
}

function operationContext(value: TeamOperationContext | undefined): Readonly<TeamOperationContext> {
  if (value === undefined) return Object.freeze({})
  const actorUserId = value.actorUserId === undefined ? undefined : userId(value.actorUserId)
  const correlationId = value.correlationId
  const reason = value.reason
  if (correlationId !== undefined
    && (typeof correlationId !== 'string' || correlationId.length === 0 || correlationId.length > MAX_CORRELATION_ID_LENGTH)) {
    throw invalid(`correlation id must contain 1-${String(MAX_CORRELATION_ID_LENGTH)} characters`)
  }
  if (reason !== undefined
    && (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > MAX_REASON_LENGTH)) {
    throw invalid(`reason must contain 1-${String(MAX_REASON_LENGTH)} characters`)
  }
  return Object.freeze({
    ...(actorUserId === undefined ? {} : { actorUserId }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(reason === undefined ? {} : { reason: reason.trim() }),
  })
}

function uncheckedTeamSnapshot(value: unknown): TeamRecord {
  if (!isPlainObject(value) || typeof value.teamId !== 'string' || typeof value.tenantId !== 'string') {
    throw new TeamDirectoryError('provider-unavailable', 'team: Provider returned an invalid team record')
  }
  const id = teamId(value.teamId)
  const owner = tenantId(value.tenantId)
  const currentStatus = teamStatus(value.status)
  const createdAt = timestamp('createdAt', value.createdAt)
  const updatedAt = timestamp('updatedAt', value.updatedAt)
  if (updatedAt < createdAt) {
    throw new TeamDirectoryError('provider-unavailable', 'team: Provider returned updatedAt before createdAt')
  }
  const currentRevision = revision(value.revision)
  const name = value.displayName === undefined ? undefined : displayName(value.displayName)
  if (name !== value.displayName) {
    throw new TeamDirectoryError('provider-unavailable', 'team: Provider returned a non-normalized display name')
  }
  return Object.freeze({
    teamId: id,
    tenantId: owner,
    ...(name === undefined ? {} : { displayName: name }),
    status: currentStatus,
    createdAt,
    updatedAt,
    revision: currentRevision,
  })
}

function teamSnapshot(value: unknown): TeamRecord {
  try {
    return uncheckedTeamSnapshot(value)
  } catch (cause) {
    if (cause instanceof TeamDirectoryError && cause.code === 'provider-unavailable') throw cause
    throw new TeamDirectoryError('provider-unavailable', 'team: Provider returned an invalid team record', { cause })
  }
}

function uncheckedMembershipSnapshot(value: unknown): TeamMembershipRecord {
  if (!isPlainObject(value) || typeof value.membershipId !== 'string'
    || typeof value.teamId !== 'string' || typeof value.tenantId !== 'string'
    || typeof value.userId !== 'string') {
    throw new TeamDirectoryError('provider-unavailable', 'team: Provider returned an invalid membership record')
  }
  const createdAt = timestamp('createdAt', value.createdAt)
  const updatedAt = timestamp('updatedAt', value.updatedAt)
  if (updatedAt < createdAt) {
    throw new TeamDirectoryError('provider-unavailable', 'team: Provider returned updatedAt before createdAt')
  }
  return Object.freeze({
    membershipId: teamMembershipId(value.membershipId),
    teamId: teamId(value.teamId),
    tenantId: tenantId(value.tenantId),
    userId: userId(value.userId),
    status: membershipStatus(value.status),
    createdAt,
    updatedAt,
    revision: revision(value.revision),
  })
}

function membershipSnapshot(value: unknown): TeamMembershipRecord {
  try {
    return uncheckedMembershipSnapshot(value)
  } catch (cause) {
    if (cause instanceof TeamDirectoryError && cause.code === 'provider-unavailable') throw cause
    throw new TeamDirectoryError('provider-unavailable', 'team: Provider returned an invalid membership record', { cause })
  }
}

function teamMutationCommit(value: unknown, mutation: TeamMutation): Readonly<TeamMutationCommit> {
  if (!isPlainObject(value)) {
    throw new TeamDirectoryError('provider-unavailable', 'team: Provider returned an invalid mutation commit')
  }
  const previous = teamSnapshot(value.previous)
  const current = teamSnapshot(value.current)
  const expectedPrevious = mutation.status === 'active' ? 'disabled' : mutation.status === 'disabled' ? 'active' : undefined
  if (previous.teamId !== mutation.teamId || current.teamId !== mutation.teamId
    || previous.tenantId !== current.tenantId
    || previous.revision !== mutation.expectedRevision
    || current.revision !== previous.revision + 1
    || current.createdAt !== previous.createdAt
    || current.updatedAt < previous.updatedAt
    || (expectedPrevious !== undefined && previous.status !== expectedPrevious)
    || (mutation.status === 'deleted' && previous.status === 'deleted')
    || current.status !== mutation.status
    || current.displayName !== previous.displayName) {
    throw new TeamDirectoryError('provider-unavailable', 'team: Provider committed an invalid status transition')
  }
  return Object.freeze({ previous, current })
}

function membershipMutationCommit(
  value: unknown,
  mutation: TeamMembershipMutation,
): Readonly<TeamMembershipMutationCommit> {
  if (!isPlainObject(value)) {
    throw new TeamDirectoryError('provider-unavailable', 'team: Provider returned an invalid mutation commit')
  }
  const previous = membershipSnapshot(value.previous)
  const current = membershipSnapshot(value.current)
  const expectedPrevious = mutation.status === 'active' ? 'disabled' : mutation.status === 'disabled' ? 'active' : undefined
  if (previous.teamId !== mutation.teamId || current.teamId !== mutation.teamId
    || previous.userId !== mutation.userId || current.userId !== mutation.userId
    || previous.tenantId !== current.tenantId
    || previous.membershipId !== current.membershipId
    || previous.revision !== mutation.expectedRevision
    || current.revision !== previous.revision + 1
    || current.createdAt !== previous.createdAt
    || current.updatedAt < previous.updatedAt
    || (expectedPrevious !== undefined && previous.status !== expectedPrevious)
    || (mutation.status === 'removed' && previous.status === 'removed')
    || current.status !== mutation.status) {
    throw new TeamDirectoryError('provider-unavailable', 'team: Provider committed an invalid membership transition')
  }
  return Object.freeze({ previous, current })
}

function listBounds(query: {
  readonly limit?: number
  readonly cursor?: string
  readonly status?: TeamMembershipStatus
}): {
  readonly limit: number
  readonly cursor?: string
  readonly status?: TeamMembershipStatus
} {
  const limit = query.limit ?? DEFAULT_MEMBERSHIP_LIST_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MEMBERSHIP_LIST_LIMIT) {
    throw invalid(`list limit must be an integer from 1 to ${String(MAX_MEMBERSHIP_LIST_LIMIT)}`)
  }
  if (query.cursor !== undefined
    && (typeof query.cursor !== 'string' || query.cursor.length === 0 || query.cursor.length > MAX_CURSOR_LENGTH)) {
    throw invalid(`list cursor must contain 1-${String(MAX_CURSOR_LENGTH)} characters`)
  }
  return Object.freeze({
    limit,
    ...(query.status === undefined ? {} : { status: requestedMembershipStatus(query.status) }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
  })
}

function membershipPage(value: unknown, query: TeamMembershipListQuery): TeamMembershipPage {
  if (!isPlainObject(value) || !Array.isArray(value.memberships) || value.memberships.length > query.limit
    || (value.nextCursor !== undefined
      && (typeof value.nextCursor !== 'string' || value.nextCursor.length === 0 || value.nextCursor.length > MAX_CURSOR_LENGTH))) {
    throw new TeamDirectoryError('provider-unavailable', 'team: Provider returned an invalid membership page')
  }
  const seen = new Set<TeamMembershipId>()
  const memberships = value.memberships.map((entry) => {
    const current = membershipSnapshot(entry)
    if (seen.has(current.membershipId)
      || (query.scope === 'team' && current.teamId !== query.teamId)
      || (query.scope === 'user' && (current.userId !== query.userId || current.tenantId !== query.tenantId))
      || (query.status !== undefined && current.status !== query.status)) {
      throw new TeamDirectoryError('provider-unavailable', 'team: Provider returned an inconsistent membership page')
    }
    seen.add(current.membershipId)
    return current
  })
  return Object.freeze({
    memberships: Object.freeze(memberships),
    ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
  })
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Active team and membership directory Provider. */
    teams: TeamDirectory
  }
}

/**
 * Abstract team directory. Providers own durable records and atomic revision
 * checks; this base owns validation, stable failures, detached results, and
 * post-commit events.
 */
export abstract class TeamDirectory extends Service {
  /** @param ctx - owning Host context. */
  constructor(ctx: Context) {
    super(ctx, 'teams')
  }

  /** Persist one new active team with revision 1 and a Provider-generated id.
   * @param input - validated and detached team values.
   * @returns committed Provider record.
   */
  protected abstract createTeamRecord(input: TeamCreateRecordInput): Promise<TeamRecord>

  /** Read one team record without changing it.
   * @param id - stable team identity.
   * @returns current record, or undefined when absent.
   */
  protected abstract readTeamRecord(id: TeamId): Promise<TeamRecord | undefined>

  /** Atomically compare revision, commit one team mutation, and return both records.
   * @param mutation - validated lifecycle mutation.
   * @returns atomic before-and-after commit records.
   */
  protected abstract mutateTeamRecord(mutation: TeamMutation): Promise<TeamMutationCommit>

  /** Persist one new active membership with revision 1 and a Provider-generated id.
   * @param input - validated team, tenant, and user identities.
   * @returns committed Provider record.
   */
  protected abstract createMembershipRecord(input: TeamMembershipCreateRecordInput): Promise<TeamMembershipRecord>

  /** Read the current membership slot for one team and user.
   * @param id - stable team identity.
   * @param member - stable user identity.
   * @returns current record, or undefined when the pair was never added.
   */
  protected abstract readMembershipRecord(id: TeamId, member: UserId): Promise<TeamMembershipRecord | undefined>

  /** Atomically compare revision, commit one membership mutation, and return both records.
   * @param mutation - validated lifecycle mutation.
   * @returns atomic before-and-after commit records.
   */
  protected abstract mutateMembershipRecord(mutation: TeamMembershipMutation): Promise<TeamMembershipMutationCommit>

  /** Read one bounded membership page using an opaque cursor.
   * @param query - resolved scope, limit, and cursor values.
   * @returns one current page.
   */
  protected abstract listMembershipRecords(query: TeamMembershipListQuery): Promise<TeamMembershipPage>

  /** Create one active team under one tenant with a Provider-generated stable id.
   * @param input - owning tenant, optional display name, and trusted operation metadata.
   * @returns immutable committed team record.
   */
  async create(input: TeamCreateInput): Promise<TeamRecord> {
    const context = operationContext(input.context)
    const owner = tenantId(input.tenantId)
    const normalized: TeamCreateRecordInput = Object.freeze({
      tenantId: owner,
      ...(input.displayName === undefined ? {} : { displayName: displayName(input.displayName) }),
    })
    const current = teamSnapshot(await this.provider(() => this.createTeamRecord(normalized)))
    if (current.status !== 'active' || current.revision !== 1
      || current.tenantId !== owner || current.displayName !== normalized.displayName) {
      throw new TeamDirectoryError('provider-unavailable', 'team: Provider created an invalid initial team record')
    }
    this.emitChange('team/changed', this.teamEvent('created', current, context))
    return current
  }

  /** Get one current team record.
   * @param id - stable team identity.
   * @returns immutable record, or undefined when absent.
   */
  async get(id: TeamId): Promise<TeamRecord | undefined> {
    teamId(id)
    const value = await this.provider(() => this.readTeamRecord(id))
    return value === undefined ? undefined : teamSnapshot(value)
  }

  /** Require that one team exists and is currently active.
   * @param id - stable team identity.
   * @returns immutable active team record.
   */
  async requireActive(id: TeamId): Promise<TeamRecord> {
    const current = await this.get(id)
    if (current === undefined) throw new TeamDirectoryError('team-not-found', 'team: team was not found')
    if (current.status === 'disabled') throw new TeamDirectoryError('team-disabled', 'team: team is disabled')
    if (current.status === 'deleted') throw new TeamDirectoryError('team-deleted', 'team: team is deleted')
    return current
  }

  /** Disable one active team using optimistic concurrency.
   * @param request - target id, expected revision, and operation metadata.
   * @returns immutable disabled team record.
   */
  disable(request: TeamStatusRequest): Promise<TeamRecord> {
    return this.transitionTeam(request, 'disabled')
  }

  /** Enable one disabled team using optimistic concurrency.
   * @param request - target id, expected revision, and operation metadata.
   * @returns immutable active team record.
   */
  enable(request: TeamStatusRequest): Promise<TeamRecord> {
    return this.transitionTeam(request, 'active')
  }

  /** Soft-delete one active or disabled team using optimistic concurrency.
   * @param request - target id, expected revision, and operation metadata.
   * @returns immutable terminal team record.
   */
  delete(request: TeamStatusRequest): Promise<TeamRecord> {
    return this.transitionTeam(request, 'deleted')
  }

  /** Add one user to one active team. The claimed tenant must match the team's tenant.
   * A removed pair may be re-added under a new membership id.
   * @param request - team, claimed tenant, user, and trusted operation metadata.
   * @returns immutable committed membership record.
   */
  async addMember(request: TeamMemberAddRequest): Promise<TeamMembershipRecord> {
    const context = operationContext(request.context)
    const id = teamId(request.teamId)
    const claimedTenant = tenantId(request.tenantId)
    const member = userId(request.userId)
    const team = await this.requireActive(id)
    if (team.tenantId !== claimedTenant) {
      throw new TeamDirectoryError('tenant-mismatch', 'team: claimed tenant does not own the team')
    }
    const current = membershipSnapshot(await this.provider(() => this.createMembershipRecord(Object.freeze({
      teamId: id,
      tenantId: team.tenantId,
      userId: member,
    }))))
    if (current.status !== 'active' || current.revision !== 1
      || current.teamId !== id || current.tenantId !== team.tenantId || current.userId !== member) {
      throw new TeamDirectoryError('provider-unavailable', 'team: Provider created an invalid initial membership record')
    }
    this.emitChange('team/membership-changed', this.membershipEvent('created', current, context))
    return current
  }

  /** Get the current membership slot for one team and user.
   * @param id - stable team identity.
   * @param member - stable user identity.
   * @returns immutable record, or undefined when the pair was never added.
   */
  async getMembership(id: TeamId, member: UserId): Promise<TeamMembershipRecord | undefined> {
    teamId(id)
    userId(member)
    const value = await this.provider(() => this.readMembershipRecord(id, member))
    return value === undefined ? undefined : membershipSnapshot(value)
  }

  /** Require that one team and one membership are both currently active.
   * @param id - stable team identity.
   * @param member - stable user identity.
   * @returns immutable active membership record.
   */
  async requireActiveMembership(id: TeamId, member: UserId): Promise<TeamMembershipRecord> {
    await this.requireActive(id)
    const current = await this.getMembership(id, member)
    if (current === undefined) {
      throw new TeamDirectoryError('membership-not-found', 'team: membership was not found')
    }
    if (current.status === 'disabled') {
      throw new TeamDirectoryError('membership-disabled', 'team: membership is disabled')
    }
    if (current.status === 'removed') {
      throw new TeamDirectoryError('membership-removed', 'team: membership is removed')
    }
    return current
  }

  /** Disable one active membership using optimistic concurrency.
   * @param request - team, user, expected revision, and operation metadata.
   * @returns immutable disabled membership record.
   */
  disableMembership(request: TeamMembershipStatusRequest): Promise<TeamMembershipRecord> {
    return this.transitionMembership(request, 'disabled')
  }

  /** Enable one disabled membership using optimistic concurrency.
   * @param request - team, user, expected revision, and operation metadata.
   * @returns immutable active membership record.
   */
  enableMembership(request: TeamMembershipStatusRequest): Promise<TeamMembershipRecord> {
    return this.transitionMembership(request, 'active')
  }

  /** Revoke one active or disabled membership using optimistic concurrency.
   * @param request - team, user, expected revision, and operation metadata.
   * @returns immutable terminal membership record.
   */
  removeMembership(request: TeamMembershipStatusRequest): Promise<TeamMembershipRecord> {
    return this.transitionMembership(request, 'removed')
  }

  /** List one bounded page of memberships for one team.
   * @param query - team, optional status, limit, and opaque cursor.
   * @returns immutable page and optional continuation cursor.
   */
  async listMembers(query: TeamMemberListQuery): Promise<TeamMembershipPage> {
    const id = teamId(query.teamId)
    if (await this.get(id) === undefined) {
      throw new TeamDirectoryError('team-not-found', 'team: team was not found')
    }
    const bounds = listBounds(query)
    const resolved: TeamMembershipListQuery = Object.freeze({
      scope: 'team',
      teamId: id,
      ...bounds,
    })
    return membershipPage(await this.provider(() => this.listMembershipRecords(resolved)), resolved)
  }

  /** List one bounded page of one user's team memberships inside one tenant.
   * @param query - user, tenant, optional status, limit, and opaque cursor.
   * @returns immutable page and optional continuation cursor.
   */
  async listUserTeams(query: UserTeamListQuery): Promise<TeamMembershipPage> {
    const member = userId(query.userId)
    const owner = tenantId(query.tenantId)
    const bounds = listBounds(query)
    const resolved: TeamMembershipListQuery = Object.freeze({
      scope: 'user',
      userId: member,
      tenantId: owner,
      ...bounds,
    })
    return membershipPage(await this.provider(() => this.listMembershipRecords(resolved)), resolved)
  }

  private async transitionTeam(request: TeamStatusRequest, nextStatus: TeamStatus): Promise<TeamRecord> {
    const context = operationContext(request.context)
    const mutation: TeamMutation = Object.freeze({
      kind: 'status',
      teamId: teamId(request.teamId),
      expectedRevision: revision(request.expectedRevision),
      status: nextStatus,
    })
    const commit = teamMutationCommit(await this.provider(() => this.mutateTeamRecord(mutation)), mutation)
    this.emitChange('team/changed', Object.freeze({
      kind: 'status-changed',
      teamId: commit.current.teamId,
      tenantId: commit.current.tenantId,
      revision: commit.current.revision,
      status: commit.current.status,
      time: commit.current.updatedAt,
      ...context,
      previousStatus: commit.previous.status as Exclude<TeamStatus, 'deleted'>,
    }))
    return commit.current
  }

  private async transitionMembership(
    request: TeamMembershipStatusRequest,
    nextStatus: TeamMembershipStatus,
  ): Promise<TeamMembershipRecord> {
    const context = operationContext(request.context)
    const mutation: TeamMembershipMutation = Object.freeze({
      kind: 'status',
      teamId: teamId(request.teamId),
      userId: userId(request.userId),
      expectedRevision: revision(request.expectedRevision),
      status: nextStatus,
    })
    const commit = membershipMutationCommit(
      await this.provider(() => this.mutateMembershipRecord(mutation)),
      mutation,
    )
    this.emitChange('team/membership-changed', Object.freeze({
      kind: 'status-changed',
      membershipId: commit.current.membershipId,
      teamId: commit.current.teamId,
      tenantId: commit.current.tenantId,
      userId: commit.current.userId,
      revision: commit.current.revision,
      status: commit.current.status,
      time: commit.current.updatedAt,
      ...context,
      previousStatus: commit.previous.status as Exclude<TeamMembershipStatus, 'removed'>,
    }))
    return commit.current
  }

  private async provider<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (cause) {
      if (cause instanceof TeamDirectoryError) throw cause
      throw new TeamDirectoryError('provider-unavailable', 'team: directory Provider failed', { cause })
    }
  }

  private teamEvent(
    kind: 'created',
    current: TeamRecord,
    context: Readonly<TeamOperationContext>,
  ): TeamChangeEvent {
    return Object.freeze({
      kind,
      teamId: current.teamId,
      tenantId: current.tenantId,
      revision: current.revision,
      status: current.status,
      time: current.updatedAt,
      ...context,
    })
  }

  private membershipEvent(
    kind: 'created',
    current: TeamMembershipRecord,
    context: Readonly<TeamOperationContext>,
  ): TeamMembershipChangeEvent {
    return Object.freeze({
      kind,
      membershipId: current.membershipId,
      teamId: current.teamId,
      tenantId: current.tenantId,
      userId: current.userId,
      revision: current.revision,
      status: current.status,
      time: current.updatedAt,
      ...context,
    })
  }

  private emitChange(
    name: 'team/changed' | 'team/membership-changed',
    event: TeamChangeEvent | TeamMembershipChangeEvent,
  ): void {
    const report = (error: unknown): void => {
      this.ctx.logger.warn(`team: a ${name} listener failed`)
      this.ctx.logger.warn(error)
    }
    let invariantFailure: unknown
    for (const listener of this.ctx.events.dispatch('emit', [name, event])) {
      try {
        const returned: unknown = listener(event)
        if (isPromiseLike(returned)) void Promise.resolve(returned).catch(report)
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') invariantFailure ??= error
        else report(error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }
}

export default TeamDirectory
