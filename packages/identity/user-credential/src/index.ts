/**
 * Provider-independent login identifier and password credential service.
 * @module @deepseek-ai/dsh-user-credential
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { isDeepStrictEqual } from 'node:util'
import type { UserId, UserOperationContext } from '@deepseek-ai/dsh-user/types'
import type {
  AddLoginIdentifierRequest,
  ChangePasswordRequest,
  DisablePasswordRequest,
  LoginIdentifier,
  LoginIdentifierInput,
  RemoveLoginIdentifierRequest,
  SetPasswordRequest,
  UserCredentialChangeEvent,
  UserCredentialErrorCode,
  UserCredentialMutation,
  UserCredentialMutationCommit,
  UserCredentialRecord,
  VerifyPasswordRequest,
} from './types.ts'

export type * from './types.ts'

/** Maximum UTF-8 size of one raw or normalized login identifier. */
export const MAX_LOGIN_IDENTIFIER_BYTES = 320
/** Maximum number of identifiers returned for one user. */
export const MAX_LOGIN_IDENTIFIERS = 32
/** Maximum UTF-8 size accepted for one password. */
export const MAX_PASSWORD_BYTES = 1024

const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const USER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/
const MAX_CORRELATION_ID_LENGTH = 128
const MAX_REASON_LENGTH = 500

const SAFE_ERROR_MESSAGES: Readonly<Record<UserCredentialErrorCode, string>> = Object.freeze({
  'invalid-input': 'user-credential: Provider rejected the credential input',
  'credential-not-found': 'user-credential: credential metadata was not found',
  'identifier-conflict': 'user-credential: login identifier is already assigned',
  'identifier-not-found': 'user-credential: login identifier was not found',
  'password-not-set': 'user-credential: password login is not enabled',
  'invalid-credential': 'user-credential: credential verification failed',
  'revision-conflict': 'user-credential: credential revision changed',
  'provider-unavailable': 'user-credential: credential Provider failed',
})

/** Public credential failure with a stable transport-safe category. */
export class UserCredentialError extends Error {
  /** Stable failure category. */
  readonly code: UserCredentialErrorCode

  /** @param code - stable category; @param message - non-secret diagnostic; @param options - causal metadata. */
  constructor(code: UserCredentialErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'UserCredentialError'
    this.code = code
  }
}

function invalid(message: string): UserCredentialError {
  return new UserCredentialError('invalid-input', `user-credential: ${message}`)
}

function utf8(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function checkedUserId(value: UserId): UserId {
  if (typeof value !== 'string' || !USER_ID_PATTERN.test(value)) throw invalid('user id is invalid')
  return value
}

function checkedRevision(value: number, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw invalid('expected revision is invalid')
  return value
}

function checkedKind(value: string, source: 'input' | 'Provider' = 'input'): string {
  if (typeof value !== 'string' || !KIND_PATTERN.test(value)) {
    if (source === 'Provider') throw new UserCredentialError('provider-unavailable', 'user-credential: Provider returned an invalid identifier kind')
    throw invalid(`identifier kind must match ${String(KIND_PATTERN)}`)
  }
  return value
}

function checkedIdentifierValue(value: string, source: 'input' | 'Provider'): string {
  if (typeof value !== 'string' || value.length === 0 || utf8(value) > MAX_LOGIN_IDENTIFIER_BYTES) {
    if (source === 'Provider') throw new UserCredentialError('provider-unavailable', 'user-credential: Provider returned an invalid normalized identifier')
    throw invalid(`identifier must contain 1-${String(MAX_LOGIN_IDENTIFIER_BYTES)} UTF-8 bytes`)
  }
  return value
}

function checkedPassword(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || utf8(value) > MAX_PASSWORD_BYTES) {
    throw invalid(`password must contain 1-${String(MAX_PASSWORD_BYTES)} UTF-8 bytes`)
  }
  return value
}

function operationContext(value: UserOperationContext | undefined): Readonly<UserOperationContext> {
  if (value === undefined) return Object.freeze({})
  const actorUserId = value.actorUserId === undefined ? undefined : checkedUserId(value.actorUserId)
  const correlationId = value.correlationId
  const reason = value.reason
  if (correlationId !== undefined && (typeof correlationId !== 'string' || correlationId.length === 0 || correlationId.length > MAX_CORRELATION_ID_LENGTH)) {
    throw invalid(`correlation id must contain 1-${String(MAX_CORRELATION_ID_LENGTH)} characters`)
  }
  if (reason !== undefined && (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > MAX_REASON_LENGTH)) {
    throw invalid(`reason must contain 1-${String(MAX_REASON_LENGTH)} characters`)
  }
  return Object.freeze({
    ...(actorUserId === undefined ? {} : { actorUserId }),
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(reason === undefined ? {} : { reason: reason.trim() }),
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordSnapshot(value: unknown): UserCredentialRecord {
  if (!isObject(value) || typeof value.userId !== 'string' || !USER_ID_PATTERN.test(value.userId)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || !Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < 0
    || typeof value.passwordEnabled !== 'boolean' || !Array.isArray(value.identifiers)
    || value.identifiers.length > MAX_LOGIN_IDENTIFIERS) {
    throw new UserCredentialError('provider-unavailable', 'user-credential: Provider returned invalid credential metadata')
  }
  const seen = new Set<string>()
  const identifiers = value.identifiers.map((entry: unknown) => {
    if (!isObject(entry) || typeof entry.kind !== 'string' || typeof entry.value !== 'string'
      || !Number.isSafeInteger(entry.createdAt) || (entry.createdAt as number) < 0) {
      throw new UserCredentialError('provider-unavailable', 'user-credential: Provider returned invalid identifier metadata')
    }
    const kind = checkedKind(entry.kind, 'Provider')
    const normalized = checkedIdentifierValue(entry.value, 'Provider')
    const key = `${kind}\0${normalized}`
    if (seen.has(key)) throw new UserCredentialError('provider-unavailable', 'user-credential: Provider returned duplicate identifiers')
    seen.add(key)
    return Object.freeze({ kind, value: normalized, createdAt: entry.createdAt as number })
  })
  const changedAt = value.passwordChangedAt
  if ((value.passwordEnabled && (!Number.isSafeInteger(changedAt) || (changedAt as number) < 0))
    || (!value.passwordEnabled && changedAt !== undefined)) {
    throw new UserCredentialError('provider-unavailable', 'user-credential: Provider returned inconsistent password metadata')
  }
  return Object.freeze({
    userId: value.userId as UserId,
    revision: value.revision as number,
    identifiers: Object.freeze(identifiers),
    passwordEnabled: value.passwordEnabled,
    updatedAt: value.updatedAt as number,
    ...(changedAt === undefined ? {} : { passwordChangedAt: changedAt as number }),
  })
}

function checkedCommit(value: unknown, mutation: UserCredentialMutation): UserCredentialMutationCommit {
  if (!isObject(value)) throw new UserCredentialError('provider-unavailable', 'user-credential: Provider returned an invalid mutation commit')
  const previous = value.previous === undefined ? undefined : recordSnapshot(value.previous)
  const current = recordSnapshot(value.current)
  const expectedCurrentRevision = mutation.expectedRevision + 1
  if (current.userId !== mutation.userId || current.revision !== expectedCurrentRevision
    || (previous === undefined
      ? mutation.expectedRevision !== 0
      : previous.userId !== mutation.userId || previous.revision !== mutation.expectedRevision)
    || (previous !== undefined && current.updatedAt < previous.updatedAt)) {
    throw new UserCredentialError('provider-unavailable', 'user-credential: Provider returned an inconsistent mutation commit')
  }
  const beforeIdentifiers = previous?.identifiers ?? []
  if (mutation.kind === 'identifier-add') {
    const matches = current.identifiers.filter(item => item.kind === mutation.identifier.kind && item.value === mutation.identifier.value)
    const retained = current.identifiers.filter(item => item.kind !== mutation.identifier.kind || item.value !== mutation.identifier.value)
    if (matches.length !== 1 || current.identifiers.length !== beforeIdentifiers.length + 1
      || !isDeepStrictEqual(retained, beforeIdentifiers)
      || current.passwordEnabled !== (previous?.passwordEnabled ?? false)
      || current.passwordChangedAt !== previous?.passwordChangedAt) {
      throw new UserCredentialError('provider-unavailable', 'user-credential: Provider committed an invalid identifier addition')
    }
  } else if (mutation.kind === 'identifier-remove') {
    const expected = beforeIdentifiers.filter(item => item.kind !== mutation.identifier.kind || item.value !== mutation.identifier.value)
    if (expected.length !== beforeIdentifiers.length - 1 || !isDeepStrictEqual(current.identifiers, expected)
      || current.passwordEnabled !== previous?.passwordEnabled
      || current.passwordChangedAt !== previous.passwordChangedAt) {
      throw new UserCredentialError('provider-unavailable', 'user-credential: Provider committed an invalid identifier removal')
    }
  } else if (!isDeepStrictEqual(current.identifiers, beforeIdentifiers)) {
    throw new UserCredentialError('provider-unavailable', 'user-credential: Provider changed identifiers during a password mutation')
  } else if (mutation.kind === 'password-disable') {
    if (!previous?.passwordEnabled || current.passwordEnabled || current.passwordChangedAt !== undefined) {
      throw new UserCredentialError('provider-unavailable', 'user-credential: Provider committed an invalid password disablement')
    }
  } else if ((mutation.kind === 'password-change' && !previous?.passwordEnabled)
    || !current.passwordEnabled || current.passwordChangedAt !== current.updatedAt) {
    throw new UserCredentialError('provider-unavailable', 'user-credential: Provider committed invalid password metadata')
  }
  return Object.freeze({ ...(previous === undefined ? {} : { previous }), current })
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Active login identifier and password credential Provider. */
    userCredentials: UserCredentialService
  }
}

/**
 * Abstract credential service. Providers own normalization, uniqueness,
 * verifier storage, dummy verification, and atomic revision checks.
 */
export abstract class UserCredentialService extends Service {
  /** @param ctx - owning Host context. */
  constructor(ctx: Context) {
    super(ctx, 'userCredentials')
  }

  /** Normalize an identifier with kind-specific Provider rules. */
  protected abstract normalizeLoginIdentifier(input: LoginIdentifierInput): Promise<string>
  /** Read non-secret credential metadata, or absence. */
  protected abstract readCredentialRecord(userId: UserId): Promise<UserCredentialRecord | undefined>
  /** Resolve one normalized identifier without exposing Provider diagnostics. */
  protected abstract resolveLoginIdentifier(identifier: LoginIdentifier): Promise<UserId | undefined>
  /** Atomically compare revision and commit one identifier or password mutation. */
  protected abstract mutateCredentialRecord(mutation: UserCredentialMutation): Promise<UserCredentialMutationCommit>
  /**
   * Verify a password. Providers perform equivalent verifier work for absent users
   * and absent passwords so `false` does not expose account state.
   */
  protected abstract verifyPasswordSecret(userId: UserId | undefined, password: string): Promise<boolean>

  /** Normalize one raw login identifier.
   * @param input - extensible kind and raw value.
   * @returns immutable canonical identifier.
   */
  async normalize(input: LoginIdentifierInput): Promise<LoginIdentifier> {
    const kind = checkedKind(input.kind)
    checkedIdentifierValue(input.value, 'input')
    const value = checkedIdentifierValue(await this.provider(
      () => this.normalizeLoginIdentifier({ kind, value: input.value }),
      ['invalid-input'],
    ), 'Provider')
    return Object.freeze({ kind, value })
  }

  /** Read detached non-secret metadata for one user.
   * @param userId - stable target user id.
   * @returns immutable metadata, or undefined when no aggregate exists.
   */
  async get(userId: UserId): Promise<UserCredentialRecord | undefined> {
    const id = checkedUserId(userId)
    const value = await this.provider(() => this.readCredentialRecord(id), [])
    return value === undefined ? undefined : recordSnapshot(value)
  }

  /** Resolve a raw login identifier to its user, or undefined.
   * @param input - extensible kind and raw value.
   * @returns stable user id, or undefined when no identifier matches.
   */
  async resolve(input: LoginIdentifierInput): Promise<UserId | undefined> {
    const identifier = await this.normalize(input)
    const value = await this.provider(() => this.resolveLoginIdentifier(identifier), [])
    if (value === undefined) return undefined
    try {
      return checkedUserId(value)
    } catch {
      throw new UserCredentialError('provider-unavailable', 'user-credential: Provider returned an invalid user id')
    }
  }

  /** List login identifiers and password-state metadata for one user.
   * @param userId - stable target user id.
   * @returns immutable metadata, or undefined when no aggregate exists.
   */
  list(userId: UserId): Promise<UserCredentialRecord | undefined> {
    return this.get(userId)
  }

  /** Add one globally unique normalized login identifier.
   * @param request - target, revision, raw identifier, and audit context.
   * @returns immutable committed metadata.
   */
  async addIdentifier(request: AddLoginIdentifierRequest): Promise<UserCredentialRecord> {
    const context = operationContext(request.context)
    const identifier = await this.normalize(request)
    return this.mutate({ kind: 'identifier-add', userId: checkedUserId(request.userId), expectedRevision: checkedRevision(request.expectedRevision, true), identifier }, 'identifier-added', context)
  }

  /** Remove one normalized login identifier.
   * @param request - target, revision, raw identifier, and audit context.
   * @returns immutable committed metadata.
   */
  async removeIdentifier(request: RemoveLoginIdentifierRequest): Promise<UserCredentialRecord> {
    const context = operationContext(request.context)
    const identifier = await this.normalize(request)
    return this.mutate({ kind: 'identifier-remove', userId: checkedUserId(request.userId), expectedRevision: checkedRevision(request.expectedRevision), identifier }, 'identifier-removed', context)
  }

  /** Establish or administratively replace a password.
   * @param request - target, revision, new password, and audit context.
   * @returns immutable committed metadata without password material.
   */
  async setPassword(request: SetPasswordRequest): Promise<UserCredentialRecord> {
    return this.mutateWithContext(request, { kind: 'password-set', userId: checkedUserId(request.userId), expectedRevision: checkedRevision(request.expectedRevision, true), password: checkedPassword(request.password) }, 'password-set')
  }

  /** Atomically verify the current password and replace it.
   * @param request - target, revision, current and new passwords, and audit context.
   * @returns immutable committed metadata without password material.
   */
  async changePassword(request: ChangePasswordRequest): Promise<UserCredentialRecord> {
    return this.mutateWithContext(request, { kind: 'password-change', userId: checkedUserId(request.userId), expectedRevision: checkedRevision(request.expectedRevision), currentPassword: checkedPassword(request.currentPassword), newPassword: checkedPassword(request.newPassword) }, 'password-changed')
  }

  /** Disable password login without exposing or returning verifier material.
   * @param request - target, revision, and audit context.
   * @returns immutable committed metadata with password login disabled.
   */
  async disablePassword(request: DisablePasswordRequest): Promise<UserCredentialRecord> {
    return this.mutateWithContext(request, { kind: 'password-disable', userId: checkedUserId(request.userId), expectedRevision: checkedRevision(request.expectedRevision) }, 'password-disabled')
  }

  /** Verify a password with an enumeration-resistant boolean result.
   * @param request - resolved target when present and candidate password.
   * @returns true only for a matching enabled password; otherwise false.
   */
  async verifyPassword(request: VerifyPasswordRequest): Promise<boolean> {
    const userId = request.userId === undefined ? undefined : checkedUserId(request.userId)
    const password = checkedPassword(request.password)
    let result: boolean
    try {
      result = await this.verifyPasswordSecret(userId, password)
    } catch (cause) {
      if (cause instanceof UserCredentialError
        && (cause.code === 'credential-not-found' || cause.code === 'password-not-set' || cause.code === 'invalid-credential')) {
        return false
      }
      throw this.safeProviderError(cause, [])
    }
    if (typeof result !== 'boolean') throw new UserCredentialError('provider-unavailable', 'user-credential: Provider returned an invalid verification result')
    return result
  }

  private mutateWithContext(
    request: { readonly context?: UserOperationContext },
    mutation: UserCredentialMutation,
    kind: UserCredentialChangeEvent['kind'],
  ): Promise<UserCredentialRecord> {
    return this.mutate(mutation, kind, operationContext(request.context))
  }

  private async mutate(
    mutation: UserCredentialMutation,
    kind: UserCredentialChangeEvent['kind'],
    context: Readonly<UserOperationContext>,
  ): Promise<UserCredentialRecord> {
    const allowed = mutation.kind === 'identifier-add'
      ? ['invalid-input', 'credential-not-found', 'identifier-conflict', 'revision-conflict'] as const
      : mutation.kind === 'identifier-remove'
        ? ['credential-not-found', 'identifier-not-found', 'revision-conflict'] as const
        : mutation.kind === 'password-change'
          ? ['credential-not-found', 'password-not-set', 'invalid-credential', 'revision-conflict'] as const
          : mutation.kind === 'password-disable'
            ? ['credential-not-found', 'password-not-set', 'revision-conflict'] as const
            : ['credential-not-found', 'revision-conflict'] as const
    const commit = checkedCommit(await this.provider(
      () => this.mutateCredentialRecord(Object.freeze(mutation)),
      allowed,
    ), mutation)
    this.emitChange(Object.freeze({
      kind,
      userId: commit.current.userId,
      revision: commit.current.revision,
      time: commit.current.updatedAt,
      ...context,
    }))
    return commit.current
  }

  private async provider<T>(operation: () => Promise<T>, allowed: readonly UserCredentialErrorCode[]): Promise<T> {
    try {
      return await operation()
    } catch (cause) {
      throw this.safeProviderError(cause, allowed)
    }
  }

  private safeProviderError(cause: unknown, allowed: readonly UserCredentialErrorCode[]): UserCredentialError {
    const code = cause instanceof UserCredentialError && allowed.includes(cause.code)
      ? cause.code
      : 'provider-unavailable'
    return new UserCredentialError(code, SAFE_ERROR_MESSAGES[code])
  }

  private emitChange(event: UserCredentialChangeEvent): void {
    const report = (error: unknown): void => {
      this.ctx.logger.warn('user-credential: a user-credential/changed listener failed')
      this.ctx.logger.warn(error)
    }
    let invariantFailure: unknown
    for (const listener of this.ctx.events.dispatch('emit', ['user-credential/changed', event])) {
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

export default UserCredentialService
