import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as Invariant from '../src/invariant.ts'

describe('session CDC starter invariant', () => {
  it('registers and disposes package ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(Invariant)
    expect(() => ctx.invariants.register('@deepseek-ai/dsh-session-cdc-starter', () => {})).toThrow(/already registered/u)
    await fiber.dispose()
    const dispose = ctx.invariants.register('@deepseek-ai/dsh-session-cdc-starter', () => {})
    dispose()
    await ctx.fiber.dispose()
  })
})
