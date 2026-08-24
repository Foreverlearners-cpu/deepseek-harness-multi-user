import { Context } from '@deepseek-ai/cordis'
import { authenticationRequestId, userId } from '@deepseek-ai/dsh-auth'
import { describe, expect, it, vi } from 'vitest'
import { AuthTokenError, MAX_REFRESH_TOKEN_BYTES } from '../src/index.ts'
import { runAuthTokenContract } from './contract.ts'
import { MemoryAuthTokens } from './memory.ts'

async function setup(): Promise<{ ctx: Context; authTokens: MemoryAuthTokens; setTime(value: number): void }> {
  const ctx = new Context()
  await ctx.plugin(MemoryAuthTokens)
  const authTokens = ctx.authTokens as MemoryAuthTokens
  return { ctx, authTokens, setTime: (value) => { authTokens.setTime(value) } }
}

runAuthTokenContract('memory', setup)

const requestId = authenticationRequestId('request-1')
const principal = { kind: 'user' as const, id: userId('user-1') }

describe('auth-token validation and containment', () => {
  it('rejects invalid operations before Provider mutation', async () => {
    const { authTokens } = await setup()
    const aborted = new AbortController()
    aborted.abort()
    await expect(authTokens.issueFamily({ requestId, signal: aborted.signal, principal, expiresAt: 2_000 }))
      .rejects.toMatchObject({ code: 'operation-cancelled' })
    await expect(authTokens.issueFamily({ requestId, signal: new AbortController().signal, principal, expiresAt: 1_000 }))
      .rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authTokens.rotate({
      requestId,
      signal: new AbortController().signal,
      refreshToken: 'wrong',
      expiresAt: 2_000,
    })).rejects.toMatchObject({ code: 'refresh-token-invalid' })
    await expect(authTokens.rotate({
      requestId,
      signal: new AbortController().signal,
      refreshToken: `dsh_rt_${'界'.repeat(MAX_REFRESH_TOKEN_BYTES)}`,
      expiresAt: 2_000,
    })).rejects.toMatchObject({ code: 'refresh-token-invalid' })
  })

  it('contains listener failures and still notifies later listeners', async () => {
    const { ctx, authTokens } = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const observed = vi.fn()
    ctx.on('auth-token/changed', () => { throw new Error('listener failed') })
    ctx.on('auth-token/changed', observed)
    await authTokens.issueFamily({
      requestId,
      signal: new AbortController().signal,
      principal,
      expiresAt: 2_000,
    })
    expect(observed).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalled()
  })

  it('never loses a committed refresh secret when an invariant listener throws', async () => {
    const { ctx, authTokens } = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    ctx.on('auth-token/changed', () => { throw Object.assign(new Error('invariant'), { code: 'INVARIANT' }) })
    await expect(authTokens.issueFamily({
      requestId,
      signal: new AbortController().signal,
      principal,
      expiresAt: 2_000,
    })).resolves.toHaveProperty('refreshToken.value')
    expect(warn).toHaveBeenCalled()
  })

  it('preserves stable errors and causes', () => {
    const cause = new Error('storage detail')
    expect(new AuthTokenError('provider-unavailable', 'safe', { cause })).toMatchObject({
      name: 'AuthTokenError',
      code: 'provider-unavailable',
      message: 'safe',
      cause,
    })
  })
})
