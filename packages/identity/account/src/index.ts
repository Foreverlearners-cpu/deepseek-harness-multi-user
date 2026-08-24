/**
 * Host-only account lifecycle orchestration.
 * @module @deepseek-ai/dsh-account
 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  AuthenticationError,
  authenticationMethod,
  type AuthenticatedCall,
  type IssuedCredentialSet,
} from '@deepseek-ai/dsh-auth'
import type {} from '@deepseek-ai/dsh-auth-password/types'
import type { UserId, UserRecord } from '@deepseek-ai/dsh-user/types'
import { UserCredentialError } from '@deepseek-ai/dsh-user-credential'
import type { UserCredentialRecord } from '@deepseek-ai/dsh-user-credential/types'
import { UserDirectoryError } from '@deepseek-ai/dsh-user'
import type {
  AccountChangeEvent,
  AccountErrorCode,
  AccountLoginRequest,
  AccountPasswordChangeRequest,
  AccountProfileUpdateRequest,
  AccountRecoveryState,
  AccountRefreshRequest,
  AccountRegistrationInput,
  AccountSessionResult,
  AdminAccountCreateRequest,
  AdminAccountStatusRequest,
  AdminAccountUpdateRequest,
  AdminPasswordResetRequest,
  AdminSessionRevokeRequest,
} from './types.ts'

export type * from './types.ts'

const JWT_METHOD = authenticationMethod('jwt')

/** Stable account failure with optional non-secret partial-commit state. */
export class AccountError extends Error {
  /** Stable transport-safe category. */
  readonly code: AccountErrorCode
  /** Committed state a trusted caller can use for recovery. */
  readonly recovery: AccountRecoveryState | undefined

  /**
   * @param code - stable category.
   * @param message - fixed redacted message.
   * @param recovery - partial commit state.
   */
  constructor(code: AccountErrorCode, message: string, recovery?: AccountRecoveryState) {
    super(message)
    this.name = 'AccountError'
    this.code = code
    this.recovery = recovery
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Active Host-only account orchestration service. */
    accounts: AccountService
  }
}

/** Coordinates users, credentials, authentication, and JWT lifecycle operations. */
export class AccountService extends Service {
  /** @param ctx - Host context carrying all account dependencies. */
  constructor(ctx: Context) {
    super(ctx, 'accounts')
  }

  /** Register an active account and issue its first JWT pair.
   * @param request - profile, identifier, secret, and operation lifecycle.
   * @returns committed user plus newly issued credentials.
   */
  async register(request: AccountRegistrationInput): Promise<AccountSessionResult> {
    this.operation(request)
    const user = await this.createAccount(request)
    try {
      const credentials = await this.issue(user.userId, request)
      this.emit('registered', user.userId, request.requestId)
      return Object.freeze({ user, credentials })
    } catch {
      throw new AccountError('unavailable', 'account: credentials could not be issued', {
        userId: user.userId,
        operation: 'credential-issue',
        userStatus: user.status,
        credentialsConfigured: true,
        compensationComplete: true,
      })
    }
  }

  /** Authenticate a password, require an active user, and issue a JWT pair.
   * @param request - trusted transport login request.
   * @returns active user plus newly issued credentials.
   */
  async login(request: AccountLoginRequest): Promise<AccountSessionResult> {
    this.operation(request)
    try {
      const call = await this.ctx.auth.authenticate({
        requestId: request.requestId,
        channel: request.channel,
        evidence: { kind: 'password', identifier: request.identifier, password: request.password },
        signal: request.signal,
      })
      this.ctx.auth.assertCurrent(call)
      if (call.principal.kind !== 'user') throw new AccountError('unauthenticated', 'account: credentials were rejected')
      const user = await this.ctx.users.requireActive(call.principal.id)
      const credentials = await this.issue(user.userId, request)
      this.emit('logged-in', user.userId, request.requestId)
      return Object.freeze({ user, credentials })
    } catch (cause) {
      throw this.map(cause)
    }
  }

  /** Rotate a JWT refresh credential.
   * @param request - refresh secret and operation lifecycle.
   * @returns replacement access and refresh credentials.
   */
  async refresh(request: AccountRefreshRequest): Promise<IssuedCredentialSet> {
    this.operation(request)
    try {
      return await this.ctx.auth.credentials.refresh(JWT_METHOD, request)
    } catch (cause) {
      throw this.map(cause)
    }
  }

  /** Revoke every JWT session owned by the current user.
   * @param call - exact current authenticated call.
   */
  async logout(call: AuthenticatedCall): Promise<void> {
    const actor = await this.currentUser(call)
    try {
      await this.revokeUser(actor.userId, call.requestId, call.signal)
      this.emit('logged-out', actor.userId, call.requestId)
    } catch (cause) {
      throw this.map(cause)
    }
  }

  /** Update the current user's profile with optimistic concurrency.
   * @param request - current call, expected revision, and profile patch.
   * @returns committed user record.
   */
  async updateProfile(request: AccountProfileUpdateRequest): Promise<UserRecord> {
    const actor = await this.currentUser(request.call)
    try {
      const user = await this.ctx.users.update({
        userId: actor.userId,
        expectedRevision: request.expectedRevision,
        patch: request.patch,
        context: { actorUserId: actor.userId },
      })
      this.emit('profile-updated', user.userId, request.call.requestId, actor.userId)
      return user
    } catch (cause) {
      throw this.map(cause)
    }
  }

  /** Change the current user's password and revoke all existing JWT sessions.
   * @param request - current call, revision, old/new secrets, and lifecycle.
   * @returns committed non-secret credential metadata.
   */
  async changePassword(request: AccountPasswordChangeRequest): Promise<UserCredentialRecord> {
    this.operation(request)
    const actor = await this.currentUser(request.call)
    let credential
    try {
      credential = await this.ctx.userCredentials.changePassword({
        userId: actor.userId,
        expectedRevision: request.expectedCredentialRevision,
        currentPassword: request.currentPassword,
        newPassword: request.newPassword,
        context: { actorUserId: actor.userId },
      })
    } catch (cause) {
      throw this.map(cause)
    }
    try {
      await this.revokeUser(actor.userId, request.requestId, request.signal)
    } catch {
      throw new AccountError('session-revocation-incomplete', 'account: password changed but sessions could not be revoked', {
        userId: actor.userId,
        operation: 'password-change',
        userStatus: 'active',
        credentialsConfigured: true,
        compensationComplete: false,
      })
    }
    this.emit('password-changed', actor.userId, request.requestId, actor.userId)
    return credential
  }

  /** Create an account after the trusted caller authorizes the administrator.
   * @param request - authorized actor and new account values.
   * @returns committed account record without issued credentials.
   */
  async adminCreate(request: AdminAccountCreateRequest): Promise<UserRecord> {
    this.operation(request)
    const actor = await this.currentUser(request.actor)
    const user = await this.createAccount(request, actor.userId)
    this.emit('admin-created', user.userId, request.requestId, actor.userId)
    return user
  }

  /** Update a profile after the trusted caller authorizes the administrator.
   * @param request - authorized actor, target, revision, and patch.
   * @returns committed target record.
   */
  async adminUpdate(request: AdminAccountUpdateRequest): Promise<UserRecord> {
    const actor = await this.currentUser(request.actor)
    try {
      const user = await this.ctx.users.update({
        userId: request.userId,
        expectedRevision: request.expectedRevision,
        patch: request.patch,
        context: this.context(actor.userId, request.reason),
      })
      this.emit('admin-updated', user.userId, request.actor.requestId, actor.userId)
      return user
    } catch (cause) {
      throw this.map(cause)
    }
  }

  /** Disable a target and revoke all sessions after caller authorization.
   * @param request - authorized actor, target revision, reason, and lifecycle.
   * @returns committed disabled record.
   */
  async adminDisable(request: AdminAccountStatusRequest): Promise<UserRecord> {
    this.operation(request)
    const actor = await this.currentUser(request.actor)
    let user: UserRecord
    try {
      user = await this.ctx.users.disable({
        userId: request.userId,
        expectedRevision: request.expectedRevision,
        context: this.context(actor.userId, request.reason),
      })
    } catch (cause) {
      throw this.map(cause)
    }
    try {
      await this.revokeUser(user.userId, request.requestId, request.signal)
    } catch {
      throw new AccountError('session-revocation-incomplete', 'account: user disabled but sessions could not be revoked', {
        userId: user.userId,
        operation: 'disable',
        userStatus: 'disabled',
        credentialsConfigured: true,
        compensationComplete: false,
      })
    }
    this.emit('admin-disabled', user.userId, request.requestId, actor.userId)
    return user
  }

  /** Enable a target after caller authorization.
   * @param request - authorized actor, target revision, and reason.
   * @returns committed active record.
   */
  async adminEnable(request: AdminAccountStatusRequest): Promise<UserRecord> {
    this.operation(request)
    const actor = await this.currentUser(request.actor)
    try {
      const user = await this.ctx.users.enable({
        userId: request.userId,
        expectedRevision: request.expectedRevision,
        context: this.context(actor.userId, request.reason),
      })
      this.emit('admin-enabled', user.userId, request.requestId, actor.userId)
      return user
    } catch (cause) {
      throw this.map(cause)
    }
  }

  /** Reset a target password and revoke all sessions after caller authorization.
   * @param request - authorized actor, target credential revision, and new secret.
   * @returns committed non-secret credential metadata.
   */
  async adminResetPassword(request: AdminPasswordResetRequest): Promise<UserCredentialRecord> {
    this.operation(request)
    const actor = await this.currentUser(request.actor)
    let credential
    try {
      await this.ctx.users.requireActive(request.userId)
      credential = await this.ctx.userCredentials.setPassword({
        userId: request.userId,
        expectedRevision: request.expectedCredentialRevision,
        password: request.newPassword,
        context: this.context(actor.userId, request.reason),
      })
    } catch (cause) {
      throw this.map(cause)
    }
    try {
      await this.revokeUser(request.userId, request.requestId, request.signal)
    } catch {
      throw new AccountError('session-revocation-incomplete', 'account: password reset but sessions could not be revoked', {
        userId: request.userId,
        operation: 'password-reset',
        userStatus: 'active',
        credentialsConfigured: true,
        compensationComplete: false,
      })
    }
    this.emit('admin-password-reset', request.userId, request.requestId, actor.userId)
    return credential
  }

  /** Revoke a target user's JWT sessions after caller authorization.
   * @param request - authorized actor, target, reason, and lifecycle.
   */
  async adminRevokeSessions(request: AdminSessionRevokeRequest): Promise<void> {
    this.operation(request)
    const actor = await this.currentUser(request.actor)
    try {
      await this.revokeUser(request.userId, request.requestId, request.signal)
      this.emit('admin-sessions-revoked', request.userId, request.requestId, actor.userId)
    } catch (cause) {
      throw this.map(cause)
    }
  }

  private async createAccount(request: AccountRegistrationInput, actorUserId?: UserId): Promise<UserRecord> {
    let user: UserRecord
    try {
      user = await this.ctx.users.create({
        ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
        ...(request.extensions === undefined ? {} : { extensions: request.extensions }),
        ...(actorUserId === undefined ? {} : { context: { actorUserId } }),
      })
    } catch (cause) {
      throw this.map(cause)
    }
    const context = actorUserId === undefined ? undefined : { actorUserId }
    try {
      await this.ctx.userCredentials.addIdentifier({
        userId: user.userId,
        expectedRevision: 0,
        ...request.identifier,
        ...(context === undefined ? {} : { context }),
      })
    } catch {
      const disabled = await this.compensateUser(user)
      throw this.registrationFailure(user, false, disabled)
    }
    try {
      await this.ctx.userCredentials.setPassword({
        userId: user.userId,
        expectedRevision: 1,
        password: request.password,
        ...(context === undefined ? {} : { context }),
      })
    } catch {
      const identifierRemoved = await this.compensateIdentifier(user.userId, request.identifier, context)
      const disabled = await this.compensateUser(user)
      throw this.registrationFailure(user, !identifierRemoved, identifierRemoved && disabled)
    }
    return user
  }

  private async compensateIdentifier(userId: UserId, identifier: AccountRegistrationInput['identifier'], context: { actorUserId: UserId } | undefined): Promise<boolean> {
    try {
      await this.ctx.userCredentials.removeIdentifier({
        userId,
        expectedRevision: 1,
        ...identifier,
        ...(context === undefined ? {} : { context }),
      })
      return true
    } catch {
      return false
    }
  }

  private async compensateUser(user: UserRecord): Promise<boolean> {
    try {
      await this.ctx.users.disable({ userId: user.userId, expectedRevision: user.revision })
      return true
    } catch {
      return false
    }
  }

  private registrationFailure(user: UserRecord, credentialsConfigured: boolean, compensationComplete: boolean): AccountError {
    return new AccountError('registration-incomplete', 'account: registration did not complete', {
      userId: user.userId,
      operation: 'registration',
      userStatus: compensationComplete ? 'disabled' : user.status,
      credentialsConfigured,
      compensationComplete,
    })
  }

  private context(actorUserId: UserId, reason: string | undefined): { actorUserId: UserId; reason?: string } {
    return { actorUserId, ...(reason === undefined ? {} : { reason }) }
  }

  private async currentUser(call: AuthenticatedCall): Promise<UserRecord> {
    try {
      const current = this.ctx.auth.assertCurrent(call)
      if (current.principal.kind !== 'user') throw new AccountError('unauthenticated', 'account: a current user call is required')
      return await this.ctx.users.requireActive(current.principal.id)
    } catch (cause) {
      throw this.map(cause)
    }
  }

  private issue(userId: UserId, request: { requestId: AccountRegistrationInput['requestId']; signal: AbortSignal }): Promise<IssuedCredentialSet> {
    return this.ctx.auth.credentials.issue(JWT_METHOD, {
      requestId: request.requestId,
      signal: request.signal,
      principal: { kind: 'user', id: userId },
    })
  }

  private revokeUser(userId: UserId, requestId: AccountRegistrationInput['requestId'], signal: AbortSignal): Promise<void> {
    return this.ctx.auth.credentials.revoke(JWT_METHOD, {
      requestId,
      signal,
      target: { kind: 'principal', principal: { kind: 'user', id: userId } },
    })
  }

  private operation(request: { requestId: unknown; signal: unknown }): void {
    if (typeof request.requestId !== 'string' || !(request.signal instanceof AbortSignal)) {
      throw new AccountError('invalid-input', 'account: operation lifecycle is invalid')
    }
    if (request.signal.aborted) throw new AccountError('unauthenticated', 'account: operation was cancelled')
  }

  private map(cause: unknown): AccountError {
    if (cause instanceof AccountError) return cause
    if (cause instanceof AuthenticationError) {
      return new AccountError(
        cause.code === 'unauthenticated' ? 'unauthenticated' : 'unavailable',
        cause.code === 'unauthenticated' ? 'account: credentials were rejected' : 'account: authentication service is unavailable',
      )
    }
    if (cause instanceof UserDirectoryError) {
      if (cause.code === 'user-disabled' || cause.code === 'user-deleted') {
        return new AccountError('account-inactive', 'account: user is not active')
      }
      if (cause.code === 'revision-conflict' || cause.code === 'status-conflict') {
        return new AccountError('conflict', 'account: account state changed concurrently')
      }
      if (cause.code === 'invalid-input' || cause.code === 'user-not-found') {
        return new AccountError('invalid-input', 'account: request is invalid')
      }
    }
    if (cause instanceof UserCredentialError) {
      if (cause.code === 'revision-conflict' || cause.code === 'identifier-conflict') {
        return new AccountError('conflict', 'account: credential state changed concurrently')
      }
      if (cause.code === 'invalid-credential') {
        return new AccountError('unauthenticated', 'account: credentials were rejected')
      }
      if (cause.code !== 'provider-unavailable') {
        return new AccountError('invalid-input', 'account: request is invalid')
      }
    }
    return new AccountError('unavailable', 'account: account service is unavailable')
  }

  private emit(kind: AccountChangeEvent['kind'], userId: UserId, requestId: AccountChangeEvent['requestId'], actorUserId?: UserId): void {
    const event: AccountChangeEvent = Object.freeze({
      kind,
      userId,
      requestId,
      ...(actorUserId === undefined ? {} : { actorUserId }),
      time: Date.now(),
    })
    for (const listener of this.ctx.events.dispatch('emit', ['account/changed', event])) {
      try {
        const result: unknown = listener(event)
        if (typeof (result as PromiseLike<unknown> | undefined)?.then === 'function') {
          void Promise.resolve(result).catch((error: unknown) => { this.ctx.logger.warn(error) })
        }
      } catch (error) {
        this.ctx.logger.warn(error)
      }
    }
  }
}

export default AccountService
