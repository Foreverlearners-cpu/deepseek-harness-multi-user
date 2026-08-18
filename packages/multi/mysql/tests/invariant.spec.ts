import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as MysqlInvariant from '../src/invariant.ts'

describe('MySQL invariant companion', () => {
  it('registers its explained empty runtime invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(MysqlInvariant)

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-mysql', () => {})
    }).toThrow(/already registered/)
    await fiber.dispose()
    const disposeReplacement = ctx.invariants.register('@deepseek-ai/dsh-mysql', () => {})
    expect(disposeReplacement).toEqual(expect.any(Function))
    disposeReplacement()
    await ctx.fiber.dispose()
  })
})
