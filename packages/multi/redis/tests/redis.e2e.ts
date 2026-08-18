import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Redis from '../src/index.ts'

const target = process.env.DSH_REDIS_TEST_URL
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe.skipIf(target === undefined)('real Redis connection', () => {
  it('boots the service and runs PING through its callback', async () => {
    ctx = new Context()
    await ctx.plugin(Redis, { url: target! })

    await expect(ctx.redis.withClient(async client => client.ping())).resolves.toBe('PONG')
  })
})
