import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import * as AuthorityAclInvariant from '../src/invariant.ts'

describe('authority-acl invariant companion', () => {
  it('registers package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(AuthorityAclInvariant).await()).resolves.toBeDefined()
  })
})
