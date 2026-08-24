/**
 * Host-only account lifecycle orchestration.
 * @module @deepseek-ai/dsh-account
 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  AuthenticationError,
  authenticationMethod,
  authenticationRequestId,
  type AuthenticatedCall,
  type IssuedCredentialSet,
} from '@deepseek-ai/dsh-auth'
import type {} from '@deepseek-ai/dsh-auth-password/types'
import type { UserId, UserRecord } from '@deepseek-ai/dsh-user/types'
import { UserCredentialError } from '@deepseek-ai/dsh-user-credential'
import type { LoginIdentifier, UserCredentialRecord } from '@deepseek-ai/dsh-user-credential/types'
import { UserDirectoryError } from '@deepseek-ai/dsh-user'
import type {
  AccountChangeEvent,
  AccountAdminAction,
  AccountAdminAuthorizer,
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
  RegistrationOperationAdvanceRequest,
  RegistrationOperationProvider,
  RegistrationOperationRecord,
} from './types.ts'

export type * from './types.ts'

const JWT_METHOD = authenticationMethod('jwt')
const ADMIN_VALIDATE = Symbol('account.admin.validate')
const ADMIN_CREATE = Symbol('account.admin.create')
const ADMIN_UPDATE = Symbol('account.admin.update')
const ADMIN_DISABLE = Symbol('account.admin.disable')
const ADMIN_ENABLE = Symbol('account.admin.enable')
const ADMIN_RESET_PASSWORD = Symbol('account.admin.reset-password')
const ADMIN_REVOKE_SESSIONS = Symbol('account.admin.revoke-sessions')
const REGISTRATION_STAGES = new Set<RegistrationOperationRecord['stage']>([
  'begun',
  'user-created',
  'identifier-added',
  'password-set',
  'completed',
  'failed',
])

/** Registry that admits one durable registration operation Provider. */
export class RegistrationOperationProviderRegistry {
  private provider: RegistrationOperationProvider | undefined

  /** Register the sole Provider.
   * @param provider - durable idempotency implementation.
   * @returns idempotent registration disposer.
   */
  register(provider: RegistrationOperationProvider): () => void {
    if (this.provider !== undefined) throw new AccountError('conflict', 'account: registration operation Provider already exists')
    this.provider = provider
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.provider === provider) this.provider = undefined
    }
  }

  /** Require the current Provider.
   * @returns active durable Provider.
   */
  require(): RegistrationOperationProvider {
    if (this.provider === undefined) throw new AccountError('unavailable', 'account: registration operation Provider is unavailable')
    return this.provider
  }
}

/** Registry that admits one administrator authorization Provider. */
export class AccountAdminAuthorizerRegistry {
  private provider: AccountAdminAuthorizer | undefined

  /** Register the sole Provider.
   * @param provider - administrator policy implementation.
   * @returns idempotent registration disposer.
   */
  register(provider: AccountAdminAuthorizer): () => void {
    if (this.provider !== undefined) throw new AccountError('conflict', 'account: administrator authorizer already exists')
    this.provider = provider
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.provider === provider) this.provider = undefined
    }
  }

  /** Authorize one action or fail closed.
   * @param actor - current authenticated actor.
   * @param action - exact administrator capability.
   * @param target - optional target user.
   */
  async authorize(actor: AuthenticatedCall, action: AccountAdminAction, target?: UserId): Promise<void> {
    if (this.provider === undefined) throw new AccountError('forbidden', 'account: administrator authorization was denied')
    try {
      await this.provider.authorize({ actor, action, ...(target === undefined ? {} : { target }) })
    } catch {
      throw new AccountError('forbidden', 'account: administrator authorization was denied')
    }
  }
}

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
    /** Explicit administrator account capability. */
    accountAdministration: AccountAdministrationService
  }
}

/** Coordinates users, credentials, authentication, and JWT lifecycle operations. */
export class AccountService extends Service {
  /** Durable registration operation Provider registry. */
  readonly registrationOperations: RegistrationOperationProviderRegistry = new RegistrationOperationProviderRegistry()
  /** @param ctx - Host context carrying all account dependencies. */
  constructor(ctx: Context) {
    super(ctx, 'accounts')
  }

  /** Idempotently register one active account.
   * @param request - profile, identifier, secret, and operation lifecycle.
   * @returns the same committed user for every completed retry.
   */
  async register(request: AccountRegistrationInput): Promise<UserRecord> {
    this.operation(request)
    const provider = this.registrationOperations.require()
    const identifier = await this.normalizeIdentifier(request.identifier)
    let operation: RegistrationOperationRecord
    try {
      operation = this.registrationRecord(await provider.begin(request.requestId), request.requestId)
    } catch (cause) {
      throw this.map(cause)
    }
    if (operation.stage === 'failed') throw this.persistedRegistrationFailure(operation)
    if (operation.stage === 'completed') return this.completedRegistration(operation)

    let user: UserRecord
    if (operation.stage === 'begun') {
      try {
        user = await this.ctx.users.create({
          ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
          ...(request.extensions === undefined ? {} : { extensions: request.extensions }),
        })
      } catch (cause) {
        throw this.map(cause)
      }
      try {
        operation = this.registrationRecord(await provider.advance({
          requestId: request.requestId,
          expectedRevision: operation.revision,
          expectedStage: 'begun',
          stage: 'user-created',
          userId: user.userId,
        }), request.requestId)
      } catch {
        const disabled = await this.compensateUser(user)
        const recovery = this.recovery(user, false, disabled)
        await this.persistFailure(provider, operation, user.userId, recovery)
        throw new AccountError('registration-incomplete', 'account: registration did not complete', recovery)
      }
    } else {
      user = await this.registrationUser(operation)
    }

    if (operation.stage === 'user-created') {
      operation = await this.ensureIdentifier(provider, operation, user, identifier)
    }
    if (operation.stage === 'identifier-added') {
      operation = await this.ensurePassword(provider, operation, user, identifier, request.password)
    }
    if (operation.stage === 'password-set') {
      try {
        operation = this.registrationRecord(
          await provider.complete(request.requestId, operation.revision, user),
          request.requestId,
        )
      } catch (cause) {
        throw this.map(cause)
      }
    }
    if (operation.stage !== 'completed') throw new AccountError('unavailable', 'account: registration operation is inconsistent')
    this.emit('registered', user.userId, request.requestId)
    return user
  }

  /** Authenticate a password, require an active user, and issue a JWT pair.
   * @param request - trusted transport login request.
   * @returns active user plus newly issued credentials.
   */
  async login(request: AccountLoginRequest): Promise<AccountSessionResult> {
    this.operation(request)
    let before: UserCredentialRecord | undefined
    let resolvedUserId: UserId | undefined
    try {
      const identifier = await this.ctx.userCredentials.normalize(request.identifier)
      resolvedUserId = await this.ctx.userCredentials.resolve(identifier)
      before = resolvedUserId === undefined ? undefined : await this.ctx.userCredentials.get(resolvedUserId)
      const call = await this.ctx.auth.authenticate({
        requestId: request.requestId,
        channel: request.channel,
        evidence: { kind: 'password', identifier: request.identifier, password: request.password },
        signal: request.signal,
      })
      this.ctx.auth.assertCurrent(call)
      if (call.principal.kind !== 'user' || resolvedUserId !== call.principal.id
        || before === undefined || !before.passwordEnabled) {
        throw new AccountError('unauthenticated', 'account: credentials were rejected')
      }
      const user = await this.ctx.users.requireActive(call.principal.id)
      const credentials = await this.issue(user.userId, request)
      let after: UserCredentialRecord | undefined
      try {
        after = await this.ctx.userCredentials.get(user.userId)
      } catch (cause) {
        await this.revokeIssued(credentials, user.userId, request)
        throw cause
      }
      if (after === undefined || after.userId !== before.userId
        || after.revision !== before.revision || !after.passwordEnabled) {
        await this.revokeIssued(credentials, user.userId, request)
        throw new AccountError('unauthenticated', 'account: credentials changed during login')
      }
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
    this.operation(call)
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
    this.operation(request.call)
    const actor = await this.currentUser(request.call)
    try {
      const user = await this.ctx.users.update({
        userId: actor.userId,
        expectedRevision: request.expectedRevision,
        patch: { displayName: request.displayName },
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
  async [ADMIN_CREATE](request: AdminAccountCreateRequest): Promise<UserRecord> {
    this.operation(request)
    const actor = await this.currentUser(request.actor)
    const user = await this.ctx.accounts.register(request)
    this.emit('admin-created', user.userId, request.requestId, actor.userId)
    return user
  }

  /** Update a profile after the trusted caller authorizes the administrator.
   * @param request - authorized actor, target, revision, and patch.
   * @returns committed target record.
   */
  async [ADMIN_UPDATE](request: AdminAccountUpdateRequest): Promise<UserRecord> {
    this.operation(request.actor)
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
  async [ADMIN_DISABLE](request: AdminAccountStatusRequest): Promise<UserRecord> {
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
  async [ADMIN_ENABLE](request: AdminAccountStatusRequest): Promise<UserRecord> {
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
  async [ADMIN_RESET_PASSWORD](request: AdminPasswordResetRequest): Promise<UserCredentialRecord> {
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
  async [ADMIN_REVOKE_SESSIONS](request: AdminSessionRevokeRequest): Promise<void> {
    this.operation(request)
    const actor = await this.currentUser(request.actor)
    try {
      await this.revokeUser(request.userId, request.requestId, request.signal)
      this.emit('admin-sessions-revoked', request.userId, request.requestId, actor.userId)
    } catch (cause) {
      throw this.map(cause)
    }
  }

  private async normalizeIdentifier(identifier: AccountRegistrationInput['identifier']): Promise<LoginIdentifier> {
    try {
      return await this.ctx.userCredentials.normalize(identifier)
    } catch (cause) {
      throw this.map(cause)
    }
  }

  private registrationRecord(value: RegistrationOperationRecord, requestId: AccountRegistrationInput['requestId']): RegistrationOperationRecord {
    const needsUser = value.stage !== 'begun'
    if (!REGISTRATION_STAGES.has(value.stage)
      || value.requestId !== requestId || !Number.isSafeInteger(value.revision) || value.revision < 1
      || (needsUser && value.userId === undefined)
      || (value.stage === 'completed' && value.result?.userId !== value.userId)
      || (value.stage === 'failed' && value.recovery?.userId !== value.userId)) {
      throw new AccountError('unavailable', 'account: registration operation Provider returned inconsistent state')
    }
    return Object.freeze({ ...value })
  }

  private persistedRegistrationFailure(operation: RegistrationOperationRecord): AccountError {
    return new AccountError('registration-incomplete', 'account: registration did not complete', operation.recovery)
  }

  private completedRegistration(operation: RegistrationOperationRecord): UserRecord {
    return Object.freeze({ ...operation.result as UserRecord })
  }

  private async registrationUser(operation: RegistrationOperationRecord): Promise<UserRecord> {
    try {
      const user = await this.ctx.users.get(operation.userId as UserId)
      if (user === undefined) throw new AccountError('unavailable', 'account: registration user is unavailable')
      return user
    } catch (cause) {
      throw this.map(cause)
    }
  }

  private async ensureIdentifier(
    provider: RegistrationOperationProvider,
    operation: RegistrationOperationRecord,
    user: UserRecord,
    identifier: LoginIdentifier,
  ): Promise<RegistrationOperationRecord> {
    let credential = await this.readCredential(user.userId)
    if (!this.hasIdentifier(credential, identifier)) {
      try {
        credential = await this.ctx.userCredentials.addIdentifier({
          userId: user.userId,
          expectedRevision: credential?.revision ?? 0,
          ...identifier,
        })
      } catch {
        try {
          credential = await this.readCredential(user.userId)
        } catch {
          await this.failRegistration(provider, operation, user, identifier)
        }
        if (!this.hasIdentifier(credential, identifier)) {
          await this.failRegistration(provider, operation, user, identifier)
        }
      }
    }
    return this.advanceRegistration(provider, operation, 'identifier-added', user.userId)
  }

  private async ensurePassword(
    provider: RegistrationOperationProvider,
    operation: RegistrationOperationRecord,
    user: UserRecord,
    identifier: LoginIdentifier,
    password: string,
  ): Promise<RegistrationOperationRecord> {
    let credential = await this.readCredential(user.userId)
    if (credential === undefined) {
      return this.failRegistration(provider, operation, user, identifier)
    }
    if (!this.hasIdentifier(credential, identifier)) {
      return this.failRegistration(provider, operation, user, identifier)
    }
    if (!credential.passwordEnabled) {
      try {
        credential = await this.ctx.userCredentials.setPassword({
          userId: user.userId,
          expectedRevision: credential.revision,
          password,
        })
      } catch {
        try {
          credential = await this.readCredential(user.userId)
        } catch {
          await this.failRegistration(provider, operation, user, identifier)
        }
        if (credential === undefined || !credential.passwordEnabled) {
          await this.failRegistration(provider, operation, user, identifier)
        }
      }
    }
    return this.advanceRegistration(provider, operation, 'password-set', user.userId)
  }

  private async advanceRegistration(
    provider: RegistrationOperationProvider,
    operation: RegistrationOperationRecord,
    stage: RegistrationOperationAdvanceRequest['stage'],
    userId: UserId,
  ): Promise<RegistrationOperationRecord> {
    try {
      return this.registrationRecord(await provider.advance({
        requestId: operation.requestId,
        expectedRevision: operation.revision,
        expectedStage: operation.stage,
        stage,
        userId,
      }), operation.requestId)
    } catch (cause) {
      throw this.map(cause)
    }
  }

  private async failRegistration(
    provider: RegistrationOperationProvider,
    operation: RegistrationOperationRecord,
    user: UserRecord,
    identifier: LoginIdentifier,
  ): Promise<never> {
    let credentialsConfigured = true
    try {
      credentialsConfigured = await this.cleanupCredentials(user.userId, identifier)
    } catch {
      // Unknown credential state is reported conservatively as still configured.
    }
    const disabled = await this.compensateUser(user)
    const recovery = this.recovery(user, credentialsConfigured, disabled && !credentialsConfigured)
    await this.persistFailure(provider, operation, user.userId, recovery)
    throw new AccountError('registration-incomplete', 'account: registration did not complete', recovery)
  }

  private async cleanupCredentials(userId: UserId, identifier: LoginIdentifier): Promise<boolean> {
    let credential = await this.readCredential(userId)
    if (credential?.passwordEnabled === true) {
      try {
        credential = await this.ctx.userCredentials.disablePassword({
          userId,
          expectedRevision: credential.revision,
        })
      } catch {
        credential = await this.readCredential(userId)
      }
    }
    if (credential !== undefined && this.hasIdentifier(credential, identifier)) {
      try {
        credential = await this.ctx.userCredentials.removeIdentifier({
          userId,
          expectedRevision: credential.revision,
          ...identifier,
        })
      } catch {
        credential = await this.readCredential(userId)
      }
    }
    return credential?.passwordEnabled === true || this.hasIdentifier(credential, identifier)
  }

  private async readCredential(userId: UserId): Promise<UserCredentialRecord | undefined> {
    try {
      return await this.ctx.userCredentials.get(userId)
    } catch (cause) {
      throw this.map(cause)
    }
  }

  private hasIdentifier(credential: UserCredentialRecord | undefined, identifier: LoginIdentifier): boolean {
    return credential?.identifiers.some(value => value.kind === identifier.kind && value.value === identifier.value) ?? false
  }

  private recovery(user: UserRecord, credentialsConfigured: boolean, compensationComplete: boolean): AccountRecoveryState {
    return Object.freeze({
      userId: user.userId,
      operation: 'registration',
      userStatus: compensationComplete ? 'disabled' : user.status,
      credentialsConfigured,
      compensationComplete,
    })
  }

  private async persistFailure(
    provider: RegistrationOperationProvider,
    operation: RegistrationOperationRecord,
    userId: UserId,
    recovery: AccountRecoveryState,
  ): Promise<void> {
    try {
      await provider.advance({
        requestId: operation.requestId,
        expectedRevision: operation.revision,
        expectedStage: operation.stage,
        stage: 'failed',
        userId,
        recovery,
      })
    } catch {
      // Registration recovery remains safe even when its progress Provider is unavailable.
    }
  }

  protected async compensateUser(user: UserRecord): Promise<boolean> {
    try {
      await this.ctx.users.disable({ userId: user.userId, expectedRevision: user.revision })
      return true
    } catch {
      return false
    }
  }

  protected context(actorUserId: UserId, reason: string | undefined): { actorUserId: UserId; reason?: string } {
    return { actorUserId, ...(reason === undefined ? {} : { reason }) }
  }

  protected async currentUser(call: AuthenticatedCall): Promise<UserRecord> {
    try {
      const current = this.ctx.auth.assertCurrent(call)
      if (current.principal.kind !== 'user') throw new AccountError('unauthenticated', 'account: a current user call is required')
      return await this.ctx.users.requireActive(current.principal.id)
    } catch (cause) {
      throw this.map(cause)
    }
  }

  protected issue(userId: UserId, request: { requestId: AccountRegistrationInput['requestId']; signal: AbortSignal }): Promise<IssuedCredentialSet> {
    return this.ctx.auth.credentials.issue(JWT_METHOD, {
      requestId: request.requestId,
      signal: request.signal,
      principal: { kind: 'user', id: userId },
    })
  }

  private revokeIssued(
    credentials: IssuedCredentialSet,
    userId: UserId,
    request: { requestId: AccountRegistrationInput['requestId']; signal: AbortSignal },
  ): Promise<void> {
    const family = credentials.credentials.find(value => value.kind === 'refresh')?.tokenFamilyId
    return this.ctx.auth.credentials.revoke(JWT_METHOD, {
      requestId: request.requestId,
      signal: request.signal,
      target: family === undefined
        ? { kind: 'principal', principal: { kind: 'user', id: userId } }
        : { kind: 'token-family', tokenFamilyId: family },
    })
  }

  protected revokeUser(userId: UserId, requestId: AccountRegistrationInput['requestId'], signal: AbortSignal): Promise<void> {
    return this.ctx.auth.credentials.revoke(JWT_METHOD, {
      requestId,
      signal,
      target: { kind: 'principal', principal: { kind: 'user', id: userId } },
    })
  }

  protected operation(request: { requestId: unknown; signal: unknown }): void {
    if (typeof request.requestId !== 'string') {
      throw new AccountError('invalid-input', 'account: operation lifecycle is invalid')
    }
    try {
      authenticationRequestId(request.requestId)
    } catch {
      throw new AccountError('invalid-input', 'account: operation lifecycle is invalid')
    }
    if (!(request.signal instanceof AbortSignal)) throw new AccountError('invalid-input', 'account: operation lifecycle is invalid')
    if (request.signal.aborted) throw new AccountError('unauthenticated', 'account: operation was cancelled')
  }

  async [ADMIN_VALIDATE](call: AuthenticatedCall): Promise<void> {
    this.operation(call)
    await this.currentUser(call)
  }

  protected map(cause: unknown): AccountError {
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

  protected emit(kind: AccountChangeEvent['kind'], userId: UserId, requestId: AccountChangeEvent['requestId'], actorUserId?: UserId): void {
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

/** Explicit administrator capability guarded by one fail-closed authorizer. */
export class AccountAdministrationService extends Service {
  /** Sole administrator authorization Provider registry. */
  readonly authorizers: AccountAdminAuthorizerRegistry = new AccountAdminAuthorizerRegistry()

  /** @param ctx - Host context carrying account and authentication services. */
  constructor(ctx: Context) {
    super(ctx, 'accountAdministration')
  }

  /** Create an account after explicit administrator authorization.
   * @param request - actor and registration input.
   * @returns committed account record.
   */
  async adminCreate(request: AdminAccountCreateRequest): Promise<UserRecord> {
    await this.authorize(request.actor, 'create')
    return this.ctx.accounts[ADMIN_CREATE](request)
  }

  /** Update a target after explicit administrator authorization.
   * @param request - actor, target, revision, and patch.
   * @returns committed target record.
   */
  async adminUpdate(request: AdminAccountUpdateRequest): Promise<UserRecord> {
    await this.authorize(request.actor, 'update', request.userId)
    return this.ctx.accounts[ADMIN_UPDATE](request)
  }

  /** Disable a target after explicit administrator authorization.
   * @param request - actor, target, revision, and lifecycle.
   * @returns committed disabled target.
   */
  async adminDisable(request: AdminAccountStatusRequest): Promise<UserRecord> {
    await this.authorize(request.actor, 'disable', request.userId)
    return this.ctx.accounts[ADMIN_DISABLE](request)
  }

  /** Enable a target after explicit administrator authorization.
   * @param request - actor, target, revision, and lifecycle.
   * @returns committed active target.
   */
  async adminEnable(request: AdminAccountStatusRequest): Promise<UserRecord> {
    await this.authorize(request.actor, 'enable', request.userId)
    return this.ctx.accounts[ADMIN_ENABLE](request)
  }

  /** Reset a target password after explicit administrator authorization.
   * @param request - actor, target, revision, and new password.
   * @returns committed credential metadata.
   */
  async adminResetPassword(request: AdminPasswordResetRequest): Promise<UserCredentialRecord> {
    await this.authorize(request.actor, 'reset-password', request.userId)
    return this.ctx.accounts[ADMIN_RESET_PASSWORD](request)
  }

  /** Revoke target sessions after explicit administrator authorization.
   * @param request - actor, target, and lifecycle.
   */
  async adminRevokeSessions(request: AdminSessionRevokeRequest): Promise<void> {
    await this.authorize(request.actor, 'revoke-sessions', request.userId)
    return this.ctx.accounts[ADMIN_REVOKE_SESSIONS](request)
  }

  private async authorize(call: AuthenticatedCall, action: AccountAdminAction, target?: UserId): Promise<void> {
    await this.ctx.accounts[ADMIN_VALIDATE](call)
    await this.authorizers.authorize(call, action, target)
  }
}

export default AccountService
