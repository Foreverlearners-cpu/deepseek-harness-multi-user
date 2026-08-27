import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import * as AccountAuthorityInvariant from '../src/invariant.ts'

describe('account-authority invariant companion', () => {
  it('registers package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(AccountAuthorityInvariant).await()).resolves.toBeDefined()
  })
})
