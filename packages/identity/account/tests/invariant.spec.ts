import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import * as AccountInvariant from '../src/invariant.ts'

describe('account invariant companion', () => {
  it('registers package ownership with its explained empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(AccountInvariant).await()).resolves.toBeDefined()
  })
})
