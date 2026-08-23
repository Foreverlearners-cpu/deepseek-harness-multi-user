import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import AuthenticationRuntime, {
  AuthenticationError,
  authenticationMethod,
  authenticationRequestId,
  credentialId,
  tokenFamilyId,
  userId,
} from '../src/index.ts'
import type {
  AuthenticationAttempt,
  AuthenticationEventRecord,
  AuthenticationProvider,
} from '../src/types.ts'

const method = authenticationMethod('local-test')

function attempt(signal = new AbortController().signal): AuthenticationAttempt<'in-process'> {
  return {
    requestId: authenticationRequestId('request-1'),
    channel: 'in-process',
    evidence: { kind: 'in-process' },
    signal,
  }
}

function provider(overrides: Partial<AuthenticationProvider<'in-process'>> = {}): AuthenticationProvider<'in-process'> {
  return {
    method,
    verify: async () => ({
      principal: { kind: 'user', id: userId('user-1') },
      credentialId: credentialId('credential-1'),
      authenticatedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }),
    ...overrides,
  }
}

async function setup(): Promise<{ ctx: Context; auth: AuthenticationRuntime }> {
  const ctx = new Context()
  await ctx.plugin(AuthenticationRuntime)
  return { ctx, auth: ctx.auth }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof AuthenticationError ? error.code : undefined
}

describe('authentication runtime', () => {
  it('selects the exact evidence Provider and mints a frozen current call', async () => {
    const { ctx, auth } = await setup()
    const records: AuthenticationEventRecord[] = []
    ctx.on('auth/result', (record) => { records.push(record) })
    auth.providers.register('in-process', provider())

    const call = await auth.authenticate(attempt())

    expect(call.principal).toEqual({ kind: 'user', id: 'user-1' })
    expect(call.method).toBe(method)
    expect(Object.isFrozen(call)).toBe(true)
    expect(Object.isFrozen(call.principal)).toBe(true)
    expect(auth.assertCurrent(call)).toBe(call)
    expect(records).toMatchObject([{
      evidenceKind: 'in-process',
      method: 'local-test',
      outcome: 'succeeded',
    }])
    expect(JSON.stringify(records)).not.toContain('secret')
  })

  it('rejects structural copies and JSON round trips because only the runtime can mint provenance', async () => {
    const { auth } = await setup()
    auth.providers.register('in-process', provider())
    const call = await auth.authenticate(attempt())

    expect(() => auth.assertCurrent({ ...call })).toThrowError(AuthenticationError)
    expect(() => auth.assertCurrent(JSON.parse(JSON.stringify(call)))).toThrowError(AuthenticationError)
  })

  it('rejects duplicate evidence kinds and duplicate authentication methods', async () => {
    const { auth } = await setup()
    auth.providers.register('in-process', provider())

    expect(() => auth.providers.register('in-process', provider({
      method: authenticationMethod('other-method'),
    }))).toThrow(/evidence kind/)

    interface ExtraEvidenceMap {
      readonly extra: { readonly kind: 'extra' }
    }
    const registry = auth.providers as unknown as {
      register(kind: keyof ExtraEvidenceMap, value: AuthenticationProvider<'in-process'>): () => void
    }
    expect(() => registry.register('extra', provider())).toThrow(/method/)
  })

  it('removes a disposed Provider route and invalidates calls minted by it', async () => {
    const { ctx, auth } = await setup()
    const providerFiber = ctx.plugin((owner) => {
      owner.effect(() => auth.providers.register('in-process', provider()))
    })
    await providerFiber
    const call = await auth.authenticate(attempt())

    await providerFiber.dispose()

    expect(() => auth.assertCurrent(call)).toThrow(/current Provider/)
    await expect(auth.authenticate(attempt())).rejects.toMatchObject({
      code: 'authentication-unavailable',
    })
  })

  it('rejects cancelled attempts and calls as well as expired credentials', async () => {
    const { auth } = await setup()
    auth.providers.register('in-process', provider())
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(auth.authenticate(attempt(cancelled.signal))).rejects.toMatchObject({ code: 'unauthenticated' })

    const activeController = new AbortController()
    const call = await auth.authenticate(attempt(activeController.signal))
    activeController.abort()
    expect(() => auth.assertCurrent(call)).toThrow(/cancelled/)

    const { auth: expiringAuth } = await setup()
    expiringAuth.providers.register('in-process', provider({
      verify: async () => ({
        principal: { kind: 'user', id: userId('user-1') },
        authenticatedAt: Date.now() - 10,
        expiresAt: Date.now() - 1,
      }),
    }))
    await expect(expiringAuth.authenticate(attempt())).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('normalizes unexpected Provider failures and rejects malformed Provider output', async () => {
    const { auth } = await setup()
    auth.providers.register('in-process', provider({
      verify: async () => { throw new Error('database password must not escape') },
    }))
    await expect(auth.authenticate(attempt())).rejects.toMatchObject({
      code: 'authentication-unavailable',
      message: 'auth: authentication Provider failed',
    })

    const { auth: malformedAuth } = await setup()
    malformedAuth.providers.register('in-process', provider({
      verify: async () => ({
        principal: { kind: 'user', id: userId('user-1') },
        authenticatedAt: Number.NaN,
      }),
    }))
    await expect(malformedAuth.authenticate(attempt())).rejects.toSatisfy(
      (error: unknown) => codeOf(error) === 'authentication-unavailable',
    )
  })
})

describe('credential lifecycle dispatch', () => {
  it('dispatches supported operations by method and freezes detached results', async () => {
    const { auth } = await setup()
    const issue = vi.fn(async () => ({
      credentials: [{
        kind: 'access' as const,
        id: credentialId('access-1'),
        value: 'secret-access-token',
        tokenFamilyId: tokenFamilyId('family-1'),
      }],
    }))
    const refresh = vi.fn(async () => ({
      credentials: [{ kind: 'refresh' as const, id: credentialId('refresh-2'), value: 'secret-refresh-token' }],
    }))
    const inspect = vi.fn(async () => [{ id: credentialId('access-1'), kind: 'access' as const, active: true }])
    const revoke = vi.fn(async () => {})
    auth.providers.register('in-process', provider({
      credentials: { issue, refresh, inspect, revoke },
    }))
    const operation = { requestId: authenticationRequestId('operation-1'), signal: new AbortController().signal }

    const issued = await auth.credentials.issue(method, {
      ...operation,
      principal: { kind: 'user', id: userId('user-1') },
    })
    const refreshed = await auth.credentials.refresh(method, { ...operation, refreshToken: 'old-secret' })
    const inspected = await auth.credentials.inspect(method, {
      ...operation,
      target: { kind: 'credential', credentialId: credentialId('access-1') },
    })
    await auth.credentials.revoke(method, {
      ...operation,
      target: { kind: 'token-family', tokenFamilyId: tokenFamilyId('family-1') },
    })

    expect(issue).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    expect(inspect).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledOnce()
    expect(Object.isFrozen(issued)).toBe(true)
    expect(Object.isFrozen(issued.credentials[0])).toBe(true)
    expect(refreshed.credentials[0]?.kind).toBe('refresh')
    expect(Object.isFrozen(inspected[0])).toBe(true)
  })

  it('rejects unsupported operations and malformed secret-bearing output', async () => {
    const { auth } = await setup()
    auth.providers.register('in-process', provider())
    const operation = { requestId: authenticationRequestId('operation-1'), signal: new AbortController().signal }

    await expect(auth.credentials.issue(method, {
      ...operation,
      principal: { kind: 'user', id: userId('user-1') },
    })).rejects.toMatchObject({ code: 'credential-operation-unsupported' })

    const { auth: malformedAuth } = await setup()
    malformedAuth.providers.register('in-process', provider({
      credentials: {
        issue: async () => ({
          credentials: [{ kind: 'access', id: credentialId('access-1'), value: '' }],
        }),
      },
    }))
    await expect(malformedAuth.credentials.issue(method, {
      ...operation,
      principal: { kind: 'user', id: userId('user-1') },
    })).rejects.toMatchObject({ code: 'authentication-unavailable' })
  })
})
