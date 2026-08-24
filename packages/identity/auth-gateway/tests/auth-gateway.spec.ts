import { Context, Service } from '@deepseek-ai/cordis'
import AuthenticationRuntime, {
  AuthenticationError,
  authenticationMethod,
  credentialId,
  userId,
  type AuthenticatedCall,
  type AuthenticationProvider,
  type IssuedCredentialSet,
} from '@deepseek-ai/dsh-auth'
import type {} from '@deepseek-ai/dsh-auth-jwt/types'
import { AccountError, type AccountSessionResult } from '@deepseek-ai/dsh-account'
import { describe, expect, it, vi } from 'vitest'
import AuthGatewayService, { AuthGatewayError } from '../src/index.ts'

const signal = new AbortController().signal
const user = Object.freeze({
  userId: userId('user-1'),
  displayName: 'User',
  status: 'active' as const,
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
  extensions: Object.freeze({}),
})

function issued(access = 'access-token', refresh = 'refresh-token'): IssuedCredentialSet {
  return Object.freeze({
    credentials: Object.freeze([
      Object.freeze({ kind: 'access' as const, id: credentialId('access-1'), value: access, expiresAt: Date.now() + 60_000 }),
      Object.freeze({ kind: 'refresh' as const, id: credentialId('refresh-1'), value: refresh, expiresAt: Date.now() + 120_000 }),
    ]),
  })
}

class FakeAccounts extends Service {
  readonly register = vi.fn(async () => user)
  readonly login = vi.fn(async (): Promise<AccountSessionResult> => ({ user, credentials: issued() }))
  readonly refresh = vi.fn(async () => issued('next-access', 'next-refresh'))
  readonly logout = vi.fn(async () => {})

  constructor(ctx: Context) { super(ctx, 'accounts') }
}

function provider(): AuthenticationProvider<'bearer'> {
  return {
    method: authenticationMethod('jwt'),
    verify: async (attempt) => {
      if (attempt.evidence.token === 'refresh-token') {
        throw new AuthenticationError('unauthenticated', 'private refresh classification')
      }
      if (attempt.evidence.token !== 'access-token') throw new Error(`secret:${attempt.evidence.token}`)
      return {
        principal: { kind: 'user', id: user.userId },
        credentialId: credentialId('access-1'),
        authenticatedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }
    },
  }
}

interface Setup {
  readonly ctx: Context
  readonly gateway: AuthGatewayService
  readonly accounts: FakeAccounts
  readonly disposeProvider: () => void
}

async function setup(overrides: ConstructorParameters<typeof AuthGatewayService>[1] = {}): Promise<Setup> {
  const ctx = new Context()
  await ctx.plugin(AuthenticationRuntime)
  await ctx.plugin(FakeAccounts)
  await ctx.plugin(AuthGatewayService, { allowedOrigins: ['https://app.example'], ...overrides })
  return {
    ctx,
    gateway: ctx.authGateway,
    accounts: ctx.accounts as unknown as FakeAccounts,
    disposeProvider: ctx.auth.providers.register('bearer', provider()),
  }
}

function http(token = 'access-token') {
  return {
    requestId: 'request-1',
    signal,
    headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
  }
}

function refreshRequest(csrf = 'csrf-value') {
  return {
    requestId: 'refresh-1',
    signal,
    headers: [
      { name: 'Origin', value: 'https://app.example' },
      { name: 'X-DSH-CSRF', value: csrf },
    ],
    cookies: [
      { name: '__Host-dsh_refresh', value: 'refresh-token' },
      { name: '__Host-dsh_csrf', value: csrf },
    ],
  }
}

describe('auth gateway', () => {
  it('validates carrier configuration and keeps secure defaults', () => {
    expect(() => new AuthGatewayService(new Context())).not.toThrow()
    const invalid = [
      { refreshCookieName: 'bad cookie' },
      { csrfCookieName: 'bad cookie' },
      { csrfCookieName: '__host-dsh_csrf' },
      { csrfHeaderName: 'bad_header' },
      { refreshCookieName: 'dsh_refresh' },
      { csrfCookieName: '__Host-dsh_refresh' },
      { allowedOrigins: ['not a URL'] },
      { allowedOrigins: ['https://app.example/'] },
      { allowedOrigins: ['ftp://app.example'] },
      { allowedOrigins: ['https://app.example', 'https://app.example'] },
    ]
    for (const config of invalid) {
      expect(() => new AuthGatewayService(new Context(), config)).toThrow(TypeError)
    }
    expect(() => new AuthGatewayService(new Context(), { allowedOrigins: ['http://localhost:3000'] })).not.toThrow()
  })

  it('authenticates one bearer and revalidates it immediately before handler use', async () => {
    const { gateway } = await setup()
    const call = await gateway.authenticateHttp(http())
    const handler = vi.fn((current: AuthenticatedCall) => current.principal.id)

    expect(await gateway.guard(call, handler)).toBe(user.userId)
    expect(handler).toHaveBeenCalledWith(call)
    expect(call.channel).toBe('http')
    expect(call.requestId).toBe('request-1')
  })

  it('uses only Authorization for HTTP access authentication and ignores ambient cookies', async () => {
    const { gateway } = await setup()
    await expect(gateway.authenticateHttp({ ...http(), cookies: [{ name: '__Host-dsh_access', value: 'other-token' }] }))
      .resolves.toMatchObject({ channel: 'http' })
    await expect(gateway.authenticateHttp({
      requestId: 'cookie-only', signal, cookies: [{ name: '__Host-dsh_access', value: 'access-token' }],
    })).rejects.toMatchObject({ code: 'invalid-request', status: 400 })
    await expect(gateway.authenticateHttp({ ...http(), query: [{ name: 'access_token', value: 'access-token' }] }))
      .rejects.toMatchObject({ code: 'invalid-request' })
    await expect(gateway.authenticateHttp({ ...http(), cookies: [{ name: '__Host-dsh_refresh', value: 'refresh-token' }] }))
      .resolves.toMatchObject({ channel: 'http' })
  })

  it('rejects duplicate security headers after case folding and malformed bearer values', async () => {
    const { gateway } = await setup()
    await expect(gateway.authenticateHttp({
      requestId: 'request-1', signal,
      headers: [
        { name: 'Authorization', value: 'Bearer access-token' },
        { name: 'authorization', value: 'Bearer access-token' },
      ],
    })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(gateway.authenticateHttp(http('two words'))).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('bounds structured carrier collections, names, and values', async () => {
    const { gateway } = await setup()
    const invalidHeaders: unknown[] = [
      Array.from({ length: 65 }, (_, index) => ({ name: `x-${String(index)}`, value: '' })),
      [{ name: 1, value: '' }],
      [{ name: 'x', value: 1 }],
      [{ name: '', value: '' }],
      [{ name: 'x'.repeat(129), value: '' }],
      [{ name: 'x', value: 'x'.repeat(16_385) }],
    ]
    for (const headers of invalidHeaders) {
      await expect(gateway.authenticateHttp({ requestId: 'bounded', signal, headers: headers as never }))
        .rejects.toMatchObject({ code: 'invalid-request' })
    }
    for (const request of [
      { ...http(), headers: null as never },
      { ...http(), cookies: {} as never },
      { ...http(), cookies: [null] as never },
      { ...http(), query: [null] as never },
    ]) {
      const failure = await gateway.authenticateHttp(request).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(AuthGatewayError)
      expect(failure).toMatchObject({ code: 'invalid-request' })
    }
    await expect(gateway.authenticateHttp({ requestId: 'missing', signal })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(gateway.authenticateHttp({
      requestId: 'empty', signal, cookies: [{ name: '__Host-dsh_access', value: '' }],
    })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(gateway.authenticateHttp(http('x'.repeat(16_385)))).rejects.toMatchObject({ code: 'invalid-request' })
  })

  it('does not confuse refresh JWTs with access JWTs and redacts Provider failures', async () => {
    const { gateway } = await setup()
    await expect(gateway.authenticateHttp(http('refresh-token'))).rejects.toEqual(new AuthGatewayError('unauthenticated', 401))
    const failure = await gateway.authenticateHttp(http('raw-private-token')).catch((error: unknown) => error)
    expect(failure).toEqual(new AuthGatewayError('unavailable', 503))
    expect(JSON.stringify(failure)).not.toContain('raw-private-token')
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined()
  })

  it('authenticates WebSocket handshakes by header or subprotocol and forwards the channel', async () => {
    const { gateway } = await setup()
    expect(await gateway.authenticateWebSocket({ ...http() })).toMatchObject({
      call: { channel: 'websocket' },
      carrier: 'authorization',
      adapter: { echoCredentialSubprotocol: false, redactSubprotocols: false, redactQuery: false },
    })
    const result = await (await setup({ allowWebSocketBearerSubprotocol: true })).gateway.authenticateWebSocket({
      requestId: 'ws-1', signal, subprotocols: ['chat', 'dsh-auth-bearer.access-token'],
    })
    expect(result.call.requestId).toBe('ws-1')
    expect(result).toMatchObject({
      carrier: 'subprotocol',
      adapter: { echoCredentialSubprotocol: false, redactSubprotocols: true, redactQuery: false },
    })
  })

  it('forbids password and refresh leakage in WebSocket query or subprotocol carriers', async () => {
    const { gateway } = await setup()
    await expect(gateway.authenticateWebSocket({ ...http(), query: [{ name: 'password', value: 'secret' }] }))
      .rejects.toMatchObject({ code: 'invalid-request' })
    await expect(gateway.authenticateWebSocket({ ...http(), query: [{ name: 'Password', value: 'secret' }] }))
      .rejects.toMatchObject({ code: 'invalid-request' })
    await expect(gateway.authenticateWebSocket({
      requestId: 'ws-1', signal, subprotocols: ['dsh-auth-refresh.refresh-token'],
    })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(gateway.authenticateWebSocket({
      requestId: 'ws-1', signal, query: [{ name: 'access_token', value: 'access-token' }],
    })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(gateway.authenticateWebSocket({
      requestId: 'ws-subprotocol-disabled', signal, subprotocols: ['dsh-auth-bearer.access-token'],
    })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(gateway.authenticateWebSocket({
      requestId: 'ws-query-case', signal, query: [{ name: 'ACCESS_TOKEN', value: 'access-token' }],
    })).rejects.toMatchObject({ code: 'invalid-request' })
  })

  it('bounds WebSocket protocol input and rejects repeated bearer protocols', async () => {
    const { gateway } = await setup({ allowWebSocketBearerSubprotocol: true })
    await expect(gateway.authenticateWebSocket({
      requestId: 'ws-many', signal, subprotocols: Array.from({ length: 65 }, () => 'chat'),
    })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(gateway.authenticateWebSocket({
      requestId: 'ws-container', signal, subprotocols: null as never,
    })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(gateway.authenticateWebSocket({
      requestId: 'ws-type', signal, subprotocols: [1 as never],
    })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(gateway.authenticateWebSocket({
      requestId: 'ws-long', signal, subprotocols: ['x'.repeat(16_385)],
    })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(gateway.authenticateWebSocket({
      requestId: 'ws-repeat', signal,
      subprotocols: ['dsh-auth-bearer.access-token', 'dsh-auth-bearer.access-token'],
    })).rejects.toMatchObject({ code: 'invalid-request' })
  })

  it('allows an explicitly configured WebSocket query access token but still enforces one carrier', async () => {
    const { gateway } = await setup({ allowWebSocketQueryAccessToken: true })
    const result = await gateway.authenticateWebSocket({
      requestId: 'ws-query', signal, query: [{ name: 'access_token', value: 'access-token' }],
    })
    expect(result.call.channel).toBe('websocket')
    expect(result).toMatchObject({ carrier: 'query', adapter: { redactQuery: true, redactSubprotocols: false } })
    await expect(gateway.authenticateWebSocket({
      ...http(), query: [{ name: 'access_token', value: 'access-token' }],
    })).rejects.toMatchObject({ code: 'invalid-request' })
  })

  it('logs in with bounded body credentials and keeps refresh material out of the response body', async () => {
    const { gateway, accounts } = await setup()
    const result = await gateway.login({
      requestId: 'login-1', signal, identifier: { kind: 'username', value: 'alice' }, password: 'correct horse',
    })
    expect(result.user).toBe(user)
    expect(result.accessToken).toBe('access-token')
    expect(result.cookies).toMatchObject([
      { name: '__Host-dsh_refresh', value: 'refresh-token', httpOnly: true, secure: true, sameSite: 'strict', path: '/' },
      { name: '__Host-dsh_csrf', httpOnly: false, secure: true, sameSite: 'strict', path: '/' },
    ])
    expect(JSON.stringify({ ...result, cookies: undefined })).not.toContain('refresh-token')
    expect(accounts.login).toHaveBeenCalledWith(expect.objectContaining({ channel: 'http', requestId: 'login-1', signal }))
  })

  it('registers without credentials and rejects carrier smuggling or oversized passwords', async () => {
    const { gateway, accounts } = await setup()
    await expect(gateway.register({
      requestId: 'register-1', signal, identifier: { kind: 'username', value: 'alice' }, password: 'new password', displayName: 'Alice',
    })).resolves.toBe(user)
    await expect(gateway.register({
      requestId: 'register-extensions', signal, identifier: { kind: 'username', value: 'bob' }, password: 'new password', extensions: { locale: 'zh' },
    })).resolves.toBe(user)
    expect(accounts.register).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'register-1', displayName: 'Alice' }))
    await expect(gateway.login({
      requestId: 'login-1', signal, headers: [{ name: 'Authorization', value: 'Bearer access-token' }],
      identifier: { kind: 'username', value: 'alice' }, password: 'secret',
    })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(gateway.register({
      requestId: 'register-2', signal, identifier: { kind: 'username', value: 'alice' }, password: 'x'.repeat(4097),
    })).rejects.toMatchObject({ code: 'invalid-request' })
    await expect(gateway.register({
      requestId: 'register-3', signal, identifier: { kind: 'username', value: 'alice' }, password: '', extensions: { locale: 'zh' },
    })).rejects.toMatchObject({ code: 'invalid-request' })
  })

  it('requires allowed Origin and matching double-submit CSRF before consuming refresh', async () => {
    const { gateway, accounts } = await setup()
    const result = await gateway.refresh(refreshRequest())
    expect(result.accessToken).toBe('next-access')
    expect(result.cookies[0]).toMatchObject({ value: 'next-refresh', httpOnly: true })
    expect(accounts.refresh).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: 'refresh-token' }))

    await expect(gateway.refresh(refreshRequest('different'))).resolves.toBeDefined()
    await expect(gateway.refresh({
      ...refreshRequest(),
      headers: [{ name: 'Origin', value: 'https://evil.example' }, { name: 'X-DSH-CSRF', value: 'csrf-value' }],
    })).rejects.toMatchObject({ code: 'forbidden', status: 403 })
    await expect(gateway.refresh({
      ...refreshRequest(),
      cookies: [{ name: '__Host-dsh_refresh', value: 'refresh-token' }, { name: '__Host-dsh_csrf', value: 'other' }],
    })).rejects.toMatchObject({ code: 'forbidden' })
    for (const csrf of ['', 'x'.repeat(257)]) {
      await expect(gateway.refresh(refreshRequest(csrf))).rejects.toMatchObject({ code: 'forbidden' })
    }
    await expect(gateway.refresh({
      ...refreshRequest(),
      cookies: [{ name: '__Host-dsh_refresh', value: 'refresh-token' }, { name: '__Host-dsh_csrf', value: 'x'.repeat(257) }],
    })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(gateway.refresh({
      ...refreshRequest(),
      cookies: [{ name: '__host-dsh_refresh', value: 'refresh-token' }, { name: '__Host-dsh_csrf', value: 'csrf-value' }],
    })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(gateway.refresh({
      ...refreshRequest(),
      cookies: [
        { name: '__Host-dsh_refresh', value: 'refresh-token' },
        { name: '__host-dsh_refresh', value: 'attacker-token' },
        { name: '__Host-dsh_csrf', value: 'csrf-value' },
      ],
    })).resolves.toMatchObject({ accessToken: 'next-access' })
    await expect(gateway.refresh({
      ...refreshRequest(),
      cookies: [
        { name: '__Host-dsh_refresh', value: 'refresh-token' },
        { name: '__Host-dsh_refresh', value: 'attacker-token' },
        { name: '__Host-dsh_csrf', value: 'csrf-value' },
      ],
    })).rejects.toMatchObject({ code: 'invalid-request' })
  })

  it('maps delegated login, refresh, and logout failures without secret details', async () => {
    const { gateway, accounts } = await setup()
    accounts.login.mockRejectedValueOnce(new AccountError('unauthenticated', 'secret login'))
    await expect(gateway.login({
      requestId: 'login-fail', signal, identifier: { kind: 'username', value: 'alice' }, password: 'secret',
    })).rejects.toEqual(new AuthGatewayError('unauthenticated', 401))
    accounts.refresh.mockRejectedValueOnce(new AccountError('unavailable', 'secret refresh'))
    await expect(gateway.refresh(refreshRequest())).rejects.toEqual(new AuthGatewayError('unavailable', 503))
    accounts.logout.mockRejectedValueOnce(new AccountError('unavailable', 'secret logout'))
    await expect(gateway.logout(http())).rejects.toEqual(new AuthGatewayError('unavailable', 503))
  })

  it('rejects malformed credential sets and supports credentials without expiry', async () => {
    const { gateway, accounts } = await setup()
    accounts.refresh.mockResolvedValueOnce({ credentials: [{ kind: 'refresh', id: credentialId('refresh-only'), value: 'refresh' }] })
    await expect(gateway.refresh(refreshRequest())).rejects.toMatchObject({ code: 'unavailable' })
    accounts.refresh.mockResolvedValueOnce({ credentials: [{ kind: 'access', id: credentialId('access-only'), value: 'access' }] })
    await expect(gateway.refresh(refreshRequest())).rejects.toMatchObject({ code: 'unavailable' })
    accounts.refresh.mockResolvedValueOnce({
      credentials: [
        { kind: 'access', id: credentialId('access-no-expiry'), value: 'access' },
        { kind: 'refresh', id: credentialId('refresh-no-expiry'), value: 'refresh' },
      ],
    })
    const result = await gateway.refresh(refreshRequest())
    expect(result.accessExpiresAt).toBeUndefined()
    expect(result.cookies[0]?.maxAgeSeconds).toBeUndefined()
  })

  it('rejects refresh mixed with access carriers and clears cookies after current logout', async () => {
    const { gateway, accounts } = await setup()
    await expect(gateway.refresh({ ...refreshRequest(), headers: [...refreshRequest().headers, ...http().headers] }))
      .rejects.toMatchObject({ code: 'invalid-request' })
    const result = await gateway.logout(http())
    expect(accounts.logout).toHaveBeenCalledOnce()
    expect(result.cookies).toMatchObject([
      { name: '__Host-dsh_refresh', value: '', maxAgeSeconds: 0, path: '/' },
      { name: '__Host-dsh_csrf', value: '', maxAgeSeconds: 0, path: '/' },
    ])
  })

  it('propagates cancellation and invalid lifecycle fields without invoking Providers', async () => {
    const { gateway } = await setup()
    const controller = new AbortController()
    controller.abort()
    await expect(gateway.authenticateHttp({ ...http(), signal: controller.signal }))
      .rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(gateway.authenticateHttp({ ...http(), requestId: 'bad request id' }))
      .rejects.toMatchObject({ code: 'invalid-request' })
    await expect(gateway.authenticateHttp({ ...http(), signal: {} as never }))
      .rejects.toMatchObject({ code: 'invalid-request' })
  })

  it('invalidates calls when the bearer Provider changes before handler use', async () => {
    const { ctx, gateway, disposeProvider } = await setup()
    const call = await gateway.authenticateHttp(http())
    disposeProvider()
    ctx.auth.providers.register('bearer', provider())

    expect(() => gateway.guard(call, () => 'not-run')).toThrow(expect.objectContaining({ code: 'unauthenticated' }))
  })

  it('maps account categories to fixed statuses and never exposes causes or management service methods', async () => {
    const { gateway, accounts } = await setup()
    for (const [code, expected] of [
      ['invalid-input', ['invalid-request', 400]],
      ['unauthenticated', ['unauthenticated', 401]],
      ['account-inactive', ['forbidden', 403]],
      ['forbidden', ['forbidden', 403]],
      ['conflict', ['conflict', 409]],
      ['registration-incomplete', ['unavailable', 503]],
    ] as const) {
      accounts.register.mockRejectedValueOnce(new AccountError(code, 'secret database detail'))
      const failure = await gateway.register({
        requestId: `map-${code}`, signal, identifier: { kind: 'username', value: 'alice' }, password: 'password',
      }).catch((error: unknown) => error) as AuthGatewayError
      expect([failure.code, failure.status]).toEqual(expected)
      expect(failure.cause).toBeUndefined()
    }
    accounts.register.mockRejectedValueOnce(new AuthGatewayError('forbidden', 403))
    await expect(gateway.register({
      requestId: 'already-safe', signal, identifier: { kind: 'username', value: 'alice' }, password: 'password',
    })).rejects.toEqual(new AuthGatewayError('forbidden', 403))
    accounts.register.mockRejectedValueOnce(new Error('database secret'))
    await expect(gateway.register({
      requestId: 'unknown-error', signal, identifier: { kind: 'username', value: 'alice' }, password: 'password',
    })).rejects.toEqual(new AuthGatewayError('unavailable', 503))
    expect('accountAdministration' in gateway).toBe(false)
  })
})
