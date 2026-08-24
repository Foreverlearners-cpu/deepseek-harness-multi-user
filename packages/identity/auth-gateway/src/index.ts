/**
 * Transport-neutral authentication entry points for trusted HTTP and WebSocket adapters.
 * @module @deepseek-ai/dsh-auth-gateway
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AccountError } from '@deepseek-ai/dsh-account'
import { AuthenticationError, authenticationRequestId, type AuthenticatedCall, type IssuedCredentialSet } from '@deepseek-ai/dsh-auth'
import type {} from '@deepseek-ai/dsh-auth-jwt/types'
import type { UserRecord } from '@deepseek-ai/dsh-user/types'
import type {
  AuthGatewayConfig,
  AuthGatewayErrorCode,
  GatewayCookie,
  GatewayCookieDirective,
  GatewayHeader,
  GatewayHttpAuthenticationRequest,
  GatewayLoginRequest,
  GatewayLogoutResult,
  GatewayQueryEntry,
  GatewayRegistrationRequest,
  GatewayRequest,
  GatewaySessionResult,
  GatewayWebSocketAuthenticationRequest,
} from './types.ts'

export type * from './types.ts'

const DEFAULT_REFRESH_COOKIE = '__Secure-dsh_refresh'
const DEFAULT_ACCESS_COOKIE = '__Host-dsh_access'
const DEFAULT_CSRF_COOKIE = '__Secure-dsh_csrf'
const DEFAULT_CSRF_HEADER = 'x-dsh-csrf'
const DEFAULT_REFRESH_PATH = '/auth/refresh'
const MAX_ENTRIES = 64
const MAX_NAME_BYTES = 128
const MAX_VALUE_BYTES = 16_384
const MAX_PASSWORD_BYTES = 4_096
const MAX_CSRF_BYTES = 256
const ACCESS_QUERY = 'access_token'
const REFRESH_QUERY = 'refresh_token'
const PASSWORD_QUERY = 'password'
const SUBPROTOCOL_PREFIX = 'dsh-auth-bearer.'

interface ResolvedSpec {
  readonly refreshCookieName: string
  readonly accessCookieName: string
  readonly csrfCookieName: string
  readonly csrfHeaderName: string
  readonly refreshCookiePath: string
  readonly allowedOrigins: ReadonlySet<string>
  readonly allowWebSocketQueryAccessToken: boolean
}

/** Cordis configuration schema. */
export const Config = z.object({
  refreshCookieName: z.string().default(DEFAULT_REFRESH_COOKIE),
  accessCookieName: z.string().default(DEFAULT_ACCESS_COOKIE),
  csrfCookieName: z.string().default(DEFAULT_CSRF_COOKIE),
  csrfHeaderName: z.string().default(DEFAULT_CSRF_HEADER),
  refreshCookiePath: z.string().default(DEFAULT_REFRESH_PATH),
  allowedOrigins: z.array(z.string()).default([]),
  allowWebSocketQueryAccessToken: z.boolean().default(false),
}) as unknown as z<AuthGatewayConfig>

/** Transport-safe gateway failure without an underlying cause or secret. */
export class AuthGatewayError extends Error {
  /** Stable machine-readable category. */
  readonly code: AuthGatewayErrorCode
  /** Suggested HTTP status for an adapter. */
  readonly status: 400 | 401 | 403 | 409 | 503

  /** @param code - stable public category.
   * @param status - HTTP status mapping.
   */
  constructor(code: AuthGatewayErrorCode, status: AuthGatewayError['status']) {
    super(`auth-gateway: ${code}`)
    this.name = 'AuthGatewayError'
    this.code = code
    this.status = status
  }
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function validName(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(value)
}

function resolveSpec(config: AuthGatewayConfig): ResolvedSpec {
  const refreshCookieName = config.refreshCookieName ?? DEFAULT_REFRESH_COOKIE
  const accessCookieName = config.accessCookieName ?? DEFAULT_ACCESS_COOKIE
  const csrfCookieName = config.csrfCookieName ?? DEFAULT_CSRF_COOKIE
  const csrfHeaderName = (config.csrfHeaderName ?? DEFAULT_CSRF_HEADER).toLowerCase()
  const refreshCookiePath = config.refreshCookiePath ?? DEFAULT_REFRESH_PATH
  if (![refreshCookieName, accessCookieName, csrfCookieName].every(validName)
    || !/^[a-z0-9-]{1,128}$/.test(csrfHeaderName)
    || !refreshCookiePath.startsWith('/') || refreshCookiePath.includes(';')
    || new Set([refreshCookieName, accessCookieName, csrfCookieName]).size !== 3) {
    throw new TypeError('auth-gateway: carrier configuration is invalid')
  }
  const origins = config.allowedOrigins ?? []
  const allowedOrigins = new Set<string>()
  for (const origin of origins) {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      throw new TypeError('auth-gateway: allowed origin is invalid')
    }
    if (parsed.origin !== origin || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      throw new TypeError('auth-gateway: allowed origin is invalid')
    }
    allowedOrigins.add(origin)
  }
  if (allowedOrigins.size !== origins.length) throw new TypeError('auth-gateway: allowed origins must be unique')
  return Object.freeze({
    refreshCookieName,
    accessCookieName,
    csrfCookieName,
    csrfHeaderName,
    refreshCookiePath,
    allowedOrigins,
    allowWebSocketQueryAccessToken: config.allowWebSocketQueryAccessToken ?? false,
  })
}

function requestId(request: GatewayRequest) {
  if (!(request.signal instanceof AbortSignal)) throw new AuthGatewayError('invalid-request', 400)
  if (request.signal.aborted) throw new AuthGatewayError('unauthenticated', 401)
  try {
    return authenticationRequestId(request.requestId)
  } catch {
    throw new AuthGatewayError('invalid-request', 400)
  }
}

function entries(values: readonly (GatewayHeader | GatewayCookie | GatewayQueryEntry)[] | undefined): Map<string, string> {
  if (values === undefined) return new Map()
  if (values.length > MAX_ENTRIES) throw new AuthGatewayError('invalid-request', 400)
  const result = new Map<string, string>()
  for (const entry of values) {
    if (typeof entry.name !== 'string' || typeof entry.value !== 'string'
      || bytes(entry.name) === 0 || bytes(entry.name) > MAX_NAME_BYTES || bytes(entry.value) > MAX_VALUE_BYTES) {
      throw new AuthGatewayError('invalid-request', 400)
    }
    const key = entry.name.toLowerCase()
    if (result.has(key)) throw new AuthGatewayError('invalid-request', 400)
    result.set(key, entry.value)
  }
  return result
}

function bearer(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const match = /^Bearer ([^\s]+)$/.exec(value)
  if (match === null || bytes(match[1] as string) > MAX_VALUE_BYTES) throw new AuthGatewayError('unauthenticated', 401)
  return match[1]
}

function one(candidates: readonly (string | undefined)[]): string {
  const present = candidates.filter((value): value is string => value !== undefined)
  if (present.length !== 1 || present[0] === '') throw new AuthGatewayError('invalid-request', 400)
  return present[0] as string
}

function equalSecret(left: string, right: string): boolean {
  if (bytes(left) === 0 || bytes(left) > MAX_CSRF_BYTES || bytes(right) === 0 || bytes(right) > MAX_CSRF_BYTES) return false
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Active transport-neutral authentication gateway. */
    authGateway: AuthGatewayService
  }
}

/** Extracts bounded credentials and delegates only public account operations. */
export class AuthGatewayService extends Service {
  static Config = Config
  private readonly spec: ResolvedSpec

  /** @param ctx - Host context carrying authentication and account services.
   * @param config - carrier names and trusted browser origins.
   */
  constructor(ctx: Context, config: AuthGatewayConfig = {}) {
    super(ctx, 'authGateway')
    this.spec = resolveSpec(config)
  }

  /** Authenticate one HTTP access carrier.
   * @param request - structured headers, cookies, query, and lifecycle.
   * @returns Host-only call minted by the active authentication Provider.
   */
  async authenticateHttp(request: GatewayHttpAuthenticationRequest): Promise<AuthenticatedCall> {
    const lifecycle = requestId(request)
    const headers = entries(request.headers)
    const cookies = entries(request.cookies)
    const query = entries(request.query)
    if (query.has(ACCESS_QUERY) || query.has(REFRESH_QUERY) || query.has(PASSWORD_QUERY)
      || cookies.has(this.spec.refreshCookieName.toLowerCase())) {
      throw new AuthGatewayError('invalid-request', 400)
    }
    const token = one([bearer(headers.get('authorization')), cookies.get(this.spec.accessCookieName.toLowerCase())])
    return this.authenticate(token, lifecycle, request.signal, 'http')
  }

  /** Authenticate one WebSocket handshake without retaining raw carrier input.
   * @param request - structured handshake fields and lifecycle.
   * @returns Host-only call minted for the WebSocket channel.
   */
  async authenticateWebSocket(request: GatewayWebSocketAuthenticationRequest): Promise<AuthenticatedCall> {
    const lifecycle = requestId(request)
    const headers = entries(request.headers)
    const cookies = entries(request.cookies)
    const query = entries(request.query)
    if (query.has(REFRESH_QUERY) || query.has(PASSWORD_QUERY)
      || cookies.has(this.spec.refreshCookieName.toLowerCase())) {
      throw new AuthGatewayError('invalid-request', 400)
    }
    const protocols = request.subprotocols ?? []
    if (protocols.length > MAX_ENTRIES) throw new AuthGatewayError('invalid-request', 400)
    let protocolToken: string | undefined
    for (const protocol of protocols) {
      if (typeof protocol !== 'string' || bytes(protocol) > MAX_VALUE_BYTES) throw new AuthGatewayError('invalid-request', 400)
      if (/refresh|password/i.test(protocol)) throw new AuthGatewayError('invalid-request', 400)
      if (protocol.startsWith(SUBPROTOCOL_PREFIX)) {
        if (protocolToken !== undefined) throw new AuthGatewayError('invalid-request', 400)
        protocolToken = protocol.slice(SUBPROTOCOL_PREFIX.length)
      }
    }
    const queryToken = query.get(ACCESS_QUERY)
    if (queryToken !== undefined && !this.spec.allowWebSocketQueryAccessToken) throw new AuthGatewayError('invalid-request', 400)
    const token = one([
      bearer(headers.get('authorization')),
      cookies.get(this.spec.accessCookieName.toLowerCase()),
      protocolToken,
      queryToken,
    ])
    return this.authenticate(token, lifecycle, request.signal, 'websocket')
  }

  /** Register an account without issuing credentials.
   * @param request - bounded profile, password, and lifecycle input.
   * @returns committed user record.
   */
  async register(request: GatewayRegistrationRequest): Promise<UserRecord> {
    const lifecycle = requestId(request)
    this.rejectCredentialCarriers(request)
    this.password(request.password)
    try {
      return await this.ctx.accounts.register({
        requestId: lifecycle,
        signal: request.signal,
        identifier: request.identifier,
        password: request.password,
        ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
        ...(request.extensions === undefined ? {} : { extensions: request.extensions }),
      })
    } catch (cause) {
      throw this.map(cause)
    }
  }

  /** Password-login and place refresh material in an HttpOnly cookie.
   * @param request - bounded login body and lifecycle input.
   * @returns user, access token, and cookie directives.
   */
  async login(request: GatewayLoginRequest): Promise<GatewaySessionResult> {
    const lifecycle = requestId(request)
    this.rejectCredentialCarriers(request)
    this.password(request.password)
    try {
      const result = await this.ctx.accounts.login({
        requestId: lifecycle,
        signal: request.signal,
        channel: 'http',
        identifier: request.identifier,
        password: request.password,
      })
      return this.session(result.credentials, result.user)
    } catch (cause) {
      throw this.map(cause)
    }
  }

  /** Rotate the refresh cookie after Origin and double-submit CSRF checks.
   * @param request - structured browser request and lifecycle.
   * @returns replacement access token and cookie directives.
   */
  async refresh(request: GatewayRequest): Promise<GatewaySessionResult> {
    const lifecycle = requestId(request)
    const headers = entries(request.headers)
    const cookies = entries(request.cookies)
    const query = entries(request.query)
    if (headers.has('authorization') || cookies.has(this.spec.accessCookieName.toLowerCase())
      || query.has(ACCESS_QUERY) || query.has(REFRESH_QUERY) || query.has(PASSWORD_QUERY)) {
      throw new AuthGatewayError('invalid-request', 400)
    }
    const origin = headers.get('origin')
    const csrfHeader = headers.get(this.spec.csrfHeaderName)
    const csrfCookie = cookies.get(this.spec.csrfCookieName.toLowerCase())
    const refreshToken = cookies.get(this.spec.refreshCookieName.toLowerCase())
    if (origin === undefined || !this.spec.allowedOrigins.has(origin)
      || csrfHeader === undefined || csrfCookie === undefined || !equalSecret(csrfHeader, csrfCookie)
      || refreshToken === undefined || refreshToken === '') {
      throw new AuthGatewayError('forbidden', 403)
    }
    try {
      return this.session(await this.ctx.accounts.refresh({ requestId: lifecycle, signal: request.signal, refreshToken }))
    } catch (cause) {
      throw this.map(cause)
    }
  }

  /** Authenticate and revoke the current user's sessions.
   * @param request - HTTP bearer request and lifecycle.
   * @returns cookie clearing directives.
   */
  async logout(request: GatewayHttpAuthenticationRequest): Promise<GatewayLogoutResult> {
    const call = await this.authenticateHttp(request)
    try {
      await this.ctx.accounts.logout(this.ctx.auth.assertCurrent(call))
      return Object.freeze({
        cookies: Object.freeze([
          this.clear(this.spec.refreshCookieName, true),
          this.clear(this.spec.csrfCookieName, false),
        ]),
      })
    } catch (cause) {
      throw this.map(cause)
    }
  }

  /** Revalidate an authenticated call immediately before protected handler use.
   * @param call - exact Host-only call returned by this gateway.
   * @param handler - protected operation that receives only the current call.
   * @returns handler result.
   */
  guard<T>(call: AuthenticatedCall, handler: (current: AuthenticatedCall) => T | Promise<T>): T | Promise<T> {
    let current: AuthenticatedCall
    try {
      current = this.ctx.auth.assertCurrent(call)
    } catch (cause) {
      throw this.map(cause)
    }
    return handler(current)
  }

  private async authenticate(token: string, lifecycle: ReturnType<typeof authenticationRequestId>, signal: AbortSignal, channel: 'http' | 'websocket') {
    try {
      return await this.ctx.auth.authenticate({ requestId: lifecycle, signal, channel, evidence: { kind: 'bearer', token } })
    } catch (cause) {
      throw this.map(cause)
    }
  }

  private rejectCredentialCarriers(request: GatewayRequest): void {
    const headers = entries(request.headers)
    const cookies = entries(request.cookies)
    const query = entries(request.query)
    if (headers.has('authorization') || cookies.has(this.spec.accessCookieName.toLowerCase())
      || cookies.has(this.spec.refreshCookieName.toLowerCase())
      || query.has(ACCESS_QUERY) || query.has(REFRESH_QUERY) || query.has(PASSWORD_QUERY)) {
      throw new AuthGatewayError('invalid-request', 400)
    }
  }

  private password(value: string): void {
    if (typeof value !== 'string' || bytes(value) === 0 || bytes(value) > MAX_PASSWORD_BYTES) {
      throw new AuthGatewayError('invalid-request', 400)
    }
  }

  private session(credentials: IssuedCredentialSet, user?: UserRecord): GatewaySessionResult {
    const access = credentials.credentials.filter(candidate => candidate.kind === 'access')
    const refresh = credentials.credentials.filter(candidate => candidate.kind === 'refresh')
    if (access.length !== 1 || refresh.length !== 1) throw new AuthGatewayError('unavailable', 503)
    const csrf = randomBytes(32).toString('base64url')
    const accessCredential = access[0] as (typeof access)[number]
    const refreshCredential = refresh[0] as (typeof refresh)[number]
    const cookies = Object.freeze([
      this.cookie(this.spec.refreshCookieName, refreshCredential.value, true, refreshCredential.expiresAt),
      this.cookie(this.spec.csrfCookieName, csrf, false, refreshCredential.expiresAt),
    ])
    return Object.freeze({
      ...(user === undefined ? {} : { user }),
      accessToken: accessCredential.value,
      ...(accessCredential.expiresAt === undefined ? {} : { accessExpiresAt: accessCredential.expiresAt }),
      cookies,
    })
  }

  private cookie(name: string, value: string, httpOnly: boolean, expiresAt?: number): GatewayCookieDirective {
    return Object.freeze({
      name,
      value,
      httpOnly,
      secure: true,
      sameSite: 'strict' as const,
      path: this.spec.refreshCookiePath,
      ...(expiresAt === undefined ? {} : { maxAgeSeconds: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) }),
    })
  }

  private clear(name: string, httpOnly: boolean): GatewayCookieDirective {
    return Object.freeze({ name, value: '', httpOnly, secure: true, sameSite: 'strict', path: this.spec.refreshCookiePath, maxAgeSeconds: 0 })
  }

  private map(cause: unknown): AuthGatewayError {
    if (cause instanceof AuthGatewayError) return cause
    if (cause instanceof AuthenticationError) {
      return cause.code === 'unauthenticated'
        ? new AuthGatewayError('unauthenticated', 401)
        : new AuthGatewayError('unavailable', 503)
    }
    if (cause instanceof AccountError) {
      switch (cause.code) {
        case 'invalid-input': return new AuthGatewayError('invalid-request', 400)
        case 'unauthenticated': return new AuthGatewayError('unauthenticated', 401)
        case 'account-inactive':
        case 'forbidden': return new AuthGatewayError('forbidden', 403)
        case 'conflict': return new AuthGatewayError('conflict', 409)
        default: return new AuthGatewayError('unavailable', 503)
      }
    }
    return new AuthGatewayError('unavailable', 503)
  }
}

export default AuthGatewayService
