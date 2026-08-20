import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  type AuthenticationError,
  authenticationRequestId,
  isAuthenticatedCall,
} from '@deepseek-ai/dsh-authentication'
import LocalAuthenticationProvider from '../src/index.ts'

const CONFIG = {
  principalId: 'local-user',
  tenantId: 'tenant-1',
  membershipId: 'membership-1',
}

describe('LocalAuthenticationProvider', () => {
  it('mints the explicitly configured local tenant identity for Host carriers', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalAuthenticationProvider, CONFIG)
    const signal = new AbortController().signal
    const call = await ctx.authentication.authenticate({
      requestId: authenticationRequestId('local-request'),
      channel: 'http',
      evidence: { kind: 'http', request: new Request('http://localhost/api') },
      signal,
    })

    expect(call).toMatchObject({
      requestId: 'local-request',
      channel: 'http',
      principal: { kind: 'local', id: 'local-user' },
      method: 'local',
      scope: { kind: 'tenant', tenantId: 'tenant-1', membershipId: 'membership-1' },
      signal,
    })
    expect(isAuthenticatedCall(call)).toBe(true)
    expect(ctx.authentication.localOnly).toBe(true)
  })

  it('rejects HTTP authorities outside loopback instead of deriving trust from reachability', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalAuthenticationProvider, CONFIG)

    await expect(ctx.authentication.authenticate({
      requestId: authenticationRequestId('remote-request'),
      channel: 'http',
      evidence: {
        kind: 'http',
        request: new Request('http://dsh.internal/api', { headers: { host: 'harness.internal:3080' } }),
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: 'unauthenticated',
    } satisfies Partial<AuthenticationError>)
  })

  it('continues to authenticate explicit in-process calls', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalAuthenticationProvider, CONFIG)

    await expect(ctx.authentication.authenticate({
      requestId: authenticationRequestId('in-process-request'),
      channel: 'in-process',
      evidence: { kind: 'in-process' },
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ principal: { kind: 'local', id: 'local-user' } })
  })

  it.each(['localhost', '127.42.0.9', '[::1]'])(
    'accepts the normalized loopback authority %s',
    async (authority) => {
      const ctx = new Context()
      await ctx.plugin(LocalAuthenticationProvider, CONFIG)

      await expect(ctx.authentication.authenticate({
        requestId: authenticationRequestId(`loopback-${authority.replaceAll(/[^A-Za-z0-9]/gu, '-')}`),
        channel: 'http',
        evidence: {
          kind: 'http',
          request: new Request(`http://${authority}/api`, { headers: { host: authority } }),
        },
        signal: new AbortController().signal,
      })).resolves.toMatchObject({ principal: { kind: 'local' } })
    },
  )

  it.each([
    [{ ...CONFIG, principalId: '' }, 'principal'],
    [{ ...CONFIG, tenantId: 'not valid' }, 'tenant'],
    [{ ...CONFIG, membershipId: '-invalid' }, 'membership'],
  ])('fails activation for an invalid explicit %s id', async (config, _field) => {
    const ctx = new Context()
    await expect(ctx.plugin(LocalAuthenticationProvider, config).await()).rejects.toThrow(TypeError)
    expect(ctx.get('authentication')).toBeUndefined()
  })
})
