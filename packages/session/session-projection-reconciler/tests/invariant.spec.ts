import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { apply } from '@deepseek-ai/dsh-session-projection-reconciler/invariant'
import { describe, expect, it } from 'vitest'

describe('session-projection-reconciler invariant companion', () => {
  it('registers and disposes package ownership', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(InvariantRegistry)
    const dispose = await apply(ctx)
    expect(() => apply(ctx)).toThrow('already registered')
    await dispose()
    const second = await apply(ctx)
    await second()
    await fiber.dispose()
  })
})
