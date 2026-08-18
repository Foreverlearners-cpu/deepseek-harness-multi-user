import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { describeApi, describeServices } from '../src/inspect.ts'

describe('Cordis API inspection', () => {
  it('omits model-hidden live services from service and API reports', async () => {
    const ctx = new Context()
    await ctx.plugin({
      name: 'mysql-test-provider',
      apply(providerContext) {
        providerContext.provide('mysql', {})
      },
    })

    try {
      const report = describeApi(ctx, [], undefined, [], [])
      expect(report.join('\n')).not.toContain('mysql')
      expect(describeServices(ctx, []).join('\n')).not.toContain('mysql')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
