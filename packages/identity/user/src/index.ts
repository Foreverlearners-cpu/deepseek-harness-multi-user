/**
 * Provider-independent human user directory, lifecycle, and change events.
 * @module @deepseek-ai/dsh-user
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
import type {
  UserChangeEvent,
  UserCreateInput,
  UserCreateRecordInput,
  UserDirectoryErrorCode,
  UserExtensions,
  UserId,
  UserListQuery,
  UserMutation,
  UserMutationCommit,
  UserOperationContext,
  UserPage,
  UserProfilePatch,
  UserRecord,
  UserStatus,
  UserStatusRequest,
  UserUpdateRequest,
} from './types.ts'

export type * from './types.ts'

/** Maximum UTF-8 JSON size accepted for one extensions object. */
export const MAX_USER_EXTENSIONS_BYTES = 16 * 1024
/** Maximum nesting depth accepted inside one extensions object. */
export const MAX_USER_EXTENSIONS_DEPTH = 16
/** Maximum number of UTF-16 code units accepted for a display name. */
export const MAX_USER_DISPLAY_NAME_LENGTH = 200
/** Maximum number of users returned by one list operation. */
export const MAX_USER_LIST_LIMIT = 100

const DEFAULT_USER_LIST_LIMIT = 50
const MAX_CORRELATION_ID_LENGTH = 128
const MAX_REASON_LENGTH = 500
const MAX_CURSOR_LENGTH = 1024
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/
const EXTENSION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*\/[A-Za-z0-9][A-Za-z0-9._~/-]*$/

/** Brand a stable human user id after validation.
 * @param value - untrusted user id candidate.
 * @returns validated user id.
 */
export function userId(value: string): UserId {
  if (!ID_PATTERN.test(value)) {
    throw new TypeError(`user: user id must match ${String(ID_PATTERN)}`)
  }
  return value as UserId
}

/** Public user-directory failure with a stable transport-safe category. */
export class UserDirectoryError extends Error {
  /** Stable category safe for transport mapping. */
  readonly code: UserDirectoryErrorCode

  /** Construct a failure without Provider diagnostics. */
  constructor(code: UserDirectoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'UserDirectoryError'
    this.code = code
  }
}

function invalid(message: string, options?: ErrorOptions): UserDirectoryError {
  return new UserDirectoryError('invalid-input', `user: ${message}`, options)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function cloneExtensionValue(value: unknown, depth: number, ancestors: WeakSet<object>, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(`extensions ${path} must contain a finite number`)
    return value
  }
  if (typeof value !== 'object') throw invalid(`extensions ${path} must contain JSON data`)
  if (depth > MAX_USER_EXTENSIONS_DEPTH) {
    throw invalid(`extensions exceed the maximum depth of ${String(MAX_USER_EXTENSIONS_DEPTH)}`)
  }
  if (ancestors.has(value)) throw invalid(`extensions ${path} contains a circular reference`)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const copy = value.map((entry, index) => cloneExtensionValue(entry, depth + 1, ancestors, `${path}[${String(index)}]`))
      return Object.freeze(copy)
    }
    if (!isPlainObject(value)) throw invalid(`extensions ${path} must contain a plain object`)
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw invalid(`extensions ${path} must not contain symbol keys`)
    }
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !('value' in descriptor)) {
        throw invalid(`extensions ${path}.${key} must be an enumerable data property`)
      }
      copy[key] = cloneExtensionValue(descriptor.value, depth + 1, ancestors, `${path}.${key}`)
    }
    return Object.freeze(copy)
  } finally {
    ancestors.delete(value)
  }
}

/** Validate, detach, bound, and deeply freeze one extensions object.
 * @param value - extensions candidate from a caller or Provider.
 * @returns immutable JSON data safe to hand to Consumers.
 */
export function userExtensions(value: unknown): UserExtensions {
  if (!isPlainObject(value)) throw invalid('extensions must be a JSON object')
  for (const key of Object.keys(value)) {
    if (!EXTENSION_KEY_PATTERN.test(key)) {
      throw invalid(`extension key "${key}" must be namespaced, for example "example/locale"`)
    }
  }
  const copy = cloneExtensionValue(value, 0, new WeakSet<object>(), '$') as UserExtensions
  const bytes = new TextEncoder().encode(JSON.stringify(copy)).byteLength
  if (bytes > MAX_USER_EXTENSIONS_BYTES) {
    throw invalid(`extensions exceed ${String(MAX_USER_EXTENSIONS_BYTES)} UTF-8 bytes`)
  }
  return copy
}

function displayName(value: unknown): string {
  if (typeof value !== 'string') throw invalid('display name must be a string')
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > MAX_USER_DISPLAY_NAME_LENGTH) {
    throw invalid(`display name must contain 1-${String(MAX_USER_DISPLAY_NAME_LENGTH)} characters after trimming`)
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
    throw new UserDirectoryError('provider-unavailable', `user: Provider returned an invalid ${label}`)
  }
  return value as number
}

function status(value: unknown): UserStatus {
  if (value !== 'active' && value !== 'disabled' && value !== 'deleted') {
    throw new UserDirectoryError('provider-unavailable', 'user: Provider returned an invalid status')
  }
  return value
}

function operationContext(value: UserOperationContext | undefined): Readonly<UserOperationContext> {
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

function profilePatch(value: UserProfilePatch): Readonly<UserProfilePatch> {
  const hasDisplayName = Object.hasOwn(value, 'displayName')
  const hasExtensions = Object.hasOwn(value, 'extensions')
  if (!hasDisplayName && !hasExtensions) throw invalid('profile update must change at least one field')
  const normalizedName = !hasDisplayName || value.displayName === null
    ? value.displayName
    : displayName(value.displayName)
  const normalizedExtensions = !hasExtensions ? undefined : userExtensions(value.extensions)
  return Object.freeze({
    ...(hasDisplayName ? { displayName: normalizedName } : {}),
    ...(hasExtensions ? { extensions: normalizedExtensions as UserExtensions } : {}),
  })
}

function uncheckedRecordSnapshot(value: unknown): UserRecord {
  if (!isPlainObject(value) || typeof value.userId !== 'string') {
    throw new UserDirectoryError('provider-unavailable', 'user: Provider returned an invalid user record')
  }
  const id = userId(value.userId)
  const currentStatus = status(value.status)
  const createdAt = timestamp('createdAt', value.createdAt)
  const updatedAt = timestamp('updatedAt', value.updatedAt)
  if (updatedAt < createdAt) {
    throw new UserDirectoryError('provider-unavailable', 'user: Provider returned updatedAt before createdAt')
  }
  const currentRevision = revision(value.revision)
  const extensions = userExtensions(value.extensions)
  const name = value.displayName === undefined ? undefined : displayName(value.displayName)
  if (name !== value.displayName) {
    throw new UserDirectoryError('provider-unavailable', 'user: Provider returned a non-normalized display name')
  }
  return Object.freeze({
    userId: id,
    ...(name === undefined ? {} : { displayName: name }),
    status: currentStatus,
    createdAt,
    updatedAt,
    revision: currentRevision,
    extensions,
  })
}

function recordSnapshot(value: unknown): UserRecord {
  try {
    return uncheckedRecordSnapshot(value)
  } catch (cause) {
    if (cause instanceof UserDirectoryError && cause.code === 'provider-unavailable') throw cause
    throw new UserDirectoryError('provider-unavailable', 'user: Provider returned an invalid user record', { cause })
  }
}

function mutationCommit(value: unknown, mutation: UserMutation): Readonly<UserMutationCommit> {
  if (!isPlainObject(value)) {
    throw new UserDirectoryError('provider-unavailable', 'user: Provider returned an invalid mutation commit')
  }
  const previous = recordSnapshot(value.previous)
  const current = recordSnapshot(value.current)
  if (previous.userId !== mutation.userId || current.userId !== mutation.userId
    || previous.revision !== mutation.expectedRevision
    || current.revision !== previous.revision + 1
    || current.createdAt !== previous.createdAt
    || current.updatedAt < previous.updatedAt) {
    throw new UserDirectoryError('provider-unavailable', 'user: Provider returned an inconsistent mutation commit')
  }
  if (mutation.kind === 'profile') {
    if (previous.status === 'deleted' || current.status !== previous.status) {
      throw new UserDirectoryError('provider-unavailable', 'user: Provider committed an invalid profile update')
    }
    const expectedName = Object.hasOwn(mutation.patch, 'displayName')
      ? mutation.patch.displayName ?? undefined
      : previous.displayName
    const expectedExtensions = Object.hasOwn(mutation.patch, 'extensions')
      ? mutation.patch.extensions
      : previous.extensions
    if (current.displayName !== expectedName || !isDeepStrictEqual(current.extensions, expectedExtensions)) {
      throw new UserDirectoryError('provider-unavailable', 'user: Provider committed unexpected profile fields')
    }
  } else {
    const expectedPrevious = mutation.status === 'active' ? 'disabled' : mutation.status === 'disabled' ? 'active' : undefined
    if ((expectedPrevious !== undefined && previous.status !== expectedPrevious)
      || (mutation.status === 'deleted' && previous.status === 'deleted')
      || current.status !== mutation.status
      || current.displayName !== previous.displayName
      || !isDeepStrictEqual(current.extensions, previous.extensions)) {
      throw new UserDirectoryError('provider-unavailable', 'user: Provider committed an invalid status transition')
    }
  }
  return Object.freeze({ previous, current })
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Active human user directory Provider. */
    users: UserDirectory
  }
}

/**
 * Abstract user directory. Providers own durable records and atomic revision
 * checks; this base owns validation, stable failures, detached results, and
 * post-commit events.
 */
export abstract class UserDirectory extends Service {
  /** @param ctx - owning Host context. */
  constructor(ctx: Context) {
    super(ctx, 'users')
  }

  /** Persist one new active user with revision 1 and a Provider-generated id.
   * @param input - validated and detached profile values.
   * @returns committed Provider record.
   */
  protected abstract createRecord(input: UserCreateRecordInput): Promise<UserRecord>

  /** Read one Provider record without changing it.
   * @param id - stable user identity.
   * @returns current record, or undefined when absent.
   */
  protected abstract readRecord(id: UserId): Promise<UserRecord | undefined>

  /** Atomically compare revision, commit one mutation, and return both records.
   * @param mutation - validated profile or lifecycle mutation.
   * @returns atomic before-and-after commit records.
   */
  protected abstract mutateRecord(mutation: UserMutation): Promise<UserMutationCommit>

  /** Read one bounded Provider page using an opaque cursor.
   * @param query - resolved status, limit, and cursor values.
   * @returns one current page.
   */
  protected abstract listRecords(query: Required<Pick<UserListQuery, 'limit'>> & Omit<UserListQuery, 'limit'>): Promise<UserPage>

  /** Create one active user with a Provider-generated stable id.
   * @param input - optional profile and trusted operation metadata.
   * @returns immutable committed user record.
   */
  async create(input: UserCreateInput = {}): Promise<UserRecord> {
    const context = operationContext(input.context)
    const normalized: UserCreateRecordInput = Object.freeze({
      ...(input.displayName === undefined ? {} : { displayName: displayName(input.displayName) }),
      extensions: userExtensions(input.extensions ?? {}),
    })
    const current = recordSnapshot(await this.provider(() => this.createRecord(normalized)))
    if (current.status !== 'active' || current.revision !== 1
      || current.displayName !== normalized.displayName
      || !isDeepStrictEqual(current.extensions, normalized.extensions)) {
      throw new UserDirectoryError('provider-unavailable', 'user: Provider created an invalid initial user record')
    }
    this.emitChange(this.event('created', current, context))
    return current
  }

  /** Get one current user record.
   * @param id - stable user identity.
   * @returns immutable record, or undefined when absent.
   */
  async get(id: UserId): Promise<UserRecord | undefined> {
    userId(id)
    const value = await this.provider(() => this.readRecord(id))
    return value === undefined ? undefined : recordSnapshot(value)
  }

  /** Require that one user exists and is currently active.
   * @param id - stable user identity.
   * @returns immutable active user record.
   */
  async requireActive(id: UserId): Promise<UserRecord> {
    const current = await this.get(id)
    if (current === undefined) throw new UserDirectoryError('user-not-found', 'user: user was not found')
    if (current.status === 'disabled') throw new UserDirectoryError('user-disabled', 'user: user is disabled')
    if (current.status === 'deleted') throw new UserDirectoryError('user-deleted', 'user: user is deleted')
    return current
  }

  /** Update mutable profile fields using optimistic concurrency.
   * @param request - target id, expected revision, patch, and operation metadata.
   * @returns immutable committed user record.
   */
  async update(request: UserUpdateRequest): Promise<UserRecord> {
    const context = operationContext(request.context)
    const mutation: UserMutation = Object.freeze({
      kind: 'profile',
      userId: userId(request.userId),
      expectedRevision: revision(request.expectedRevision),
      patch: profilePatch(request.patch),
    })
    const commit = mutationCommit(await this.provider(() => this.mutateRecord(mutation)), mutation)
    this.emitChange(this.event('profile-updated', commit.current, context))
    return commit.current
  }

  /** Disable one active user using optimistic concurrency.
   * @param request - target id, expected revision, and operation metadata.
   * @returns immutable disabled user record.
   */
  disable(request: UserStatusRequest): Promise<UserRecord> {
    return this.transition(request, 'disabled')
  }

  /** Enable one disabled user using optimistic concurrency.
   * @param request - target id, expected revision, and operation metadata.
   * @returns immutable active user record.
   */
  enable(request: UserStatusRequest): Promise<UserRecord> {
    return this.transition(request, 'active')
  }

  /** Soft-delete one active or disabled user using optimistic concurrency.
   * @param request - target id, expected revision, and operation metadata.
   * @returns immutable terminal user record.
   */
  delete(request: UserStatusRequest): Promise<UserRecord> {
    return this.transition(request, 'deleted')
  }

  /** List one bounded page of current users.
   * @param query - optional status, limit, and opaque cursor.
   * @returns immutable page and optional continuation cursor.
   */
  async list(query: UserListQuery = {}): Promise<UserPage> {
    const limit = query.limit ?? DEFAULT_USER_LIST_LIMIT
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_USER_LIST_LIMIT) {
      throw invalid(`list limit must be an integer from 1 to ${String(MAX_USER_LIST_LIMIT)}`)
    }
    if (query.cursor !== undefined
      && (typeof query.cursor !== 'string' || query.cursor.length === 0 || query.cursor.length > MAX_CURSOR_LENGTH)) {
      throw invalid(`list cursor must contain 1-${String(MAX_CURSOR_LENGTH)} characters`)
    }
    const resolved = Object.freeze({
      limit,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    })
    const page: unknown = await this.provider(() => this.listRecords(resolved))
    if (!isPlainObject(page) || !Array.isArray(page.users) || page.users.length > limit
      || (page.nextCursor !== undefined
        && (typeof page.nextCursor !== 'string' || page.nextCursor.length === 0 || page.nextCursor.length > MAX_CURSOR_LENGTH))) {
      throw new UserDirectoryError('provider-unavailable', 'user: Provider returned an invalid user page')
    }
    const seen = new Set<UserId>()
    const users = page.users.map((value) => {
      const current = recordSnapshot(value)
      if (seen.has(current.userId) || (query.status !== undefined && current.status !== query.status)) {
        throw new UserDirectoryError('provider-unavailable', 'user: Provider returned an inconsistent user page')
      }
      seen.add(current.userId)
      return current
    })
    return Object.freeze({
      users: Object.freeze(users),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    })
  }

  private async transition(request: UserStatusRequest, nextStatus: UserStatus): Promise<UserRecord> {
    const context = operationContext(request.context)
    const mutation: UserMutation = Object.freeze({
      kind: 'status',
      userId: userId(request.userId),
      expectedRevision: revision(request.expectedRevision),
      status: nextStatus,
    })
    const commit = mutationCommit(await this.provider(() => this.mutateRecord(mutation)), mutation)
    this.emitChange(Object.freeze({
      kind: 'status-changed',
      userId: commit.current.userId,
      revision: commit.current.revision,
      status: commit.current.status,
      time: commit.current.updatedAt,
      ...context,
      previousStatus: commit.previous.status as Exclude<UserStatus, 'deleted'>,
    }))
    return commit.current
  }

  private async provider<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (cause) {
      if (cause instanceof UserDirectoryError) throw cause
      throw new UserDirectoryError('provider-unavailable', 'user: directory Provider failed', { cause })
    }
  }

  private event(
    kind: 'created' | 'profile-updated',
    current: UserRecord,
    context: Readonly<UserOperationContext>,
  ): UserChangeEvent {
    return Object.freeze({
      kind,
      userId: current.userId,
      revision: current.revision,
      status: current.status,
      time: current.updatedAt,
      ...context,
    })
  }

  private emitChange(event: UserChangeEvent): void {
    const report = (error: unknown): void => {
      this.ctx.logger.warn('user: a user/changed listener failed')
      this.ctx.logger.warn(error)
    }
    let invariantFailure: unknown
    for (const listener of this.ctx.events.dispatch('emit', ['user/changed', event])) {
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

export default UserDirectory
