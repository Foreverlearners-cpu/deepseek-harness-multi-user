import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import * as AuthRbacInvariant from '../src/invariant.ts'

describe('auth-rbac invariant companion', () => {
  it('registers package ownership with an empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(AuthRbacInvariant).await()).resolves.toBeDefined()
  })
})
