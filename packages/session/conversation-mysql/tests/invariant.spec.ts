import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, it } from 'vitest'
import * as InvariantCompanion from '../src/invariant.ts'

describe('conversation MySQL invariant companion', () => {
  it('registers and releases package ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(InvariantCompanion)
    await fiber.dispose()
    await ctx.plugin(InvariantCompanion)
  })
})
