import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/invariant.ts'

describe('conversation invariant companion', () => {
  it('registers and disposes package ownership', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(InvariantRegistry)
    const dispose = await apply(ctx)
    expect(() => apply(ctx)).toThrow('already registered')
    await (dispose as () => Promise<void>)()
    const second = await apply(ctx)
    await (second as () => Promise<void>)()
    await fiber.dispose()
  })
})
