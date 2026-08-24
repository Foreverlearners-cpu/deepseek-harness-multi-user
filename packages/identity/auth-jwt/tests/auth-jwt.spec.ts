import { Context } from '@deepseek-ai/cordis'
import AuthenticationRuntime, {
  AuthenticationError,
  authenticationMethod,
  authenticationRequestId,
  type IssuedCredential,
  type UserId,
} from '@deepseek-ai/dsh-auth'
import { UserDirectoryError } from '@deepseek-ai/dsh-user'
import { decodeJwt, decodeProtectedHeader, SignJWT } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import * as JwtAuth from '../src/index.ts'
import {
  JWT_ALGORITHM,
  JwtAuthenticationProvider,
  MAX_JWT_BYTES,
  resolveSpec,
  type JwtAuthenticationConfig,
} from '../src/index.ts'
import { MemoryAuthTokens } from '../../auth-token/tests/memory.ts'
import { MemoryUserDirectory } from '../../user/tests/memory.ts'

const requestId = authenticationRequestId('request-1')
const signal = new AbortController().signal
const method = authenticationMethod('jwt')
const firstSecret = Buffer.alloc(32, 1).toString('base64url')
const secondSecret = Buffer.alloc(32, 2).toString('base64url')

function config(overrides: Partial<JwtAuthenticationConfig> = {}): JwtAuthenticationConfig {
  return {
    issuer: 'https://issuer.example',
    audience: 'dsh-host',
    accessTtlSeconds: 600,
    refreshTtlSeconds: 3_600,
    clockToleranceSeconds: 0,
    activeKeyId: 'key-1',
    keys: [{ keyId: 'key-1', secret: firstSecret }],
    ...overrides,
  }
}

async function setup(Provider = JwtAuthenticationProvider, value = config()) {
  const ctx = new Context()
  await ctx.plugin(AuthenticationRuntime)
  await ctx.plugin(MemoryUserDirectory)
  await ctx.plugin(MemoryAuthTokens)
  const user = await ctx.users.create({ displayName: 'JWT User' })
  const provider = new Provider(ctx, value)
  const dispose = ctx.auth.providers.register('bearer', provider)
  return { ctx, user, provider, dispose }
}

function credential(set: { credentials: readonly IssuedCredential[] }, kind: IssuedCredential['kind']): IssuedCredential {
  const value = set.credentials.find(candidate => candidate.kind === kind)
  if (value === undefined) throw new Error(`missing ${kind}`)
  return value
}

async function issue(ctx: Context, userId: UserId) {
  return ctx.auth.credentials.issue(method, {
    requestId,
    signal,
    principal: { kind: 'user', id: userId },
  })
}

function attempt(token: string) {
  return {
    requestId,
    channel: 'http' as const,
    evidence: { kind: 'bearer' as const, token },
    signal,
  }
}

async function rejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation
  } catch (error) {
    return error
  }
  throw new Error('expected operation to reject')
}

async function forgeAccess(payload: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1_000)
  return new SignJWT({
    iss: 'https://issuer.example',
    aud: 'dsh-host',
    sub: 'user-1',
    iat: now,
    nbf: now,
    exp: now + 600,
    jti: 'access-forged',
    pk: 'user',
    sid: 'family-forged',
    ...payload,
  }).setProtectedHeader({ alg: JWT_ALGORITHM, kid: 'key-1', typ: 'access' })
    .sign(Buffer.from(firstSecret, 'base64url'))
}

async function forgeRefresh(
  payload: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000)
  return new SignJWT({
    iss: 'https://issuer.example',
    aud: 'dsh-host',
    sub: 'user-1',
    iat: now,
    nbf: now,
    exp: now + 3_600,
    jti: 'refresh-forged',
    pk: 'user',
    sid: 'family-forged',
    rft: 'dsh_rt_forged',
    ...payload,
  }).setProtectedHeader({ alg: JWT_ALGORITHM, kid: 'key-1', typ: 'refresh', ...header })
    .sign(Buffer.from(firstSecret, 'base64url'))
}

describe('JWT authentication lifecycle', () => {
  it('issues and verifies distinct signed access and refresh JWTs', async () => {
    const { ctx, user } = await setup()
    const issued = await issue(ctx, user.userId)
    const access = credential(issued, 'access')
    const refresh = credential(issued, 'refresh')

    expect(decodeProtectedHeader(access.value)).toEqual({ alg: JWT_ALGORITHM, kid: 'key-1', typ: 'access' })
    expect(decodeProtectedHeader(refresh.value)).toEqual({ alg: JWT_ALGORITHM, kid: 'key-1', typ: 'refresh' })
    expect(decodeJwt(refresh.value)).toMatchObject({ sid: refresh.tokenFamilyId, jti: refresh.id })
    expect(await ctx.auth.authenticate(attempt(access.value))).toMatchObject({
      principal: { kind: 'user', id: user.userId },
      credentialId: access.id,
      method,
    })
  })

  it('rejects access/refresh confusion and a tampered refresh JWT without rotating state', async () => {
    const { ctx, user } = await setup()
    const issued = await issue(ctx, user.userId)
    const access = credential(issued, 'access')
    const refresh = credential(issued, 'refresh')
    await expect(ctx.auth.authenticate(attempt(refresh.value))).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(ctx.auth.credentials.refresh(method, { requestId, signal, refreshToken: access.value }))
      .rejects.toMatchObject({ code: 'unauthenticated' })
    const tampered = `${refresh.value.slice(0, -1)}${refresh.value.endsWith('a') ? 'b' : 'a'}`
    await expect(ctx.auth.credentials.refresh(method, { requestId, signal, refreshToken: tampered }))
      .rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(ctx.auth.authenticate(attempt(access.value))).resolves.toMatchObject({ credentialId: access.id })
  })

  it('rotates refresh JWTs once and old-token replay revokes the server-side family', async () => {
    const { ctx, user } = await setup()
    const first = await issue(ctx, user.userId)
    const firstRefresh = credential(first, 'refresh')
    const second = await ctx.auth.credentials.refresh(method, {
      requestId,
      signal,
      refreshToken: firstRefresh.value,
    })
    const secondAccess = credential(second, 'access')
    const secondRefresh = credential(second, 'refresh')
    expect(secondRefresh.value).not.toBe(firstRefresh.value)
    await expect(ctx.auth.credentials.refresh(method, {
      requestId,
      signal,
      refreshToken: firstRefresh.value,
    })).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(ctx.auth.authenticate(attempt(secondAccess.value))).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('enforces current user status and explicit family revocation', async () => {
    const { ctx, user } = await setup()
    const first = await issue(ctx, user.userId)
    const access = credential(first, 'access')
    await ctx.users.disable({ userId: user.userId, expectedRevision: user.revision })
    await expect(ctx.auth.authenticate(attempt(access.value))).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(issue(ctx, user.userId)).rejects.toMatchObject({ code: 'unauthenticated' })

    const other = await ctx.users.create()
    const second = await issue(ctx, other.userId)
    const secondAccess = credential(second, 'access')
    expect(await ctx.auth.credentials.inspect(method, {
      requestId,
      signal,
      target: { kind: 'token-family', tokenFamilyId: secondAccess.tokenFamilyId! },
    })).toEqual([expect.objectContaining({ kind: 'refresh', active: true })])
    await ctx.auth.credentials.revoke(method, {
      requestId,
      signal,
      target: { kind: 'token-family', tokenFamilyId: secondAccess.tokenFamilyId! },
    })
    expect(await ctx.auth.credentials.inspect(method, {
      requestId,
      signal,
      target: { kind: 'token-family', tokenFamilyId: secondAccess.tokenFamilyId! },
    })).toEqual([expect.objectContaining({ active: false })])
    await expect(ctx.auth.authenticate(attempt(secondAccess.value))).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('retains old verification keys while the active key signs replacements', async () => {
    const { ctx, user, dispose } = await setup()
    const first = await issue(ctx, user.userId)
    const oldAccess = credential(first, 'access')
    const oldRefresh = credential(first, 'refresh')
    dispose()
    ctx.auth.providers.register('bearer', new JwtAuthenticationProvider(ctx, config({
      activeKeyId: 'key-2',
      keys: [
        { keyId: 'key-1', secret: firstSecret },
        { keyId: 'key-2', secret: secondSecret },
      ],
    })))
    await expect(ctx.auth.authenticate(attempt(oldAccess.value))).resolves.toMatchObject({ credentialId: oldAccess.id })
    const replaced = await ctx.auth.credentials.refresh(method, { requestId, signal, refreshToken: oldRefresh.value })
    expect(decodeProtectedHeader(credential(replaced, 'access').value).kid).toBe('key-2')
    expect(decodeProtectedHeader(credential(replaced, 'refresh').value).kid).toBe('key-2')
  })

  it('does not create a family when JWT signing fails during issue preparation', async () => {
    class FailingProvider extends JwtAuthenticationProvider {
      protected override sign(_jwt: SignJWT, _key: Uint8Array): Promise<string> {
        return Promise.reject(new Error('sign failed'))
      }
    }
    const { ctx, user } = await setup(FailingProvider)
    await expect(issue(ctx, user.userId)).rejects.toMatchObject({ code: 'authentication-unavailable' })
    const inspected = await ctx.authTokens.inspect({
      requestId,
      signal,
      target: { kind: 'principal', principal: { kind: 'user', id: user.userId } },
    })
    expect(inspected.families).toEqual([])
    expect(inspected.credentials).toEqual([])
  })

  it('keeps the old refresh credential active when rotation signing fails', async () => {
    class FailingOnceProvider extends JwtAuthenticationProvider {
      private signs = 0

      protected override sign(jwt: SignJWT, key: Uint8Array): Promise<string> {
        this.signs += 1
        if (this.signs === 3) return Promise.reject(new Error('sign failed'))
        return super.sign(jwt, key)
      }
    }
    const { ctx, user } = await setup(FailingOnceProvider)
    const issued = await issue(ctx, user.userId)
    const refresh = credential(issued, 'refresh')
    const failure = await rejection(ctx.auth.credentials.refresh(method, {
      requestId,
      signal,
      refreshToken: refresh.value,
    }))
    expect(failure).toMatchObject({ code: 'authentication-unavailable' })
    expect(failure).not.toHaveProperty('cause')
    await expect(ctx.auth.credentials.refresh(method, { requestId, signal, refreshToken: refresh.value }))
      .resolves.toHaveProperty('credentials')
  })

  it('surfaces Provider outages without exposing their diagnostics', async () => {
    const { ctx, user } = await setup()
    const issued = await issue(ctx, user.userId)
    const access = credential(issued, 'access')
    vi.spyOn(ctx.authTokens, 'inspect').mockRejectedValueOnce(new Error('database detail'))
    const tokenFailure = await rejection(ctx.auth.authenticate(attempt(access.value)))
    expect(tokenFailure).toMatchObject({
      code: 'authentication-unavailable',
      message: 'auth-jwt: authentication service is unavailable',
    })
    expect(tokenFailure).not.toHaveProperty('cause')
    vi.spyOn(ctx.users, 'requireActive').mockRejectedValueOnce(
      new UserDirectoryError('provider-unavailable', 'user storage detail'),
    )
    await expect(issue(ctx, user.userId)).rejects.toMatchObject({ code: 'authentication-unavailable' })
  })

  it('preserves normalized failures and rejects inconsistent rotation candidates before commit', async () => {
    const { ctx, user } = await setup()
    const issued = await issue(ctx, user.userId)
    const refresh = credential(issued, 'refresh')
    vi.spyOn(ctx.authTokens, 'rotateWithPreparation').mockRejectedValueOnce(
      new AuthenticationError('unauthenticated', 'trusted normalized failure', { cause: new Error('private') }),
    )
    const normalized = await rejection(ctx.auth.credentials.refresh(method, {
      requestId,
      signal,
      refreshToken: refresh.value,
    }))
    expect(normalized).toMatchObject({ message: 'trusted normalized failure' })
    expect(normalized).not.toHaveProperty('cause')

    const original = ctx.authTokens.rotateWithPreparation.bind(ctx.authTokens)
    vi.spyOn(ctx.authTokens, 'rotateWithPreparation').mockImplementationOnce((request, prepare) => {
      return original(request, candidate => prepare({
        ...candidate,
        family: { ...candidate.family, tokenFamilyId: 'family-other' as typeof candidate.family.tokenFamilyId },
      }))
    })
    await expect(ctx.auth.credentials.refresh(method, { requestId, signal, refreshToken: refresh.value }))
      .rejects.toMatchObject({ code: 'authentication-unavailable' })
    await expect(ctx.auth.credentials.refresh(method, { requestId, signal, refreshToken: refresh.value }))
      .resolves.toHaveProperty('credentials')
  })

  it('supports service-account and local principals without user-directory lookup', async () => {
    const { ctx } = await setup()
    for (const principal of [
      { kind: 'service-account' as const, id: 'service-1' as never },
      { kind: 'local' as const, id: 'local-1' as never },
    ]) {
      const issued = await ctx.auth.credentials.issue(method, { requestId, signal, principal })
      await expect(ctx.auth.authenticate(attempt(credential(issued, 'access').value)))
        .resolves.toMatchObject({ principal })
    }
  })

  it('registers and disposes through the Cordis plugin entry', async () => {
    const ctx = new Context()
    await ctx.plugin(AuthenticationRuntime)
    await ctx.plugin(MemoryUserDirectory)
    await ctx.plugin(MemoryAuthTokens)
    const user = await ctx.users.create()
    const fiber = ctx.plugin(JwtAuth, config())
    await fiber
    await expect(issue(ctx, user.userId)).resolves.toHaveProperty('credentials')
    await fiber.dispose()
    await expect(issue(ctx, user.userId)).rejects.toMatchObject({ code: 'credential-operation-unsupported' })
  })

  it('rejects oversized and malformed bearer input before JOSE verification', async () => {
    const { ctx } = await setup()
    await expect(ctx.auth.authenticate(attempt('x'.repeat(MAX_JWT_BYTES + 1))))
      .rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(ctx.auth.authenticate(attempt('not-a-jwt'))).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('rejects signed tokens whose fixed claims violate the access profile', async () => {
    const { ctx } = await setup()
    const now = Math.floor(Date.now() / 1_000)
    for (const payload of [
      { aud: ['dsh-host'] },
      { iat: now - 1, nbf: now },
      { exp: now + 601 },
      { sid: 1 },
      { rft: 'refresh-secret' },
      { pk: 'unknown' },
    ]) {
      await expect(ctx.auth.authenticate(attempt(await forgeAccess(payload))))
        .rejects.toMatchObject({ code: 'unauthenticated' })
    }
  })

  it('rejects signed refresh JWTs whose fixed claims violate the refresh profile', async () => {
    const { ctx } = await setup()
    const now = Math.floor(Date.now() / 1_000)
    for (const payload of [
      { iss: 'https://other.example' },
      { aud: 'other-host' },
      { aud: ['dsh-host'] },
      { iat: now + 0.5, nbf: now + 0.5 },
      { iat: now, nbf: now + 1 },
      { exp: now },
      { exp: now + 3_601 },
      { jti: undefined },
      { jti: 1 },
      { sid: undefined },
      { sid: 1 },
      { rft: undefined },
      { rft: 1 },
    ]) {
      await expect(ctx.auth.credentials.refresh(method, {
        requestId,
        signal,
        refreshToken: await forgeRefresh(payload),
      })).rejects.toMatchObject({ code: 'unauthenticated' })
    }
    await expect(ctx.auth.credentials.refresh(method, {
      requestId,
      signal,
      refreshToken: await forgeRefresh({}, { typ: 'access' }),
    })).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(ctx.auth.credentials.refresh(method, {
      requestId,
      signal,
      refreshToken: await forgeRefresh({}, { kid: 'unknown-key' }),
    })).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('rejects a token whose protected key id is not in the configured verification keyring', async () => {
    const { ctx } = await setup()
    const now = Math.floor(Date.now() / 1_000)
    const token = await new SignJWT({ pk: 'user', sid: 'family-1' })
      .setProtectedHeader({ alg: JWT_ALGORITHM, kid: 'unknown-key', typ: 'access' })
      .setIssuer('https://issuer.example')
      .setAudience('dsh-host')
      .setSubject('user-1')
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + 600)
      .setJti('access-unknown-key')
      .sign(Buffer.from(firstSecret, 'base64url'))
    await expect(ctx.auth.authenticate(attempt(token))).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('does not create a family when its remaining lifetime cannot encode a valid refresh JWT', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.100Z'))
      const { ctx, user } = await setup(JwtAuthenticationProvider, config({
        accessTtlSeconds: 1,
        refreshTtlSeconds: 1,
      }))
      const original = ctx.authTokens.issueFamilyWithPreparation.bind(ctx.authTokens)
      vi.spyOn(ctx.authTokens, 'issueFamilyWithPreparation').mockImplementationOnce((request, prepare) => {
        return original(request, (candidate) => {
          vi.setSystemTime(new Date('2026-01-01T00:00:01.200Z'))
          return prepare(candidate)
        })
      })
      await expect(issue(ctx, user.userId)).rejects.toMatchObject({ code: 'authentication-unavailable' })
      const inspection = await ctx.authTokens.inspect({
        requestId,
        signal,
        target: { kind: 'principal', principal: { kind: 'user', id: user.userId } },
      })
      expect(inspection.families).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('JWT configuration', () => {
  it('resolves defaults and decodes a canonical keyring', () => {
    expect(resolveSpec({
      issuer: 'issuer',
      audience: 'audience',
      activeKeyId: 'key-1',
      keys: [{ keyId: 'key-1', secret: firstSecret }],
    })).toMatchObject({
      accessTtlSeconds: 900,
      refreshTtlSeconds: 2_592_000,
      clockToleranceSeconds: 0,
      activeKey: { keyId: 'key-1' },
    })
  })

  it('allows equal access and refresh TTLs', () => {
    expect(resolveSpec(config({ accessTtlSeconds: 600, refreshTtlSeconds: 600 })))
      .toMatchObject({ accessTtlSeconds: 600, refreshTtlSeconds: 600 })
  })

  it.each([
    [{ ...config(), issuer: '' }, 'issuer'],
    [{ ...config(), issuer: 'x'.repeat(513) }, 'issuer'],
    [{ ...config(), audience: '' }, 'audience'],
    [{ ...config(), audience: 'x'.repeat(257) }, 'audience'],
    [{ ...config(), accessTtlSeconds: 0 }, 'access TTL'],
    [{ ...config(), accessTtlSeconds: 1.5 }, 'access TTL'],
    [{ ...config(), refreshTtlSeconds: 31_536_001 }, 'refresh TTL'],
    [{ ...config(), refreshTtlSeconds: 0 }, 'refresh TTL'],
    [{ ...config(), accessTtlSeconds: 601, refreshTtlSeconds: 600 }, 'greater than or equal'],
    [{ ...config(), clockToleranceSeconds: 301 }, 'clock tolerance'],
    [{ ...config(), clockToleranceSeconds: -1 }, 'clock tolerance'],
    [{ ...config(), clockToleranceSeconds: 1.5 }, 'clock tolerance'],
    [{ ...config(), keys: [] }, 'keys'],
    [{ ...config(), keys: Array.from({ length: 17 }, (_, index) => ({ keyId: `key-${String(index)}`, secret: firstSecret })) }, 'keys'],
    [{ ...config(), keys: [{ keyId: 'bad key', secret: firstSecret }] }, 'key id'],
    [{ ...config(), keys: [{ keyId: 'key-1', secret: 'bad!' }] }, 'key secret'],
    [{ ...config(), keys: [{ keyId: 'key-1', secret: Buffer.alloc(31).toString('base64url') }] }, '32-128 bytes'],
    [{ ...config(), keys: [{ keyId: 'key-1', secret: Buffer.alloc(129).toString('base64url') }] }, '32-128 bytes'],
    [{ ...config(), keys: [{ keyId: 'key-1', secret: firstSecret }, { keyId: 'key-1', secret: secondSecret }] }, 'unique'],
    [{ ...config(), activeKeyId: 'missing' }, 'active key'],
  ] as const)('rejects invalid config %#', (value, message) => {
    expect(() => resolveSpec(value)).toThrow(message)
  })
})
