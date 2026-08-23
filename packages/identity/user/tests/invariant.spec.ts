import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import * as UserInvariant from '../src/invariant.ts'

describe('user invariant companion', () => {
  it('registers the user package invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(UserInvariant)
    expect(ctx.invariants).toBeDefined()
  })
})
