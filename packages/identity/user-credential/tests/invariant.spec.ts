import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import type { UserCredentialChangeEvent, UserId } from '../src/index.ts'
import * as CredentialInvariant from '../src/invariant.ts'
import { MemoryUserCredentialService } from './memory.ts'

const event: UserCredentialChangeEvent = { kind: 'password-set', userId: 'user-1' as UserId, revision: 1, time: 1 }

describe('user credential invariant companion', () => {
  it('accepts events while the userCredentials service is live', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(MemoryUserCredentialService)
    await ctx.plugin(CredentialInvariant)
    expect(() => { ctx.emit('user-credential/changed', event) }).not.toThrow()
  })

  it('rejects events without a live userCredentials service', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(CredentialInvariant)
    expect(() => { ctx.emit('user-credential/changed', event) }).toThrow(/without a live userCredentials service/)
  })
})
