import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as LocalAuthenticationInvariant from '../src/invariant.ts'

describe('authentication-local invariant companion', () => {
  it('registers its package-owned empty installer', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(LocalAuthenticationInvariant)
    await expect(fiber.await()).resolves.toBeDefined()
    await fiber.dispose()
    await expect(ctx.plugin(LocalAuthenticationInvariant).await()).resolves.toBeDefined()
  })
})
