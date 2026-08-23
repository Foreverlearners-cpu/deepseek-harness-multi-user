import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import AuthenticationRuntime, { authenticationRequestId } from '../src/index.ts'
import * as AuthInvariant from '../src/invariant.ts'

const record = {
  requestId: authenticationRequestId('request-1'),
  channel: 'in-process' as const,
  evidenceKind: 'in-process' as const,
  outcome: 'failed' as const,
  reason: 'unauthenticated' as const,
  time: Date.now(),
}

describe('auth invariant companion', () => {
  it('accepts authentication events while the auth service is live', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(AuthenticationRuntime)
    await ctx.plugin(AuthInvariant)

    expect(() => { ctx.emit('auth/result', record) }).not.toThrow()
  })

  it('rejects authentication events without a live auth service', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(AuthInvariant)

    expect(() => { ctx.emit('auth/result', record) }).toThrow(/without a live auth service/)
  })
})
