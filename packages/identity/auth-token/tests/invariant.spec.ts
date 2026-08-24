import { Context } from '@deepseek-ai/cordis'
import { authenticationRequestId, tokenFamilyId, userId } from '@deepseek-ai/dsh-auth'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import type { AuthTokenChangeEvent } from '../src/index.ts'
import * as AuthTokenInvariant from '../src/invariant.ts'
import { MemoryAuthTokens } from './memory.ts'

const event: AuthTokenChangeEvent = {
  kind: 'issued',
  requestId: authenticationRequestId('request-1'),
  tokenFamilyId: tokenFamilyId('family-1'),
  principal: { kind: 'user', id: userId('user-1') },
  status: 'active',
  revision: 1,
  time: 1,
}

describe('auth-token invariant companion', () => {
  it('accepts token events while the service is live', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(MemoryAuthTokens)
    await ctx.plugin(AuthTokenInvariant)
    expect(() => { ctx.emit('auth-token/changed', event) }).not.toThrow()
  })

  it('rejects token events without a live service', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(AuthTokenInvariant)
    expect(() => { ctx.emit('auth-token/changed', event) }).toThrow(/without a live authTokens service/)
  })
})
