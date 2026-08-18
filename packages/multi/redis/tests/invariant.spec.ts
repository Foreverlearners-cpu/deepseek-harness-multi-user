import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as RedisInvariant from '../src/invariant.ts'

describe('Redis invariant companion', () => {
  it('releases its explained empty registration when disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(RedisInvariant)

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-redis', () => {})
    }).toThrow(/already registered/)
    await fiber.dispose()

    await expect(ctx.plugin(RedisInvariant).await()).resolves.toBeDefined()
    await ctx.fiber.dispose()
  })
})
