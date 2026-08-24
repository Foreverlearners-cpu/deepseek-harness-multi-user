/**
 * Signed access and refresh JWT Provider over server-side refresh families.
 * @module @deepseek-ai/dsh-auth-jwt
 */

import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  AuthenticationError,
  authenticationMethod,
  credentialId,
  localPrincipalId,
  serviceAccountId,
  tokenFamilyId,
  userId,
  type AuthenticatedPrincipal,
  type AuthenticationCredentialInfo,
  type AuthenticationProvider,
  type CredentialLifecycleProvider,
  type IssuedCredentialSet,
} from '@deepseek-ai/dsh-auth'
import { AuthTokenError, type TokenFamilyIssueResult } from '@deepseek-ai/dsh-auth-token'
import { UserDirectoryError } from '@deepseek-ai/dsh-user'
import {
  SignJWT,
  decodeProtectedHeader,
  jwtVerify,
  type JWTPayload,
} from 'jose'
import type {
  JwtAuthenticationConfig,
  JwtSigningKeyConfig,
} from './types.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'auth-jwt'
/** Services required for verification, user status, and refresh-family state. */
export const inject = ['auth', 'authTokens', 'users']
/** Maximum UTF-8 bytes accepted for either JWT carrier. */
export const MAX_JWT_BYTES = 16_384
/** Fixed signing algorithm; callers cannot select it from token input. */
export const JWT_ALGORITHM = 'HS256'

const METHOD = authenticationMethod('jwt')
const ACCESS_TYPE = 'access'
const REFRESH_TYPE = 'refresh'
const DEFAULT_ACCESS_TTL_SECONDS = 900
const DEFAULT_REFRESH_TTL_SECONDS = 2_592_000
const MAX_ACCESS_TTL_SECONDS = 3_600
const MAX_REFRESH_TTL_SECONDS = 31_536_000
const MAX_CLOCK_TOLERANCE_SECONDS = 300
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

/** Runtime-validated JWT plugin configuration. */
export const Config = z.object({
  issuer: z.string().required(),
  audience: z.string().required(),
  accessTtlSeconds: z.number().min(1).max(MAX_ACCESS_TTL_SECONDS).default(DEFAULT_ACCESS_TTL_SECONDS),
  refreshTtlSeconds: z.number().min(1).max(MAX_REFRESH_TTL_SECONDS).default(DEFAULT_REFRESH_TTL_SECONDS),
  clockToleranceSeconds: z.number().min(0).max(MAX_CLOCK_TOLERANCE_SECONDS).default(0),
  activeKeyId: z.string().required(),
  keys: z.array(z.object({ keyId: z.string().required(), secret: z.string().required() })).required(),
}) as unknown as z<JwtAuthenticationConfig>

interface SigningKey {
  readonly keyId: string
  readonly secret: Uint8Array
}

interface JwtSpec {
  readonly issuer: string
  readonly audience: string
  readonly accessTtlSeconds: number
  readonly refreshTtlSeconds: number
  readonly clockToleranceSeconds: number
  readonly activeKey: SigningKey
  readonly keys: ReadonlyMap<string, SigningKey>
}

interface ParsedToken {
  readonly principal: AuthenticatedPrincipal
  readonly credentialId: ReturnType<typeof credentialId>
  readonly tokenFamilyId: ReturnType<typeof tokenFamilyId>
  readonly issuedAt: number
  readonly expiresAt: number
  readonly refreshSecret?: string
}

function invalidConfig(message: string): never {
  throw new TypeError(`auth-jwt: ${message}`)
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    invalidConfig(`${label} must be an integer from 1 to ${String(maximum)}`)
  }
  return resolved
}

function decodeKey(config: JwtSigningKeyConfig): SigningKey {
  if (!KEY_ID_PATTERN.test(config.keyId)) invalidConfig('key id is invalid')
  if (!BASE64URL_PATTERN.test(config.secret) || config.secret.length > 172) invalidConfig('key secret is invalid')
  const bytes = Buffer.from(config.secret, 'base64url')
  if (bytes.length < 32 || bytes.length > 128 || bytes.toString('base64url') !== config.secret) {
    invalidConfig('key secret must be canonical base64url for 32-128 bytes')
  }
  return Object.freeze({ keyId: config.keyId, secret: new Uint8Array(bytes) })
}

/** Resolve and validate configuration before registering or committing credentials.
 * @param config - raw Loader or programmatic configuration.
 * @returns immutable runtime parameters and decoded keyring.
 */
export function resolveSpec(config: JwtAuthenticationConfig): JwtSpec {
  const keyConfigs: readonly JwtSigningKeyConfig[] = config.keys
  if (typeof config.issuer !== 'string' || config.issuer.length === 0 || config.issuer.length > 512) {
    invalidConfig('issuer must contain 1-512 characters')
  }
  if (typeof config.audience !== 'string' || config.audience.length === 0 || config.audience.length > 256) {
    invalidConfig('audience must contain 1-256 characters')
  }
  if (!Number.isSafeInteger(config.clockToleranceSeconds ?? 0)
    || (config.clockToleranceSeconds ?? 0) < 0
    || (config.clockToleranceSeconds ?? 0) > MAX_CLOCK_TOLERANCE_SECONDS) {
    invalidConfig(`clock tolerance must be an integer from 0 to ${String(MAX_CLOCK_TOLERANCE_SECONDS)}`)
  }
  if (keyConfigs.length === 0 || keyConfigs.length > 16) {
    invalidConfig('keys must contain 1-16 entries')
  }
  const keys = new Map<string, SigningKey>()
  for (const candidate of keyConfigs) {
    const key = decodeKey(candidate)
    if (keys.has(key.keyId)) invalidConfig('key ids must be unique')
    keys.set(key.keyId, key)
  }
  if (!KEY_ID_PATTERN.test(config.activeKeyId) || !keys.has(config.activeKeyId)) {
    invalidConfig('active key id must select one configured key')
  }
  return Object.freeze({
    issuer: config.issuer,
    audience: config.audience,
    accessTtlSeconds: boundedInteger(
      config.accessTtlSeconds,
      DEFAULT_ACCESS_TTL_SECONDS,
      MAX_ACCESS_TTL_SECONDS,
      'access TTL',
    ),
    refreshTtlSeconds: boundedInteger(
      config.refreshTtlSeconds,
      DEFAULT_REFRESH_TTL_SECONDS,
      MAX_REFRESH_TTL_SECONDS,
      'refresh TTL',
    ),
    clockToleranceSeconds: config.clockToleranceSeconds ?? 0,
    activeKey: keys.get(config.activeKeyId) as SigningKey,
    keys,
  })
}

function unauthenticated(): AuthenticationError {
  return new AuthenticationError('unauthenticated', 'auth-jwt: credential was rejected')
}

function unavailable(cause?: unknown): AuthenticationError {
  return new AuthenticationError(
    'authentication-unavailable',
    'auth-jwt: authentication service is unavailable',
    cause === undefined ? undefined : { cause },
  )
}

function samePrincipal(left: AuthenticatedPrincipal, right: AuthenticatedPrincipal): boolean {
  return left.kind === right.kind && left.id === right.id
}

function principalFromClaims(payload: JWTPayload): AuthenticatedPrincipal {
  /* v8 ignore next -- jwtVerify requiredClaims rejects an absent subject before this typed projection */
  if (typeof payload.sub !== 'string') throw unauthenticated()
  switch (payload.pk) {
    case 'user': return { kind: 'user', id: userId(payload.sub) }
    case 'service-account': return { kind: 'service-account', id: serviceAccountId(payload.sub) }
    case 'local': return { kind: 'local', id: localPrincipalId(payload.sub) }
    default: throw unauthenticated()
  }
}

/** JWT Provider and credential lifecycle adapter registered by this plugin. */
export class JwtAuthenticationProvider implements AuthenticationProvider<'bearer'> {
  readonly method = METHOD
  readonly credentials: CredentialLifecycleProvider
  private readonly spec: JwtSpec

  /** @param ctx - context carrying token-family and user-directory services.
   * @param config - issuer, audience, lifetimes, and signing keyring.
   */
  constructor(private readonly ctx: Context, config: JwtAuthenticationConfig) {
    this.spec = resolveSpec(config)
    this.credentials = Object.freeze({
      issue: this.issue.bind(this),
      refresh: this.refresh.bind(this),
      inspect: this.inspect.bind(this),
      revoke: this.revoke.bind(this),
    })
  }

  /** Verify access bearer evidence and current server-side family/user state.
   * @param attempt - trusted request facts plus untrusted bearer JWT.
   * @returns principal and access credential facts.
   */
  async verify(attempt: Parameters<AuthenticationProvider<'bearer'>['verify']>[0]) {
    const parsed = await this.parse(attempt.evidence.token, ACCESS_TYPE)
    await this.assertFamilyActive(parsed, attempt.requestId, attempt.signal)
    await this.assertUserActive(parsed.principal)
    return {
      principal: parsed.principal,
      credentialId: parsed.credentialId,
      authenticatedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt,
    }
  }

  /** Sign a prepared JWT. Tests may override only to exercise compensation.
   * @param jwt - fully constructed token with fixed claims and protected header.
   * @param key - decoded active signing key.
   * @returns compact JWT serialization.
   */
  protected sign(jwt: SignJWT, key: Uint8Array): Promise<string> {
    return jwt.sign(key)
  }

  private activeKey(): SigningKey {
    return this.spec.activeKey
  }

  private async issue(request: Parameters<NonNullable<CredentialLifecycleProvider['issue']>>[0]): Promise<IssuedCredentialSet> {
    const key = this.activeKey()
    await this.assertUserActive(request.principal)
    const now = Date.now()
    const committed = await this.tokenOperation(() => this.ctx.authTokens.issueFamily({
      requestId: request.requestId,
      signal: request.signal,
      principal: request.principal,
      expiresAt: now + this.spec.refreshTtlSeconds * 1_000,
    }))
    return this.signCommitted(committed, key, request.requestId)
  }

  private async refresh(request: Parameters<NonNullable<CredentialLifecycleProvider['refresh']>>[0]): Promise<IssuedCredentialSet> {
    const parsed = await this.parse(request.refreshToken, REFRESH_TYPE)
    const key = this.activeKey()
    await this.assertUserActive(parsed.principal)
    const committed = await this.tokenOperation(() => this.ctx.authTokens.rotate({
      requestId: request.requestId,
      signal: request.signal,
      refreshToken: parsed.refreshSecret as string,
    }))
    if (committed.family.tokenFamilyId !== parsed.tokenFamilyId
      || !samePrincipal(committed.family.principal, parsed.principal)) {
      await this.compensate(committed, request.requestId, parsed.tokenFamilyId)
      throw unavailable()
    }
    return this.signCommitted(committed, key, request.requestId)
  }

  private async inspect(request: Parameters<NonNullable<CredentialLifecycleProvider['inspect']>>[0]): Promise<readonly AuthenticationCredentialInfo[]> {
    const inspection = await this.tokenOperation(() => this.ctx.authTokens.inspect(request))
    return Object.freeze(inspection.credentials.map(value => Object.freeze({
      id: value.credentialId,
      kind: 'refresh' as const,
      active: value.status === 'active' && value.expiresAt > Date.now(),
      expiresAt: value.expiresAt,
      tokenFamilyId: value.tokenFamilyId,
    })))
  }

  private async revoke(request: Parameters<NonNullable<CredentialLifecycleProvider['revoke']>>[0]): Promise<void> {
    await this.tokenOperation(() => this.ctx.authTokens.revoke(request))
  }

  private async signCommitted(
    committed: TokenFamilyIssueResult,
    key: SigningKey,
    requestId: Parameters<NonNullable<CredentialLifecycleProvider['issue']>>[0]['requestId'],
  ): Promise<IssuedCredentialSet> {
    try {
      const issuedAt = Math.floor(Date.now() / 1_000)
      const accessExpiresAt = issuedAt + this.spec.accessTtlSeconds
      const refreshExpiresAt = Math.floor(committed.refreshToken.expiresAt / 1_000)
      if (refreshExpiresAt <= issuedAt) throw unavailable()
      const accessId = credentialId(`access-${randomBytes(18).toString('base64url')}`)
      const access = await this.sign(this.jwt(
        ACCESS_TYPE,
        committed.family.principal,
        committed.family.tokenFamilyId,
        accessId,
        issuedAt,
        accessExpiresAt,
      ), key.secret)
      const refresh = await this.sign(this.jwt(
        REFRESH_TYPE,
        committed.family.principal,
        committed.family.tokenFamilyId,
        committed.refreshToken.credentialId,
        issuedAt,
        refreshExpiresAt,
        committed.refreshToken.value,
      ), key.secret)
      return Object.freeze({ credentials: Object.freeze([
        Object.freeze({
          kind: 'access' as const,
          id: accessId,
          value: access,
          expiresAt: accessExpiresAt * 1_000,
          tokenFamilyId: committed.family.tokenFamilyId,
        }),
        Object.freeze({
          kind: 'refresh' as const,
          id: committed.refreshToken.credentialId,
          value: refresh,
          expiresAt: committed.refreshToken.expiresAt,
          tokenFamilyId: committed.family.tokenFamilyId,
        }),
      ]) })
    } catch (cause) {
      await this.compensate(committed, requestId)
      throw unavailable(cause)
    }
  }

  private jwt(
    type: typeof ACCESS_TYPE | typeof REFRESH_TYPE,
    principal: AuthenticatedPrincipal,
    familyId: TokenFamilyIssueResult['family']['tokenFamilyId'],
    id: ReturnType<typeof credentialId>,
    issuedAt: number,
    expiresAt: number,
    refreshSecret?: string,
  ): SignJWT {
    return new SignJWT({ pk: principal.kind, sid: familyId, ...(refreshSecret === undefined ? {} : { rft: refreshSecret }) })
      .setProtectedHeader({ alg: JWT_ALGORITHM, kid: this.spec.activeKey.keyId, typ: type })
      .setIssuer(this.spec.issuer)
      .setAudience(this.spec.audience)
      .setSubject(principal.id)
      .setJti(id)
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt)
      .setExpirationTime(expiresAt)
  }

  private async parse(token: string, expectedType: typeof ACCESS_TYPE | typeof REFRESH_TYPE): Promise<ParsedToken> {
    if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') > MAX_JWT_BYTES || token.split('.').length !== 3) {
      throw unauthenticated()
    }
    try {
      const header = decodeProtectedHeader(token)
      if (header.alg !== JWT_ALGORITHM || header.typ !== expectedType || typeof header.kid !== 'string') {
        throw unauthenticated()
      }
      const key = this.spec.keys.get(header.kid)
      if (key === undefined) throw unauthenticated()
      const { payload } = await jwtVerify(token, key.secret, {
        algorithms: [JWT_ALGORITHM],
        issuer: this.spec.issuer,
        audience: this.spec.audience,
        typ: expectedType,
        clockTolerance: this.spec.clockToleranceSeconds,
        requiredClaims: ['iss', 'aud', 'sub', 'iat', 'nbf', 'exp', 'jti'],
      })
      if (payload.aud !== this.spec.audience
        || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.nbf)
        || !Number.isSafeInteger(payload.exp) || payload.nbf !== payload.iat
        || (payload.exp as number) <= (payload.iat as number)
        || (payload.exp as number) - (payload.iat as number) > (expectedType === ACCESS_TYPE
          ? this.spec.accessTtlSeconds
          : this.spec.refreshTtlSeconds)
        || typeof payload.jti !== 'string' || typeof payload.sid !== 'string'
        || (expectedType === REFRESH_TYPE ? typeof payload.rft !== 'string' : payload.rft !== undefined)) {
        throw unauthenticated()
      }
      const parsed = Object.freeze({
        principal: principalFromClaims(payload),
        credentialId: credentialId(payload.jti),
        tokenFamilyId: tokenFamilyId(payload.sid),
        issuedAt: (payload.iat as number) * 1_000,
        expiresAt: (payload.exp as number) * 1_000,
        ...(typeof payload.rft === 'string' ? { refreshSecret: payload.rft } : {}),
      })
      return parsed
    } catch (cause) {
      if (cause instanceof AuthenticationError) throw cause
      throw unauthenticated()
    }
  }

  private async assertFamilyActive(
    parsed: ParsedToken,
    requestId: Parameters<Context['authTokens']['inspect']>[0]['requestId'],
    signal: AbortSignal,
  ): Promise<void> {
    const inspection = await this.tokenOperation(() => this.ctx.authTokens.inspect({
      requestId,
      signal,
      target: { kind: 'token-family', tokenFamilyId: parsed.tokenFamilyId },
    }))
    const family = inspection.families.at(0)
    if (family === undefined || inspection.families.length !== 1 || family.status !== 'active'
      || family.expiresAt <= Date.now() || !samePrincipal(family.principal, parsed.principal)) {
      throw unauthenticated()
    }
  }

  private async assertUserActive(principal: AuthenticatedPrincipal): Promise<void> {
    if (principal.kind !== 'user') return
    try {
      await this.ctx.users.requireActive(principal.id)
    } catch (cause) {
      if (cause instanceof UserDirectoryError && cause.code === 'provider-unavailable') throw unavailable(cause)
      throw unauthenticated()
    }
  }

  private async compensate(
    committed: TokenFamilyIssueResult,
    requestId: Parameters<NonNullable<CredentialLifecycleProvider['issue']>>[0]['requestId'],
    familyId = committed.family.tokenFamilyId,
  ): Promise<void> {
    try {
      await this.ctx.authTokens.revoke({
        requestId,
        signal: new AbortController().signal,
        target: { kind: 'token-family', tokenFamilyId: familyId },
      })
    } catch (cause) {
      throw unavailable(cause)
    }
  }

  private async tokenOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (cause) {
      if (cause instanceof AuthenticationError) throw cause
      if (cause instanceof AuthTokenError && cause.code !== 'provider-unavailable') throw unauthenticated()
      throw unavailable(cause)
    }
  }
}

/** Create one configured JWT Provider.
 * @param ctx - context carrying token-family and user-directory services.
 * @param config - issuer, audience, lifetimes, and keyring.
 * @returns Provider for bearer verification and JWT credential lifecycle.
 */
export function createJwtAuthenticationProvider(
  ctx: Context,
  config: JwtAuthenticationConfig,
): JwtAuthenticationProvider {
  return new JwtAuthenticationProvider(ctx, config)
}

/** Register bearer verification and JWT credential lifecycle operations.
 * @param ctx - context carrying authentication, token-family, and user services.
 * @param config - validated JWT deployment configuration.
 */
export function apply(ctx: Context, config: JwtAuthenticationConfig): void {
  const provider = createJwtAuthenticationProvider(ctx, config)
  ctx.effect(() => ctx.auth.providers.register('bearer', provider))
}

export default apply
