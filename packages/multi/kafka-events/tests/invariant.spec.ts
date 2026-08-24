import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { apply } from '@deepseek-ai/dsh-kafka-events/invariant'
import { describe, expect, it } from 'vitest'

describe('kafka-events invariant companion', () => {
  it('registers and disposes package ownership', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(InvariantRegistry)
    const dispose = await apply(ctx)
    expect(() => ctx.invariants.register(
      '@deepseek-ai/dsh-kafka-events',
      () => {},
    )).toThrow(/already registered/u)
    await dispose()
    const disposeAgain = ctx.invariants.register(
      '@deepseek-ai/dsh-kafka-events',
      () => {},
    )
    disposeAgain()
    await fiber.dispose()
  })
})
