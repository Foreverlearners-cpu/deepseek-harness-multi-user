import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ElasticsearchInvariant from '../src/invariant.ts'

describe('Elasticsearch invariant companion', () => {
  it('registers its explained empty runtime invariant and unregisters on disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(ElasticsearchInvariant)

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-elasticsearch', () => {})
    }).toThrow(/already registered/)
    await fiber.dispose()

    const replacement = await ctx.plugin(ElasticsearchInvariant)
    await replacement.dispose()
    await ctx.fiber.dispose()
  })
})
