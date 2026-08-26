/**
 * Provider-independent tenant directory, membership lifecycle, and change events.
 * @module @deepseek-ai/dsh-tenant
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { userId, type UserId } from '@deepseek-ai/dsh-user'
import type {
  MembershipCreateRecordInput,
  MembershipId,
  MembershipListQuery,
  MembershipMutation,
  MembershipMutationCommit,
  MembershipPage,
  MembershipRecord,
  MembershipStatus,
  MembershipStatusRequest,
  TenantChangeEvent,
  TenantCreateInput,
  TenantCreateRecordInput,
  TenantDirectoryErrorCode,
  TenantId,
  TenantMemberAddRequest,
  TenantMemberListQuery,
  TenantMembershipChangeEvent,
  TenantMutation,
  TenantMutationCommit,
  TenantOperationContext,
  TenantRecord,
  TenantStatus,
  TenantStatusRequest,
  UserMembershipListQuery,
} from './types.ts'

export type * from './types.ts'

/** Maximum number of UTF-16 code units accepted for a tenant display name. */
export const MAX_TENANT_DISPLAY_NAME_LENGTH = 200
/** Maximum number of memberships returned by one list operation. */
export const MAX_MEMBERSHIP_LIST_LIMIT = 100

const DEFAULT_MEMBERSHIP_LIST_LIMIT = 50
const MAX_CORRELATION_ID_LENGTH = 128
const MAX_REASON_LENGTH = 500
const MAX_CURSOR_LENGTH = 1024
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/

/** Brand a stable tenant id after validation.
 * @param value - untrusted tenant id candidate.
 * @returns validated tenant id.
 */
export function tenantId(value: string): TenantId {
  if (!ID_PATTERN.test(value)) {
    throw new TypeError(`tenant: tenant id must match ${String(ID_PATTERN)}`)
  }
  return value as TenantId
}

/** Brand a stable membership id after validation.
 * @param value - untrusted membership id candidate.
 * @returns validated membership id.
 */
export function membershipId(value: string): MembershipId {
  if (!ID_PATTERN.test(value)) {
    throw new TypeError(`tenant: membership id must match ${String(ID_PATTERN)}`)
  }
  return value as MembershipId
}

/** Public tenant-directory failure with a stable transport-safe category. */
export class TenantDirectoryError extends Error {
  /** Stable category safe for transport mapping. */
  readonly code: TenantDirectoryErrorCode

  /** Construct a failure without Provider diagnostics. */
  constructor(code: TenantDirectoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TenantDirectoryError'
    this.code = code
  }
}

function invalid(message: string, options?: ErrorOptions): TenantDirectoryError {
  return new TenantDirectoryError('invalid-input', `tenant: ${message}`, options)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function displayName(value: unknown): string {
  if (typeof value !== 'string') throw invalid('display name must be a string')
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > MAX_TENANT_DISPLAY_NAME_LENGTH) {
    throw invalid(`display name must contain 1-${String(MAX_TENANT_DISPLAY_NAME_LENGTH)} characters after trimming`)
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
    throw new TenantDirectoryError('provider-unavailable', `tenant: Provider returned an invalid ${label}`)
  }
  return value as number
}

function tenantStatus(value: unknown): TenantStatus {
  if (value !== 'active' && value !== 'disabled' && value !== 'deleted') {
    throw new TenantDirectoryError('provider-unavailable', 'tenant: Provider returned an invalid tenant status')
  }
  return value
}

function membershipStatus(value: unknown): MembershipStatus {
  if (value !== 'active' && value !== 'disabled' && value !== 'removed') {
    throw new TenantDirectoryError('provider-unavailable', 'tenant: Provider returned an invalid membership status')
  }
  return value
}

function requestedMembershipStatus(value: unknown): MembershipStatus {
  if (value !== 'active' && value !== 'disabled' && value !== 'removed') {
    throw invalid('membership status must be active, disabled, or removed')
  }
  return value
}

function operationContext(value: TenantOperationContext | undefined): Readonly<TenantOperationContext> {
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

function uncheckedTenantSnapshot(value: unknown): TenantRecord {
  if (!isPlainObject(value) || typeof value.tenantId !== 'string') {
    throw new TenantDirectoryError('provider-unavailable', 'tenant: Provider returned an invalid tenant record')
  }
  const id = tenantId(value.tenantId)
  const currentStatus = tenantStatus(value.status)
  const createdAt = timestamp('createdAt', value.createdAt)
  const updatedAt = timestamp('updatedAt', value.updatedAt)
  if (updatedAt < createdAt) {
    throw new TenantDirectoryError('provider-unavailable', 'tenant: Provider returned updatedAt before createdAt')
  }
  const currentRevision = revision(value.revision)
  const name = value.displayName === undefined ? undefined : displayName(value.displayName)
  if (name !== value.displayName) {
    throw new TenantDirectoryError('provider-unavailable', 'tenant: Provider returned a non-normalized display name')
  }
  return Object.freeze({
    tenantId: id,
    ...(name === undefined ? {} : { displayName: name }),
    status: currentStatus,
    createdAt,
    updatedAt,
    revision: currentRevision,
  })
}

function tenantSnapshot(value: unknown): TenantRecord {
  try {
    return uncheckedTenantSnapshot(value)
  } catch (cause) {
    if (cause instanceof TenantDirectoryError && cause.code === 'provider-unavailable') throw cause
    throw new TenantDirectoryError('provider-unavailable', 'tenant: Provider returned an invalid tenant record', { cause })
  }
}

function uncheckedMembershipSnapshot(value: unknown): MembershipRecord {
  if (!isPlainObject(value) || typeof value.membershipId !== 'string'
    || typeof value.tenantId !== 'string' || typeof value.userId !== 'string') {
    throw new TenantDirectoryError('provider-unavailable', 'tenant: Provider returned an invalid membership record')
  }
  const createdAt = timestamp('createdAt', value.createdAt)
  const updatedAt = timestamp('updatedAt', value.updatedAt)
  if (updatedAt < createdAt) {
    throw new TenantDirectoryError('provider-unavailable', 'tenant: Provider returned updatedAt before createdAt')
  }
  return Object.freeze({
    membershipId: membershipId(value.membershipId),
    tenantId: tenantId(value.tenantId),
    userId: userId(value.userId),
    status: membershipStatus(value.status),
    createdAt,
    updatedAt,
    revision: revision(value.revision),
  })
}

function membershipSnapshot(value: unknown): MembershipRecord {
  try {
    return uncheckedMembershipSnapshot(value)
  } catch (cause) {
    if (cause instanceof TenantDirectoryError && cause.code === 'provider-unavailable') throw cause
    throw new TenantDirectoryError('provider-unavailable', 'tenant: Provider returned an invalid membership record', { cause })
  }
}

function tenantMutationCommit(value: unknown, mutation: TenantMutation): Readonly<TenantMutationCommit> {
  if (!isPlainObject(value)) {
    throw new TenantDirectoryError('provider-unavailable', 'tenant: Provider returned an invalid mutation commit')
  }
  const previous = tenantSnapshot(value.previous)
  const current = tenantSnapshot(value.current)
  const expectedPrevious = mutation.status === 'active' ? 'disabled' : mutation.status === 'disabled' ? 'active' : undefined
  if (previous.tenantId !== mutation.tenantId || current.tenantId !== mutation.tenantId
    || previous.revision !== mutation.expectedRevision
    || current.revision !== previous.revision + 1
    || current.createdAt !== previous.createdAt
    || current.updatedAt < previous.updatedAt
    || (expectedPrevious !== undefined && previous.status !== expectedPrevious)
    || (mutation.status === 'deleted' && previous.status === 'deleted')
    || current.status !== mutation.status
    || current.displayName !== previous.displayName) {
    throw new TenantDirectoryError('provider-unavailable', 'tenant: Provider committed an invalid status transition')
  }
  return Object.freeze({ previous, current })
}

function membershipMutationCommit(value: unknown, mutation: MembershipMutation): Readonly<MembershipMutationCommit> {
  if (!isPlainObject(value)) {
    throw new TenantDirectoryError('provider-unavailable', 'tenant: Provider returned an invalid mutation commit')
  }
  const previous = membershipSnapshot(value.previous)
  const current = membershipSnapshot(value.current)
  const expectedPrevious = mutation.status === 'active' ? 'disabled' : mutation.status === 'disabled' ? 'active' : undefined
  if (previous.tenantId !== mutation.tenantId || current.tenantId !== mutation.tenantId
    || previous.userId !== mutation.userId || current.userId !== mutation.userId
    || previous.membershipId !== current.membershipId
    || previous.revision !== mutation.expectedRevision
    || current.revision !== previous.revision + 1
    || current.createdAt !== previous.createdAt
    || current.updatedAt < previous.updatedAt
    || (expectedPrevious !== undefined && previous.status !== expectedPrevious)
    || (mutation.status === 'removed' && previous.status === 'removed')
    || current.status !== mutation.status) {
    throw new TenantDirectoryError('provider-unavailable', 'tenant: Provider committed an invalid membership transition')
  }
  return Object.freeze({ previous, current })
}

function listBounds(query: { readonly limit?: number; readonly cursor?: string; readonly status?: MembershipStatus }): {
  readonly limit: number
  readonly cursor?: string
  readonly status?: MembershipStatus
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

function membershipPage(value: unknown, query: MembershipListQuery): MembershipPage {
  if (!isPlainObject(value) || !Array.isArray(value.memberships) || value.memberships.length > query.limit
    || (value.nextCursor !== undefined
      && (typeof value.nextCursor !== 'string' || value.nextCursor.length === 0 || value.nextCursor.length > MAX_CURSOR_LENGTH))) {
    throw new TenantDirectoryError('provider-unavailable', 'tenant: Provider returned an invalid membership page')
  }
  const seen = new Set<MembershipId>()
  const memberships = value.memberships.map((entry) => {
    const current = membershipSnapshot(entry)
    if (seen.has(current.membershipId)
      || (query.scope === 'tenant' && current.tenantId !== query.tenantId)
      || (query.scope === 'user' && current.userId !== query.userId)
      || (query.status !== undefined && current.status !== query.status)) {
      throw new TenantDirectoryError('provider-unavailable', 'tenant: Provider returned an inconsistent membership page')
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
    /** Active tenant and membership directory Provider. */
    tenants: TenantDirectory
  }
}

/**
 * Abstract tenant directory. Providers own durable records and atomic revision
 * checks; this base owns validation, stable failures, detached results, and
 * post-commit events.
 */
export abstract class TenantDirectory extends Service {
  /** @param ctx - owning Host context. */
  constructor(ctx: Context) {
    super(ctx, 'tenants')
  }

  /** Persist one new active tenant with revision 1 and a Provider-generated id.
   * @param input - validated and detached tenant values.
   * @returns committed Provider record.
   */
  protected abstract createTenantRecord(input: TenantCreateRecordInput): Promise<TenantRecord>

  /** Read one tenant record without changing it.
   * @param id - stable tenant identity.
   * @returns current record, or undefined when absent.
   */
  protected abstract readTenantRecord(id: TenantId): Promise<TenantRecord | undefined>

  /** Atomically compare revision, commit one tenant mutation, and return both records.
   * @param mutation - validated lifecycle mutation.
   * @returns atomic before-and-after commit records.
   */
  protected abstract mutateTenantRecord(mutation: TenantMutation): Promise<TenantMutationCommit>

  /** Persist one new active membership with revision 1 and a Provider-generated id.
   * @param input - validated tenant and user identities.
   * @returns committed Provider record.
   */
  protected abstract createMembershipRecord(input: MembershipCreateRecordInput): Promise<MembershipRecord>

  /** Read the current membership slot for one tenant and user.
   * @param id - stable tenant identity.
   * @param member - stable user identity.
   * @returns current record, or undefined when the pair was never added.
   */
  protected abstract readMembershipRecord(id: TenantId, member: UserId): Promise<MembershipRecord | undefined>

  /** Atomically compare revision, commit one membership mutation, and return both records.
   * @param mutation - validated lifecycle mutation.
   * @returns atomic before-and-after commit records.
   */
  protected abstract mutateMembershipRecord(mutation: MembershipMutation): Promise<MembershipMutationCommit>

  /** Read one bounded membership page using an opaque cursor.
   * @param query - resolved scope, limit, and cursor values.
   * @returns one current page.
   */
  protected abstract listMembershipRecords(query: MembershipListQuery): Promise<MembershipPage>

  /** Create one active tenant with a Provider-generated stable id.
   * @param input - optional display name and trusted operation metadata.
   * @returns immutable committed tenant record.
   */
  async create(input: TenantCreateInput = {}): Promise<TenantRecord> {
    const context = operationContext(input.context)
    const normalized: TenantCreateRecordInput = Object.freeze({
      ...(input.displayName === undefined ? {} : { displayName: displayName(input.displayName) }),
    })
    const current = tenantSnapshot(await this.provider(() => this.createTenantRecord(normalized)))
    if (current.status !== 'active' || current.revision !== 1 || current.displayName !== normalized.displayName) {
      throw new TenantDirectoryError('provider-unavailable', 'tenant: Provider created an invalid initial tenant record')
    }
    this.emitChange('tenant/changed', this.tenantEvent('created', current, context))
    return current
  }

  /** Get one current tenant record.
   * @param id - stable tenant identity.
   * @returns immutable record, or undefined when absent.
   */
  async get(id: TenantId): Promise<TenantRecord | undefined> {
    tenantId(id)
    const value = await this.provider(() => this.readTenantRecord(id))
    return value === undefined ? undefined : tenantSnapshot(value)
  }

  /** Require that one tenant exists and is currently active.
   * @param id - stable tenant identity.
   * @returns immutable active tenant record.
   */
  async requireActive(id: TenantId): Promise<TenantRecord> {
    const current = await this.get(id)
    if (current === undefined) throw new TenantDirectoryError('tenant-not-found', 'tenant: tenant was not found')
    if (current.status === 'disabled') throw new TenantDirectoryError('tenant-disabled', 'tenant: tenant is disabled')
    if (current.status === 'deleted') throw new TenantDirectoryError('tenant-deleted', 'tenant: tenant is deleted')
    return current
  }

  /** Disable one active tenant using optimistic concurrency.
   * @param request - target id, expected revision, and operation metadata.
   * @returns immutable disabled tenant record.
   */
  disable(request: TenantStatusRequest): Promise<TenantRecord> {
    return this.transitionTenant(request, 'disabled')
  }

  /** Enable one disabled tenant using optimistic concurrency.
   * @param request - target id, expected revision, and operation metadata.
   * @returns immutable active tenant record.
   */
  enable(request: TenantStatusRequest): Promise<TenantRecord> {
    return this.transitionTenant(request, 'active')
  }

  /** Soft-delete one active or disabled tenant using optimistic concurrency.
   * @param request - target id, expected revision, and operation metadata.
   * @returns immutable terminal tenant record.
   */
  delete(request: TenantStatusRequest): Promise<TenantRecord> {
    return this.transitionTenant(request, 'deleted')
  }

  /** Add one user to one active tenant. A removed pair may be re-added under a new membership id.
   * @param request - tenant, user, and trusted operation metadata.
   * @returns immutable committed membership record.
   */
  async addMember(request: TenantMemberAddRequest): Promise<MembershipRecord> {
    const context = operationContext(request.context)
    const id = tenantId(request.tenantId)
    const member = userId(request.userId)
    await this.requireActive(id)
    const current = membershipSnapshot(await this.provider(() => this.createMembershipRecord(Object.freeze({
      tenantId: id,
      userId: member,
    }))))
    if (current.status !== 'active' || current.revision !== 1
      || current.tenantId !== id || current.userId !== member) {
      throw new TenantDirectoryError('provider-unavailable', 'tenant: Provider created an invalid initial membership record')
    }
    this.emitChange('tenant/membership-changed', this.membershipEvent('created', current, context))
    return current
  }

  /** Get the current membership slot for one tenant and user.
   * @param id - stable tenant identity.
   * @param member - stable user identity.
   * @returns immutable record, or undefined when the pair was never added.
   */
  async getMembership(id: TenantId, member: UserId): Promise<MembershipRecord | undefined> {
    tenantId(id)
    userId(member)
    const value = await this.provider(() => this.readMembershipRecord(id, member))
    return value === undefined ? undefined : membershipSnapshot(value)
  }

  /** Require that one tenant and one membership are both currently active.
   * @param id - stable tenant identity.
   * @param member - stable user identity.
   * @returns immutable active membership record.
   */
  async requireActiveMembership(id: TenantId, member: UserId): Promise<MembershipRecord> {
    await this.requireActive(id)
    const current = await this.getMembership(id, member)
    if (current === undefined) {
      throw new TenantDirectoryError('membership-not-found', 'tenant: membership was not found')
    }
    if (current.status === 'disabled') {
      throw new TenantDirectoryError('membership-disabled', 'tenant: membership is disabled')
    }
    if (current.status === 'removed') {
      throw new TenantDirectoryError('membership-removed', 'tenant: membership is removed')
    }
    return current
  }

  /** Disable one active membership using optimistic concurrency.
   * @param request - tenant, user, expected revision, and operation metadata.
   * @returns immutable disabled membership record.
   */
  disableMembership(request: MembershipStatusRequest): Promise<MembershipRecord> {
    return this.transitionMembership(request, 'disabled')
  }

  /** Enable one disabled membership using optimistic concurrency.
   * @param request - tenant, user, expected revision, and operation metadata.
   * @returns immutable active membership record.
   */
  enableMembership(request: MembershipStatusRequest): Promise<MembershipRecord> {
    return this.transitionMembership(request, 'active')
  }

  /** Remove one active or disabled membership using optimistic concurrency.
   * @param request - tenant, user, expected revision, and operation metadata.
   * @returns immutable terminal membership record.
   */
  removeMembership(request: MembershipStatusRequest): Promise<MembershipRecord> {
    return this.transitionMembership(request, 'removed')
  }

  /** List one bounded page of memberships for one tenant.
   * @param query - tenant, optional status, limit, and opaque cursor.
   * @returns immutable page and optional continuation cursor.
   */
  async listMembers(query: TenantMemberListQuery): Promise<MembershipPage> {
    const id = tenantId(query.tenantId)
    if (await this.get(id) === undefined) {
      throw new TenantDirectoryError('tenant-not-found', 'tenant: tenant was not found')
    }
    const bounds = listBounds(query)
    const resolved: MembershipListQuery = Object.freeze({
      scope: 'tenant',
      tenantId: id,
      ...bounds,
    })
    return membershipPage(await this.provider(() => this.listMembershipRecords(resolved)), resolved)
  }

  /** List one bounded page of memberships for one user.
   * @param query - user, optional status, limit, and opaque cursor.
   * @returns immutable page and optional continuation cursor.
   */
  async listUserMemberships(query: UserMembershipListQuery): Promise<MembershipPage> {
    const member = userId(query.userId)
    const bounds = listBounds(query)
    const resolved: MembershipListQuery = Object.freeze({
      scope: 'user',
      userId: member,
      ...bounds,
    })
    return membershipPage(await this.provider(() => this.listMembershipRecords(resolved)), resolved)
  }

  private async transitionTenant(request: TenantStatusRequest, nextStatus: TenantStatus): Promise<TenantRecord> {
    const context = operationContext(request.context)
    const mutation: TenantMutation = Object.freeze({
      kind: 'status',
      tenantId: tenantId(request.tenantId),
      expectedRevision: revision(request.expectedRevision),
      status: nextStatus,
    })
    const commit = tenantMutationCommit(await this.provider(() => this.mutateTenantRecord(mutation)), mutation)
    this.emitChange('tenant/changed', Object.freeze({
      kind: 'status-changed',
      tenantId: commit.current.tenantId,
      revision: commit.current.revision,
      status: commit.current.status,
      time: commit.current.updatedAt,
      ...context,
      previousStatus: commit.previous.status as Exclude<TenantStatus, 'deleted'>,
    }))
    return commit.current
  }

  private async transitionMembership(
    request: MembershipStatusRequest,
    nextStatus: MembershipStatus,
  ): Promise<MembershipRecord> {
    const context = operationContext(request.context)
    const mutation: MembershipMutation = Object.freeze({
      kind: 'status',
      tenantId: tenantId(request.tenantId),
      userId: userId(request.userId),
      expectedRevision: revision(request.expectedRevision),
      status: nextStatus,
    })
    const commit = membershipMutationCommit(
      await this.provider(() => this.mutateMembershipRecord(mutation)),
      mutation,
    )
    this.emitChange('tenant/membership-changed', Object.freeze({
      kind: 'status-changed',
      membershipId: commit.current.membershipId,
      tenantId: commit.current.tenantId,
      userId: commit.current.userId,
      revision: commit.current.revision,
      status: commit.current.status,
      time: commit.current.updatedAt,
      ...context,
      previousStatus: commit.previous.status as Exclude<MembershipStatus, 'removed'>,
    }))
    return commit.current
  }

  private async provider<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (cause) {
      if (cause instanceof TenantDirectoryError) throw cause
      throw new TenantDirectoryError('provider-unavailable', 'tenant: directory Provider failed', { cause })
    }
  }

  private tenantEvent(
    kind: 'created',
    current: TenantRecord,
    context: Readonly<TenantOperationContext>,
  ): TenantChangeEvent {
    return Object.freeze({
      kind,
      tenantId: current.tenantId,
      revision: current.revision,
      status: current.status,
      time: current.updatedAt,
      ...context,
    })
  }

  private membershipEvent(
    kind: 'created',
    current: MembershipRecord,
    context: Readonly<TenantOperationContext>,
  ): TenantMembershipChangeEvent {
    return Object.freeze({
      kind,
      membershipId: current.membershipId,
      tenantId: current.tenantId,
      userId: current.userId,
      revision: current.revision,
      status: current.status,
      time: current.updatedAt,
      ...context,
    })
  }

  private emitChange(
    name: 'tenant/changed' | 'tenant/membership-changed',
    event: TenantChangeEvent | TenantMembershipChangeEvent,
  ): void {
    const report = (error: unknown): void => {
      this.ctx.logger.warn(`tenant: a ${name} listener failed`)
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

export default TenantDirectory
