import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import * as StarterInvariant from '../src/invariant.ts'

describe('conversation starter invariant companion', () => {
  it('registers package ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(StarterInvariant).await()).resolves.toBeDefined()
  })
})
