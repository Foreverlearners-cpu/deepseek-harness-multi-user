import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SERVICE_API } from '../src/api-catalog.ts'
import { describeApi, describeServices } from '../src/inspect.ts'

describe('Cordis API inspection', () => {
  it('omits model-hidden live services from service and API reports', async () => {
    const ctx = new Context()
    await ctx.plugin({
      name: 'hidden-service-test-provider',
      apply(providerContext) {
        providerContext.provide('mysql', {})
        providerContext.provide('cdc', {})
      },
    })

    try {
      const report = describeApi(ctx, [], undefined, [], [])
      expect(report.join('\n')).not.toContain('mysql')
      expect(report.join('\n')).not.toContain('cdc')
      expect(describeServices(ctx, []).join('\n')).not.toContain('mysql')
      expect(describeServices(ctx, []).join('\n')).not.toContain('cdc')
      expect(SERVICE_API.map(service => service.key)).not.toContain('cdc')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
