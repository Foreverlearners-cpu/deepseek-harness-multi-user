import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as StaticAuthorizationInvariant from '../src/invariant.ts'

describe('authorization-static invariant companion', () => {
  it('registers its package-owned empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(StaticAuthorizationInvariant)
    await expect(fiber.await()).resolves.toBeDefined()
    await fiber.dispose()
    await expect(ctx.plugin(StaticAuthorizationInvariant).await()).resolves.toBeDefined()
  })
})
