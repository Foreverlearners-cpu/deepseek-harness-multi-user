import { Context } from '@deepseek-ai/cordis'
import { InvariantService } from '@deepseek-ai/dsh-invariants'
import { apply } from '@deepseek-ai/dsh-kafka-events/invariant'
import { describe, expect, it } from 'vitest'

describe('kafka-events invariant companion', () => {
  it('registers and disposes package ownership', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(InvariantService)
    const dispose = await apply(ctx)
    expect(ctx.invariants.packages()).toContain('@deepseek-ai/dsh-kafka-events')
    await dispose()
    expect(ctx.invariants.packages()).not.toContain('@deepseek-ai/dsh-kafka-events')
    await fiber.dispose()
  })
})
