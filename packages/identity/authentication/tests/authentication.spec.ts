import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthenticationProvider, {
  AuthenticationError,
  authenticationMethod,
  authenticationRequestId,
  isAuthenticatedCall,
  localPrincipalId,
  membershipId,
  operatorGrantId,
  serviceAccountId,
  tenantId,
  userId,
  type AuthenticatedCall,
  type AuthenticationAttempt,
  type VerifiedAuthentication,
} from '../src/index.ts'

interface FixtureConfig {
  readonly verified: VerifiedAuthentication
  readonly reject?: Error
}

class FixtureAuthentication extends AuthenticationProvider {
  readonly attempts: AuthenticationAttempt[] = []

  constructor(ctx: Context, private readonly config: FixtureConfig) {
    super(ctx)
  }

  protected verify(attempt: AuthenticationAttempt): Promise<VerifiedAuthentication> {
    this.attempts.push(attempt)
    if (this.config.reject !== undefined) return Promise.reject(this.config.reject)
    return Promise.resolve(this.config.verified)
  }
}

function localIdentity(expiresAt?: number): VerifiedAuthentication {
  return {
    principal: { kind: 'local', id: localPrincipalId('local-user') },
    method: authenticationMethod('fixture'),
    scope: {
      kind: 'tenant',
      tenantId: tenantId('tenant-1'),
      membershipId: membershipId('membership-1'),
    },
    ...(expiresAt === undefined ? {} : { expiresAt }),
  }
}

function attempt(id = 'request-1', signal = new AbortController().signal): AuthenticationAttempt {
  return {
    requestId: authenticationRequestId(id),
    channel: 'in-process',
    evidence: { kind: 'in-process' },
    signal,
  }
}

async function boot(verified: VerifiedAuthentication = localIdentity()): Promise<{
  ctx: Context
  provider: FixtureAuthentication
}> {
  const ctx = new Context()
  await ctx.plugin(FixtureAuthentication, { verified })
  return { ctx, provider: ctx.authentication as FixtureAuthentication }
}

describe('authentication identifiers', () => {
  it('brands every supported identity kind', () => {
    expect(authenticationRequestId('request_1')).toBe('request_1')
    expect(userId('user-1')).toBe('user-1')
    expect(serviceAccountId('service.1')).toBe('service.1')
    expect(localPrincipalId('local~1')).toBe('local~1')
    expect(tenantId('tenant-1')).toBe('tenant-1')
    expect(membershipId('membership-1')).toBe('membership-1')
    expect(operatorGrantId('operator-1')).toBe('operator-1')
    expect(authenticationMethod('oidc')).toBe('oidc')
  })

  it.each(['', '-leading', 'white space', 'x'.repeat(129)])('rejects invalid ids %j', (value) => {
    for (const brand of [
      authenticationRequestId,
      userId,
      serviceAccountId,
      localPrincipalId,
      tenantId,
      membershipId,
      operatorGrantId,
      authenticationMethod,
    ]) {
      expect(() => brand(value)).toThrow(TypeError)
    }
  })
})

describe('AuthenticationProvider', () => {
  it('mints a deeply immutable call bound to the trusted attempt', async () => {
    const { provider } = await boot()
    const signal = new AbortController().signal
    const call = await provider.authenticate(attempt('request-frozen', signal))

    expect(call).toMatchObject({
      requestId: 'request-frozen',
      channel: 'in-process',
      principal: { kind: 'local', id: 'local-user' },
      method: 'fixture',
      scope: { kind: 'tenant', tenantId: 'tenant-1', membershipId: 'membership-1' },
      signal,
    })
    expect(Object.isFrozen(call)).toBe(true)
    expect(Object.isFrozen(call.principal)).toBe(true)
    expect(Object.isFrozen(call.scope)).toBe(true)
    expect(isAuthenticatedCall(call)).toBe(true)
    expect(provider.owns(call)).toBe(true)
    expect(() => {
      (call.principal as { kind: string }).kind = 'user'
    }).toThrow(TypeError)
  })

  it('rejects structural copies and JSON round trips', async () => {
    const { provider } = await boot()
    const call = await provider.authenticate(attempt())
    const copy = { ...call } as AuthenticatedCall
    const roundTrip = JSON.parse(JSON.stringify(call)) as AuthenticatedCall

    expect(isAuthenticatedCall(copy)).toBe(false)
    expect(isAuthenticatedCall(roundTrip)).toBe(false)
    expect(isAuthenticatedCall(null)).toBe(false)
    expect(isAuthenticatedCall('request-1')).toBe(false)
    expect(provider.owns(copy)).toBe(false)
    expect(provider.owns(roundTrip)).toBe(false)
  })

  it('does not accept a call issued by another Provider instance', async () => {
    const first = await boot()
    const second = await boot()
    const call = await first.provider.authenticate(attempt('other-provider'))

    expect(first.provider.owns(call)).toBe(true)
    expect(second.provider.owns(call)).toBe(false)
  })

  it('copies Provider-owned principal and scope objects before freezing', async () => {
    const verified = localIdentity()
    const { provider } = await boot(verified)
    const call = await provider.authenticate(attempt())

    expect(call.principal).not.toBe(verified.principal)
    expect(call.scope).not.toBe(verified.scope)
  })

  it('preserves Provider verification failures without minting a call', async () => {
    const failure = new Error('invalid token')
    const ctx = new Context()
    await ctx.plugin(FixtureAuthentication, { verified: localIdentity(), reject: failure })
    const provider = ctx.authentication as FixtureAuthentication

    await expect(provider.authenticate(attempt())).rejects.toBe(failure)
    expect(provider.attempts).toHaveLength(1)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects a non-finite credential expiry %s',
    async (expiresAt) => {
      const { provider } = await boot(localIdentity(expiresAt))
      await expect(provider.authenticate(attempt())).rejects.toMatchObject({
        name: 'AuthenticationError',
        code: 'authentication-unavailable',
      })
    },
  )

  it('supports the user, service-account, and platform principal vocabulary', async () => {
    const identities: VerifiedAuthentication[] = [
      {
        principal: { kind: 'user', id: userId('user-1') },
        method: authenticationMethod('oidc'),
        scope: {
          kind: 'tenant',
          tenantId: tenantId('tenant-1'),
          membershipId: membershipId('membership-1'),
        },
      },
      {
        principal: { kind: 'service-account', id: serviceAccountId('service-1') },
        method: authenticationMethod('token'),
        scope: { kind: 'platform', operatorGrantId: operatorGrantId('operator-1') },
      },
    ]

    for (const [index, verified] of identities.entries()) {
      const { provider } = await boot(verified)
      const call = await provider.authenticate(attempt(`request-${String(index)}`))
      expect(call.principal).toEqual(verified.principal)
      expect(call.scope).toEqual(verified.scope)
    }
  })
})

describe('AuthenticationError', () => {
  it('retains its public code and contained cause', () => {
    const cause = new Error('provider offline')
    const error = new AuthenticationError(
      'authentication-unavailable',
      'authentication failed',
      { cause },
    )
    expect(error).toMatchObject({
      name: 'AuthenticationError',
      code: 'authentication-unavailable',
      message: 'authentication failed',
      cause,
    })
  })
})
