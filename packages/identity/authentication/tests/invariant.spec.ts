import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as AuthenticationInvariant from '../src/invariant.ts'

describe('authentication invariant companion', () => {
  it('registers its explained empty installer for exactly one fiber lifetime', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(AuthenticationInvariant)
    await expect(fiber.await()).resolves.toBeDefined()
    await expect(ctx.plugin(AuthenticationInvariant).await()).rejects.toThrow('already registered')
    await fiber.dispose()
    await expect(ctx.plugin(AuthenticationInvariant).await()).resolves.toBeDefined()
  })
})
