import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SessionSearchProjectionInvariant from '../src/invariant.ts'

describe('session search projection Elasticsearch invariant companion', () => {
  it('registers its explained empty runtime invariant and unregisters on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(SessionSearchProjectionInvariant)

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-session-search-projection-elasticsearch', () => {})
    }).toThrow(/already registered/)
    await fiber.dispose()
    const disposeReplacement = ctx.invariants.register(
      '@deepseek-ai/dsh-session-search-projection-elasticsearch',
      () => {},
    )
    expect(disposeReplacement).toEqual(expect.any(Function))
    disposeReplacement()
    await ctx.fiber.dispose()
  })
})
