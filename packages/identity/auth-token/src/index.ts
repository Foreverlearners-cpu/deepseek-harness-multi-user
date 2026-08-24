/**
 * Opaque refresh-token family lifecycle with atomic Provider operations.
 * @module @deepseek-ai/dsh-auth-token
 */

import { createHash, randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  authenticationRequestId,
  credentialId,
  localPrincipalId,
  serviceAccountId,
  tokenFamilyId,
  userId,
} from '@deepseek-ai/dsh-auth'
import type {
  AuthenticatedPrincipal,
  AuthTokenChangeEvent,
  AuthTokenErrorCode,
  AuthTokenInspectRequest,
  AuthTokenInspection,
  AuthTokenRevokeRequest,
  CredentialId,
  IssuedRefreshToken,
  RefreshCredentialInfo,
  RefreshCredentialRecord,
  RefreshTokenDigest,
  RefreshTokenRotateRequest,
  RefreshTokenRotationCommit,
  TokenFamilyCreateInput,
  TokenFamilyInfo,
  TokenFamilyIssueRequest,
  TokenFamilyIssueResult,
  TokenFamilyMutationCommit,
  TokenFamilyRecord,
  TokenRevocationCommit,
  TokenRevocationInput,
} from './types.ts'

export type * from './types.ts'

/** Minimum entropy in a generated opaque refresh-token secret. */
export const REFRESH_TOKEN_ENTROPY_BYTES = 32
/** Prefix that distinguishes refresh tokens from unrelated bearer strings. */
export const REFRESH_TOKEN_PREFIX = 'dsh_rt_'
/** Maximum UTF-8 bytes accepted for one submitted refresh token. */
export const MAX_REFRESH_TOKEN_BYTES = 4_096
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

/** Public token lifecycle failure with a stable transport-safe category. */
export class AuthTokenError extends Error {
  /** Stable category safe for transport mapping. */
  readonly code: AuthTokenErrorCode

  /** Construct a failure without refresh-token material. */
  constructor(code: AuthTokenErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AuthTokenError'
    this.code = code
  }
}

function unavailable(message: string): AuthTokenError {
  return new AuthTokenError('provider-unavailable', `auth-token: ${message}`)
}

function invalid(message: string): AuthTokenError {
  return new AuthTokenError('invalid-input', `auth-token: ${message}`)
}

function integerTime(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw unavailable(`Provider returned an invalid ${label}`)
  return value as number
}

function requestTime(value: number, now: number): number {
  if (!Number.isSafeInteger(value) || value <= now) throw invalid('expiry must be a future integer timestamp')
  return value
}

function principalSnapshot(value: unknown): AuthenticatedPrincipal {
  if (typeof value !== 'object' || value === null) throw unavailable('Provider returned an invalid principal')
  const candidate = value as { kind?: unknown; id?: unknown }
  if (typeof candidate.id !== 'string') throw unavailable('Provider returned an invalid principal')
  try {
    switch (candidate.kind) {
      case 'user': return Object.freeze({ kind: 'user', id: userId(candidate.id) })
      case 'service-account': return Object.freeze({ kind: 'service-account', id: serviceAccountId(candidate.id) })
      case 'local': return Object.freeze({ kind: 'local', id: localPrincipalId(candidate.id) })
      default: throw unavailable('Provider returned an invalid principal')
    }
  } catch (cause) {
    if (cause instanceof AuthTokenError) throw cause
    throw unavailable('Provider returned an invalid principal')
  }
}

function requestPrincipal(value: AuthenticatedPrincipal): AuthenticatedPrincipal {
  try {
    switch (value.kind) {
      case 'user': return Object.freeze({ kind: 'user', id: userId(value.id) })
      case 'service-account': return Object.freeze({ kind: 'service-account', id: serviceAccountId(value.id) })
      case 'local': return Object.freeze({ kind: 'local', id: localPrincipalId(value.id) })
    }
  } catch (_cause) {
    throw invalid('principal is invalid')
  }
}

function familySnapshot(value: unknown): TokenFamilyRecord {
  if (typeof value !== 'object' || value === null) throw unavailable('Provider returned an invalid token family')
  const candidate = value as Partial<TokenFamilyRecord>
  if (typeof candidate.tokenFamilyId !== 'string'
    || (candidate.status !== 'active' && candidate.status !== 'revoked')
    || !Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 1) {
    throw unavailable('Provider returned an invalid token family')
  }
  let id
  try {
    id = tokenFamilyId(candidate.tokenFamilyId)
  } catch {
    throw unavailable('Provider returned an invalid token family')
  }
  const principal = principalSnapshot(candidate.principal)
  const revision = candidate.revision as number
  const createdAt = integerTime(candidate.createdAt, 'token family')
  const updatedAt = integerTime(candidate.updatedAt, 'token family')
  const expiresAt = integerTime(candidate.expiresAt, 'token family')
  if (updatedAt < createdAt || expiresAt <= createdAt) throw unavailable('Provider returned an invalid token family')
  if (candidate.status === 'active') {
    if (candidate.revokedAt !== undefined || candidate.revocationReason !== undefined) {
      throw unavailable('Provider returned an invalid active token family')
    }
    return Object.freeze({
      tokenFamilyId: id,
      principal,
      status: 'active',
      createdAt,
      updatedAt,
      expiresAt,
      revision,
    })
  }
  if (!Number.isSafeInteger(candidate.revokedAt)
    || (candidate.revokedAt as number) < updatedAt
    || (candidate.revocationReason !== 'requested' && candidate.revocationReason !== 'refresh-token-reuse')) {
    throw unavailable('Provider returned an invalid revoked token family')
  }
  const revokedAt = candidate.revokedAt as number
  return Object.freeze({
    tokenFamilyId: id,
    principal,
    status: 'revoked',
    createdAt,
    updatedAt,
    expiresAt,
    revision,
    revokedAt,
    revocationReason: candidate.revocationReason,
  })
}

function credentialSnapshot(value: unknown): RefreshCredentialRecord {
  if (typeof value !== 'object' || value === null) throw unavailable('Provider returned an invalid refresh credential')
  const candidate = value as Partial<RefreshCredentialRecord>
  if (typeof candidate.credentialId !== 'string'
    || typeof candidate.tokenFamilyId !== 'string'
    || typeof candidate.digest !== 'string' || !DIGEST_PATTERN.test(candidate.digest)
    || (candidate.status !== 'active' && candidate.status !== 'rotated' && candidate.status !== 'revoked')) {
    throw unavailable('Provider returned an invalid refresh credential')
  }
  let id
  let familyId
  try {
    id = credentialId(candidate.credentialId)
    familyId = tokenFamilyId(candidate.tokenFamilyId)
  } catch {
    throw unavailable('Provider returned an invalid refresh credential')
  }
  const issuedAt = integerTime(candidate.issuedAt, 'refresh credential')
  const expiresAt = integerTime(candidate.expiresAt, 'refresh credential')
  if (expiresAt <= issuedAt) throw unavailable('Provider returned an invalid refresh credential')
  const common = {
    credentialId: id,
    tokenFamilyId: familyId,
    digest: candidate.digest,
    issuedAt,
    expiresAt,
  }
  if (candidate.status === 'active') {
    if (candidate.rotatedAt !== undefined || candidate.replacedBy !== undefined || candidate.revokedAt !== undefined) {
      throw unavailable('Provider returned an invalid active refresh credential')
    }
    return Object.freeze({ ...common, status: 'active' })
  }
  if (candidate.status === 'rotated') {
    if (!Number.isSafeInteger(candidate.rotatedAt) || (candidate.rotatedAt as number) < issuedAt
      || typeof candidate.replacedBy !== 'string' || candidate.revokedAt !== undefined) {
      throw unavailable('Provider returned an invalid rotated refresh credential')
    }
    let replacedBy
    try {
      replacedBy = credentialId(candidate.replacedBy)
    } catch {
      throw unavailable('Provider returned an invalid rotated refresh credential')
    }
    const rotatedAt = candidate.rotatedAt as number
    return Object.freeze({
      ...common,
      status: 'rotated',
      rotatedAt,
      replacedBy,
    })
  }
  if (!Number.isSafeInteger(candidate.revokedAt) || (candidate.revokedAt as number) < issuedAt
    || candidate.rotatedAt !== undefined || candidate.replacedBy !== undefined) {
    throw unavailable('Provider returned an invalid revoked refresh credential')
  }
  const revokedAt = candidate.revokedAt as number
  return Object.freeze({ ...common, status: 'revoked', revokedAt })
}

function familyInfo(record: TokenFamilyRecord): TokenFamilyInfo {
  const { tokenFamilyId: id, principal, status, createdAt, updatedAt, expiresAt, revision } = record
  return Object.freeze({
    tokenFamilyId: id,
    principal,
    status,
    createdAt,
    updatedAt,
    expiresAt,
    revision,
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
    ...(record.revocationReason === undefined ? {} : { revocationReason: record.revocationReason }),
  })
}

function credentialInfo(record: RefreshCredentialRecord): RefreshCredentialInfo {
  return Object.freeze({
    credentialId: record.credentialId,
    tokenFamilyId: record.tokenFamilyId,
    status: record.status,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    ...(record.rotatedAt === undefined ? {} : { rotatedAt: record.rotatedAt }),
    ...(record.replacedBy === undefined ? {} : { replacedBy: record.replacedBy }),
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  })
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Active Host token-family lifecycle Provider. */
    authTokens: AuthTokenService
  }
}

/**
 * Abstract opaque refresh-token lifecycle. Providers own durable state and
 * atomic commits; this base owns secrets, digests, validation, and events.
 */
export abstract class AuthTokenService extends Service {
  /** @param ctx - owning Host context. */
  constructor(ctx: Context) {
    super(ctx, 'authTokens')
  }

  /**
   * Atomically create one family and its first opaque refresh credential.
   * @param request - authenticated principal, absolute expiry, and operation lifecycle.
   * @returns committed safe family metadata and the only copy of the refresh secret.
   */
  async issueFamily(request: TokenFamilyIssueRequest): Promise<TokenFamilyIssueResult> {
    this.operation(request)
    const now = this.now()
    const expiresAt = requestTime(request.expiresAt, now)
    const principal = requestPrincipal(request.principal)
    const secret = this.generateRefreshSecret()
    const familyId = tokenFamilyId(this.generateId('family'))
    const refreshId = credentialId(this.generateId('refresh'))
    const input: TokenFamilyCreateInput = Object.freeze({
      family: Object.freeze({
        tokenFamilyId: familyId,
        principal,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        expiresAt,
        revision: 1,
      }),
      credential: Object.freeze({
        credentialId: refreshId,
        tokenFamilyId: familyId,
        digest: this.digest(secret),
        status: 'active',
        issuedAt: now,
        expiresAt,
      }),
    })
    const committed = await this.provider(() => this.createFamilyRecord(input))
    const family = familySnapshot(committed.family)
    const credential = credentialSnapshot(committed.credential)
    if (!isDeepStrictEqual(family, input.family) || !isDeepStrictEqual(credential, input.credential)) {
      throw unavailable('Provider created an inconsistent token family')
    }
    const result = this.issueResult(family, credential, secret)
    this.emitChange(this.event('issued', request.requestId, family, credential.credentialId))
    return result
  }

  /**
   * Atomically consume one refresh token and replace it exactly once.
   * Reuse revokes the entire family before the method rejects.
   * @param request - current refresh secret and operation lifecycle.
   * @returns committed family metadata and a replacement refresh secret.
   */
  async rotate(request: RefreshTokenRotateRequest): Promise<TokenFamilyIssueResult> {
    this.operation(request)
    if (typeof request.refreshToken !== 'string'
      || !request.refreshToken.startsWith(REFRESH_TOKEN_PREFIX)
      || Buffer.byteLength(request.refreshToken, 'utf8') > MAX_REFRESH_TOKEN_BYTES) {
      throw new AuthTokenError('refresh-token-invalid', 'auth-token: refresh token is invalid')
    }
    const now = this.now()
    const replacementSecret = this.generateRefreshSecret()
    const input = Object.freeze({
      digest: this.digest(request.refreshToken),
      replacementCredentialId: credentialId(this.generateId('refresh')),
      replacementDigest: this.digest(replacementSecret),
      time: now,
    })
    const commit = await this.provider(() => this.rotateFamilyRecord(input))
    if (commit.kind === 'reused') {
      const previous = familySnapshot(commit.previousFamily)
      const current = familySnapshot(commit.currentFamily)
      const reused = credentialSnapshot(commit.reusedCredential)
      this.assertReuseCommit(previous, current, reused, input)
      this.emitChange(this.event('reuse-detected', request.requestId, current, reused.credentialId))
      throw new AuthTokenError('refresh-token-reused', 'auth-token: refresh token reuse revoked its family')
    }
    const previousFamily = familySnapshot(commit.previousFamily)
    const currentFamily = familySnapshot(commit.currentFamily)
    const consumedCredential = credentialSnapshot(commit.consumedCredential)
    const replacementCredential = credentialSnapshot(commit.replacementCredential)
    this.assertRotationCommit(previousFamily, currentFamily, consumedCredential, replacementCredential, input)
    const result = this.issueResult(currentFamily, replacementCredential, replacementSecret)
    this.emitChange(this.event('rotated', request.requestId, currentFamily, replacementCredential.credentialId))
    return result
  }

  /**
   * Inspect safe family and refresh-credential metadata.
   * @param request - credential, family, or principal target and operation lifecycle.
   * @returns immutable metadata without refresh secrets or digests.
   */
  async inspect(request: AuthTokenInspectRequest): Promise<AuthTokenInspection> {
    this.operation(request)
    const result = await this.provider(() => this.inspectRecords(request.target))
    const families = result.families.map(familySnapshot)
    const credentials = result.credentials.map(credentialSnapshot)
    const familyIds = new Set(families.map(value => value.tokenFamilyId))
    if (familyIds.size !== families.length
      || new Set(credentials.map(value => value.credentialId)).size !== credentials.length
      || credentials.some(value => !familyIds.has(value.tokenFamilyId))) {
      throw unavailable('Provider returned an inconsistent inspection')
    }
    this.assertTarget(request.target, families, credentials)
    return Object.freeze({
      families: Object.freeze(families.map(familyInfo)),
      credentials: Object.freeze(credentials.map(credentialInfo)),
    })
  }

  /**
   * Idempotently revoke the family selected by a credential or family target,
   * or every active family belonging to one principal.
   * @param request - revocation target and operation lifecycle.
   */
  async revoke(request: AuthTokenRevokeRequest): Promise<void> {
    this.operation(request)
    const input: TokenRevocationInput = Object.freeze({ target: request.target, time: this.now(), reason: 'requested' })
    const commit = await this.provider(() => this.revokeRecords(input))
    const matchedCredential = commit.matchedCredential === undefined
      ? undefined
      : credentialSnapshot(commit.matchedCredential)
    const seen = new Set<string>()
    const families: TokenFamilyRecord[] = []
    const changes: { previous: TokenFamilyRecord; current: TokenFamilyRecord }[] = []
    for (const candidate of commit.families) {
      const { previous, current } = this.revocationCommit(candidate, input)
      if (seen.has(current.tokenFamilyId)) throw unavailable('Provider returned duplicate revocation commits')
      seen.add(current.tokenFamilyId)
      families.push(current)
      changes.push({ previous, current })
    }
    this.assertRevocationTarget(request.target, families, matchedCredential)
    for (const { previous, current } of changes) {
      if (previous.status === 'active') this.emitChange(this.event('revoked', request.requestId, current))
    }
  }

  /** Persist one exact initial family and credential atomically. */
  protected abstract createFamilyRecord(input: TokenFamilyCreateInput): Promise<TokenFamilyCreateInput>
  /** Consume one digest and replace it, or revoke its family on reuse, atomically. */
  protected abstract rotateFamilyRecord(input: Readonly<{
    digest: RefreshTokenDigest
    replacementCredentialId: CredentialId
    replacementDigest: RefreshTokenDigest
    time: number
  }>): Promise<RefreshTokenRotationCommit>
  /** Read complete safe-inspection source records for one target. */
  protected abstract inspectRecords(target: AuthTokenInspectRequest['target']): Promise<Readonly<{
    families: readonly TokenFamilyRecord[]
    credentials: readonly RefreshCredentialRecord[]
  }>>
  /** Revoke matching active families and credentials atomically. */
  protected abstract revokeRecords(input: TokenRevocationInput): Promise<TokenRevocationCommit>

  /** Current integer timestamp; Providers may override only for deterministic tests. */
  protected now(): number {
    return Date.now()
  }

  /** Generate a validated opaque id; Providers may override only for deterministic tests. */
  protected generateId(kind: 'family' | 'refresh'): string {
    return `${kind}-${randomBytes(18).toString('base64url')}`
  }

  /** Generate the short-lived refresh secret returned to the Consumer. */
  protected generateRefreshSecret(): string {
    return `${REFRESH_TOKEN_PREFIX}${randomBytes(REFRESH_TOKEN_ENTROPY_BYTES).toString('base64url')}`
  }

  private operation(request: { requestId: string; signal: AbortSignal }): void {
    try {
      authenticationRequestId(request.requestId)
    } catch {
      throw invalid('request id is invalid')
    }
    if (!(request.signal instanceof AbortSignal)) throw invalid('signal is invalid')
    if (request.signal.aborted) throw new AuthTokenError('operation-cancelled', 'auth-token: operation was cancelled')
  }

  private digest(secret: string): RefreshTokenDigest {
    return createHash('sha256').update(secret, 'utf8').digest('hex') as RefreshTokenDigest
  }

  private async provider<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (cause) {
      if (cause instanceof AuthTokenError) throw cause
      throw new AuthTokenError('provider-unavailable', 'auth-token: lifecycle Provider failed', { cause })
    }
  }

  private issueResult(
    family: TokenFamilyRecord,
    credential: RefreshCredentialRecord,
    secret: string,
  ): TokenFamilyIssueResult {
    const refreshToken: IssuedRefreshToken = Object.freeze({
      credentialId: credential.credentialId,
      tokenFamilyId: family.tokenFamilyId,
      value: secret,
      expiresAt: credential.expiresAt,
    })
    return Object.freeze({ family: familyInfo(family), refreshToken })
  }

  private assertRotationCommit(
    previousFamily: TokenFamilyRecord,
    currentFamily: TokenFamilyRecord,
    consumedCredential: RefreshCredentialRecord,
    replacementCredential: RefreshCredentialRecord,
    input: Readonly<{
      digest: RefreshTokenDigest
      replacementCredentialId: CredentialId
      replacementDigest: RefreshTokenDigest
      time: number
    }>,
  ): void {
    const expectedFamily = { ...previousFamily, updatedAt: input.time, revision: previousFamily.revision + 1 }
    const expectedReplacement: RefreshCredentialRecord = {
      credentialId: input.replacementCredentialId,
      tokenFamilyId: previousFamily.tokenFamilyId,
      digest: input.replacementDigest,
      status: 'active',
      issuedAt: input.time,
      expiresAt: previousFamily.expiresAt,
    }
    if (previousFamily.status !== 'active' || previousFamily.expiresAt <= input.time
      || consumedCredential.expiresAt <= input.time
      || consumedCredential.status !== 'rotated' || consumedCredential.digest !== input.digest
      || consumedCredential.tokenFamilyId !== previousFamily.tokenFamilyId
      || consumedCredential.rotatedAt !== input.time || consumedCredential.replacedBy !== input.replacementCredentialId
      || !isDeepStrictEqual(currentFamily, expectedFamily)
      || !isDeepStrictEqual(replacementCredential, expectedReplacement)) {
      throw unavailable('Provider returned an inconsistent rotation commit')
    }
  }

  private assertReuseCommit(
    previous: TokenFamilyRecord,
    current: TokenFamilyRecord,
    credential: RefreshCredentialRecord,
    input: Readonly<{ digest: RefreshTokenDigest; time: number }>,
  ): void {
    const expected = {
      ...previous,
      status: 'revoked' as const,
      updatedAt: input.time,
      revision: previous.revision + 1,
      revokedAt: input.time,
      revocationReason: 'refresh-token-reuse' as const,
    }
    if (previous.status !== 'active' || previous.expiresAt <= input.time
      || credential.status !== 'rotated' || credential.expiresAt <= input.time || credential.digest !== input.digest
      || credential.tokenFamilyId !== previous.tokenFamilyId || !isDeepStrictEqual(current, expected)) {
      throw unavailable('Provider returned an inconsistent reuse commit')
    }
  }

  private revocationCommit(
    commit: TokenFamilyMutationCommit,
    input: TokenRevocationInput,
  ): { previous: TokenFamilyRecord; current: TokenFamilyRecord } {
    const previous = familySnapshot(commit.previous)
    const current = familySnapshot(commit.current)
    const expected = previous.status === 'active'
      ? {
        ...previous,
        status: 'revoked' as const,
        updatedAt: input.time,
        revision: previous.revision + 1,
        revokedAt: input.time,
        revocationReason: 'requested' as const,
      }
      : previous
    if (!isDeepStrictEqual(current, expected)) throw unavailable('Provider returned an inconsistent revocation commit')
    return { previous, current }
  }

  private assertTarget(
    target: AuthTokenInspectRequest['target'],
    families: readonly TokenFamilyRecord[],
    credentials: readonly RefreshCredentialRecord[],
  ): void {
    if (target.kind === 'token-family') {
      if (families.length > 1 || families.some(value => value.tokenFamilyId !== target.tokenFamilyId)) {
        throw unavailable('Provider inspection did not match its family target')
      }
      return
    }
    if (target.kind === 'principal') {
      if (families.some(value => !isDeepStrictEqual(value.principal, target.principal))) {
        throw unavailable('Provider inspection did not match its principal target')
      }
      return
    }
    if (families.length > 1
      || credentials.filter(value => value.credentialId === target.credentialId).length !== families.length) {
      throw unavailable('Provider inspection did not prove its credential target')
    }
  }

  private assertRevocationTarget(
    target: AuthTokenRevokeRequest['target'],
    families: readonly TokenFamilyRecord[],
    matchedCredential: RefreshCredentialRecord | undefined,
  ): void {
    if (target.kind === 'token-family') {
      if (matchedCredential !== undefined || families.length > 1
        || families.some(value => value.tokenFamilyId !== target.tokenFamilyId)) {
        throw unavailable('Provider revocation did not match its family target')
      }
      return
    }
    if (target.kind === 'principal') {
      if (matchedCredential !== undefined
        || families.some(value => !isDeepStrictEqual(value.principal, target.principal))) {
        throw unavailable('Provider revocation did not match its principal target')
      }
      return
    }
    if (families.length === 0) {
      if (matchedCredential !== undefined) throw unavailable('Provider revocation returned an orphan credential proof')
      return
    }
    const returnedFamily = families[0]
    if (families.length !== 1 || matchedCredential?.credentialId !== target.credentialId
      || matchedCredential.tokenFamilyId !== returnedFamily?.tokenFamilyId) {
      throw unavailable('Provider revocation did not prove its credential target')
    }
  }

  private event(
    kind: AuthTokenChangeEvent['kind'],
    requestId: AuthTokenChangeEvent['requestId'],
    family: TokenFamilyRecord,
    credential?: CredentialId,
  ): AuthTokenChangeEvent {
    return Object.freeze({
      kind,
      requestId,
      tokenFamilyId: family.tokenFamilyId,
      principal: family.principal,
      status: family.status,
      revision: family.revision,
      time: family.updatedAt,
      ...(credential === undefined ? {} : { credentialId: credential }),
      ...(family.revocationReason === undefined ? {} : { reason: family.revocationReason }),
    })
  }

  private emitChange(event: AuthTokenChangeEvent): void {
    const report = (error: unknown): void => {
      this.ctx.logger.warn('auth-token: an auth-token/changed listener failed')
      this.ctx.logger.warn(error)
    }
    for (const listener of this.ctx.events.dispatch('emit', ['auth-token/changed', event])) {
      try {
        const returned: unknown = listener(event)
        if (isPromiseLike(returned)) void Promise.resolve(returned).catch(report)
      } catch (error) {
        report(error)
      }
    }
  }
}

export default AuthTokenService
