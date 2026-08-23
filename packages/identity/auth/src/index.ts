/**
 * Authentication runtime for Provider selection, immutable request identity,
 * current-call checks, and optional credential lifecycle dispatch.
 * @module @deepseek-ai/dsh-auth
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  AuthenticatedCall,
  AuthenticatedPrincipal,
  AuthenticationAttempt,
  AuthenticationErrorCode,
  AuthenticationEventRecord,
  AuthenticationEvidenceKind,
  AuthenticationMethod,
  AuthenticationProvider,
  AuthenticationRequestId,
  CredentialId,
  AuthenticationCredentialInfo,
  CredentialInspectRequest,
  CredentialIssueRequest,
  CredentialLifecycleProvider,
  CredentialRefreshRequest,
  CredentialRevokeRequest,
  IssuedCredential,
  IssuedCredentialSet,
  LocalPrincipalId,
  ServiceAccountId,
  TokenFamilyId,
  UserId,
  VerifiedAuthentication,
} from './types.ts'

export type * from './types.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/

function validatedId(kind: string, value: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new TypeError(`auth: ${kind} must match ${String(ID_PATTERN)}`)
  }
  return value
}

/** Brand a Host-generated authentication request id after validation.
 * @param value - untrusted request id candidate.
 * @returns validated authentication request id.
 */
export function authenticationRequestId(value: string): AuthenticationRequestId {
  return validatedId('request id', value) as AuthenticationRequestId
}

/** Brand a human account id after validation.
 * @param value - untrusted user id candidate.
 * @returns validated user id.
 */
export function userId(value: string): UserId {
  return validatedId('user id', value) as UserId
}

/** Brand a service-account id after validation.
 * @param value - untrusted service-account id candidate.
 * @returns validated service-account id.
 */
export function serviceAccountId(value: string): ServiceAccountId {
  return validatedId('service-account id', value) as ServiceAccountId
}

/** Brand an explicit local principal id after validation.
 * @param value - untrusted local principal id candidate.
 * @returns validated local principal id.
 */
export function localPrincipalId(value: string): LocalPrincipalId {
  return validatedId('local principal id', value) as LocalPrincipalId
}

/** Brand an authentication method after validation.
 * @param value - untrusted method candidate.
 * @returns validated authentication method.
 */
export function authenticationMethod(value: string): AuthenticationMethod {
  return validatedId('authentication method', value) as AuthenticationMethod
}

/** Brand a credential id after validation.
 * @param value - untrusted credential id candidate.
 * @returns validated credential id.
 */
export function credentialId(value: string): CredentialId {
  return validatedId('credential id', value) as CredentialId
}

/** Brand a rotating token-family id after validation.
 * @param value - untrusted token-family id candidate.
 * @returns validated token-family id.
 */
export function tokenFamilyId(value: string): TokenFamilyId {
  return validatedId('token family id', value) as TokenFamilyId
}

/** Public authentication failure with a stable transport-safe category. */
export class AuthenticationError extends Error {
  /** Stable category safe for transport mapping. */
  readonly code: AuthenticationErrorCode

  /** Construct a failure without credential material. */
  constructor(code: AuthenticationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AuthenticationError'
    this.code = code
  }
}

interface ProviderRegistration {
  readonly evidenceKind: AuthenticationEvidenceKind
  readonly provider: AuthenticationProvider
  active: boolean
}

interface CallProvenance {
  readonly registration: ProviderRegistration
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === 'function'
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function normalizeIssued(result: unknown): IssuedCredentialSet {
  if (!isRecord(result) || !Array.isArray(result.credentials) || result.credentials.length === 0) {
    throw new AuthenticationError('authentication-unavailable', 'auth: credential Provider returned no credentials')
  }
  const seen = new Set<CredentialId>()
  const credentials = result.credentials.map((candidate: unknown): IssuedCredential => {
    if (!isRecord(candidate)
      || typeof candidate.value !== 'string' || candidate.value.length === 0
      || typeof candidate.id !== 'string') {
      throw new AuthenticationError('authentication-unavailable', 'auth: credential Provider returned invalid credentials')
    }
    const id = credentialId(candidate.id)
    const kind = candidate.kind
    const expiresAt = candidate.expiresAt
    const family = candidate.tokenFamilyId
    if (seen.has(id)
      || (kind !== 'access' && kind !== 'refresh' && kind !== 'api-key')
      || (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)))
      || (family !== undefined && typeof family !== 'string')) {
      throw new AuthenticationError('authentication-unavailable', 'auth: credential Provider returned invalid credentials')
    }
    const tokenFamily = family === undefined ? undefined : tokenFamilyId(family)
    seen.add(id)
    return Object.freeze({
      kind,
      id,
      value: candidate.value,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(tokenFamily === undefined ? {} : { tokenFamilyId: tokenFamily }),
    })
  })
  return Object.freeze({ credentials: Object.freeze(credentials) })
}

/** Registry of the sole active Provider for each evidence kind and method. */
export class AuthenticationProviderRegistry {
  private readonly byEvidence = new Map<AuthenticationEvidenceKind, ProviderRegistration>()
  private readonly byMethod = new Map<AuthenticationMethod, ProviderRegistration>()

  /**
   * Register one Provider. Provider plugins install the returned disposer in
   * their own `ctx.effect()` so registration follows the plugin fiber.
   * @param evidenceKind - exact carrier evidence handled by the Provider.
   * @param provider - verifier and optional credential lifecycle capabilities.
   * @returns idempotent disposer that invalidates calls issued by this registration.
   */
  register<K extends AuthenticationEvidenceKind>(
    evidenceKind: K,
    provider: AuthenticationProvider<K>,
  ): () => void {
    validatedId('evidence kind', evidenceKind)
    validatedId('authentication method', provider.method)
    if (this.byEvidence.has(evidenceKind)) {
      throw new AuthenticationError('provider-conflict', `auth: evidence kind "${evidenceKind}" already has a Provider`)
    }
    if (this.byMethod.has(provider.method)) {
      throw new AuthenticationError('provider-conflict', `auth: method "${provider.method}" already has a Provider`)
    }
    const registration: ProviderRegistration = {
      evidenceKind,
      provider,
      active: true,
    }
    this.byEvidence.set(evidenceKind, registration)
    this.byMethod.set(provider.method, registration)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      registration.active = false
      if (this.byEvidence.get(evidenceKind) === registration) this.byEvidence.delete(evidenceKind)
      if (this.byMethod.get(provider.method) === registration) this.byMethod.delete(provider.method)
    }
  }

  /** Resolve the Provider that owns one evidence kind.
   * @param evidenceKind - exact carrier evidence kind.
   * @returns current registration, when present.
   */
  resolveEvidence(evidenceKind: AuthenticationEvidenceKind): ProviderRegistration | undefined {
    return this.byEvidence.get(evidenceKind)
  }

  /** Resolve the Provider that owns one authentication method.
   * @param method - authentication method owned by a Provider.
   * @returns current registration, when present.
   */
  resolveMethod(method: AuthenticationMethod): ProviderRegistration | undefined {
    return this.byMethod.get(method)
  }

  /** Whether the exact registration remains active and current.
   * @param registration - registration provenance attached to a call.
   * @returns whether the registration still owns both registry entries.
   */
  isCurrent(registration: ProviderRegistration): boolean {
    return registration.active
      && this.byEvidence.get(registration.evidenceKind) === registration
      && this.byMethod.get(registration.provider.method) === registration
  }
}

/** Dispatch optional credential lifecycle operations to their owning Provider. */
export class CredentialLifecycleRuntime {
  /** @param runtime - authentication service that owns the Provider registry. */
  constructor(private readonly runtime: AuthenticationRuntime) {}

  /** Issue credentials through one method's Provider capability.
   * @param method - authentication method whose Provider owns issuance.
   * @param request - principal and operation lifecycle facts.
   * @returns validated issued credentials.
   */
  async issue(method: AuthenticationMethod, request: CredentialIssueRequest): Promise<IssuedCredentialSet> {
    return normalizeIssued(await this.capability(method, 'issue')(request))
  }

  /** Rotate a refresh credential through one method's Provider capability.
   * @param method - authentication method whose Provider owns rotation.
   * @param request - refresh secret and operation lifecycle facts.
   * @returns validated replacement credentials.
   */
  async refresh(method: AuthenticationMethod, request: CredentialRefreshRequest): Promise<IssuedCredentialSet> {
    return normalizeIssued(await this.capability(method, 'refresh')(request))
  }

  /** Inspect safe credential metadata through one method's Provider capability.
   * @param method - authentication method whose Provider owns inspection.
   * @param request - credential inspection target and lifecycle facts.
   * @returns immutable credential metadata without secrets.
   */
  async inspect(method: AuthenticationMethod, request: CredentialInspectRequest): Promise<readonly AuthenticationCredentialInfo[]> {
    const values = await this.capability(method, 'inspect')(request)
    return Object.freeze(values.map(value => Object.freeze({ ...value })))
  }

  /** Revoke credentials through one method's Provider capability.
   * @param method - authentication method whose Provider owns revocation.
   * @param request - revocation target and operation lifecycle facts.
   */
  async revoke(method: AuthenticationMethod, request: CredentialRevokeRequest): Promise<void> {
    await this.capability(method, 'revoke')(request)
  }

  private capability<K extends keyof CredentialLifecycleProvider>(
    method: AuthenticationMethod,
    operation: K,
  ): NonNullable<CredentialLifecycleProvider[K]> {
    const registration = this.runtime.providers.resolveMethod(method)
    const capability = registration?.provider.credentials?.[operation]
    if (registration === undefined || !registration.active || capability === undefined) {
      throw new AuthenticationError(
        'credential-operation-unsupported',
        `auth: method "${method}" does not support credential ${operation}`,
      )
    }
    return capability.bind(registration.provider.credentials) as NonNullable<CredentialLifecycleProvider[K]>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Active Host authentication runtime. */
    auth: AuthenticationRuntime
  }
}

/** Authentication service that selects Providers and exclusively mints calls. */
export class AuthenticationRuntime extends Service {
  /** Provider routes keyed by evidence kind and authentication method. */
  readonly providers: AuthenticationProviderRegistry = new AuthenticationProviderRegistry()
  /** Credential lifecycle dispatcher for registered Provider capabilities. */
  readonly credentials: CredentialLifecycleRuntime = new CredentialLifecycleRuntime(this)
  private readonly calls = new WeakMap<object, CallProvenance>()

  /** @param ctx - owning Host context. */
  constructor(ctx: Context) {
    super(ctx, 'auth')
  }

  /**
   * Verify carrier evidence through its sole Provider and mint an immutable call.
   * @param attempt - Host-owned request facts and untrusted carrier evidence.
   * @returns request identity accepted only by this live runtime.
   */
  async authenticate(attempt: AuthenticationAttempt): Promise<AuthenticatedCall> {
    const evidenceKind = attempt.evidence.kind
    const registration = this.providers.resolveEvidence(evidenceKind)
    if (isAborted(attempt.signal)) {
      return this.reject(attempt, evidenceKind, 'unauthenticated', 'auth: authentication request was cancelled')
    }
    if (registration === undefined) {
      return this.reject(attempt, evidenceKind, 'authentication-unavailable', 'auth: no Provider is registered for this credential')
    }

    let verified: VerifiedAuthentication
    try {
      verified = await registration.provider.verify(attempt)
    } catch (cause) {
      const error = cause instanceof AuthenticationError
        ? cause
        : new AuthenticationError('authentication-unavailable', 'auth: authentication Provider failed', { cause })
      this.emitResult({
        requestId: attempt.requestId,
        channel: attempt.channel,
        evidenceKind,
        method: registration.provider.method,
        outcome: 'failed',
        reason: error.code,
        time: Date.now(),
      })
      throw error
    }

    if (!this.providers.isCurrent(registration)) {
      return this.reject(attempt, evidenceKind, 'authentication-unavailable', 'auth: authentication Provider changed during verification')
    }
    if (isAborted(attempt.signal)) {
      return this.reject(attempt, evidenceKind, 'unauthenticated', 'auth: authentication request was cancelled')
    }
    try {
      this.assertVerified(verified)
      if (verified.expiresAt !== undefined && verified.expiresAt <= Date.now()) {
        return this.reject(attempt, evidenceKind, 'unauthenticated', 'auth: credential has expired')
      }
    } catch (cause) {
      if (cause instanceof AuthenticationError && cause.code === 'unauthenticated') throw cause
      const error = cause instanceof AuthenticationError
        ? cause
        : new AuthenticationError('authentication-unavailable', 'auth: authentication Provider returned invalid identity', { cause })
      this.emitResult({
        requestId: attempt.requestId,
        channel: attempt.channel,
        evidenceKind,
        method: registration.provider.method,
        outcome: 'failed',
        reason: error.code,
        time: Date.now(),
      })
      throw error
    }

    const principal = Object.freeze({ ...verified.principal }) as AuthenticatedPrincipal
    const call = Object.freeze({
      requestId: attempt.requestId,
      channel: attempt.channel,
      signal: attempt.signal,
      principal,
      method: registration.provider.method,
      authenticatedAt: verified.authenticatedAt,
      ...(verified.credentialId === undefined ? {} : { credentialId: verified.credentialId }),
      ...(verified.expiresAt === undefined ? {} : { expiresAt: verified.expiresAt }),
    }) as AuthenticatedCall
    this.calls.set(call, { registration })
    this.emitResult({
      requestId: call.requestId,
      channel: call.channel,
      evidenceKind,
      method: call.method,
      principal: call.principal,
      ...(call.credentialId === undefined ? {} : { credentialId: call.credentialId }),
      outcome: 'succeeded',
      time: Date.now(),
    })
    return call
  }

  /**
   * Require an exact call issued by this runtime whose request and Provider remain current.
   * @param value - candidate Host-only call.
   * @returns the same immutable call after validation.
   */
  assertCurrent(value: unknown): AuthenticatedCall {
    if ((typeof value !== 'object' || value === null)) {
      throw new AuthenticationError('unauthenticated', 'auth: call was not issued by this runtime')
    }
    const provenance = this.calls.get(value)
    if (provenance === undefined || !this.providers.isCurrent(provenance.registration)) {
      throw new AuthenticationError('unauthenticated', 'auth: call was not issued by a current Provider')
    }
    const call = value as AuthenticatedCall
    if (call.signal.aborted) {
      throw new AuthenticationError('unauthenticated', 'auth: call was cancelled')
    }
    if (call.expiresAt !== undefined && call.expiresAt <= Date.now()) {
      throw new AuthenticationError('unauthenticated', 'auth: call has expired')
    }
    return call
  }

  private assertVerified(verified: unknown): asserts verified is VerifiedAuthentication {
    if (!isRecord(verified)
      || typeof verified.authenticatedAt !== 'number' || !Number.isFinite(verified.authenticatedAt)
      || (verified.expiresAt !== undefined
        && (typeof verified.expiresAt !== 'number' || !Number.isFinite(verified.expiresAt)))) {
      throw new AuthenticationError('authentication-unavailable', 'auth: authentication Provider returned invalid timestamps')
    }
    const principal = verified.principal
    if (!isRecord(principal) || typeof principal.id !== 'string') {
      throw new AuthenticationError('authentication-unavailable', 'auth: authentication Provider returned an invalid principal')
    }
    if (principal.kind === 'user') userId(principal.id)
    else if (principal.kind === 'service-account') serviceAccountId(principal.id)
    else if (principal.kind === 'local') localPrincipalId(principal.id)
    else throw new AuthenticationError('authentication-unavailable', 'auth: authentication Provider returned an invalid principal')
    if (verified.credentialId !== undefined) {
      if (typeof verified.credentialId !== 'string') {
        throw new AuthenticationError('authentication-unavailable', 'auth: authentication Provider returned an invalid credential id')
      }
      credentialId(verified.credentialId)
    }
  }

  private reject(
    attempt: AuthenticationAttempt,
    evidenceKind: AuthenticationEvidenceKind,
    code: AuthenticationErrorCode,
    message: string,
  ): never {
    this.emitResult({
      requestId: attempt.requestId,
      channel: attempt.channel,
      evidenceKind,
      outcome: 'failed',
      reason: code,
      time: Date.now(),
    })
    throw new AuthenticationError(code, message)
  }

  private emitResult(record: AuthenticationEventRecord): void {
    const report = (error: unknown): void => {
      this.ctx.logger.warn('auth: an auth/result listener failed')
      this.ctx.logger.warn(error)
    }
    let invariantFailure: unknown
    for (const listener of this.ctx.events.dispatch('emit', ['auth/result', Object.freeze(record)])) {
      try {
        const returned: unknown = listener(record)
        if (isPromiseLike(returned)) {
          void Promise.resolve(returned).catch(report)
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') invariantFailure ??= error
        else report(error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }
}

export default AuthenticationRuntime
