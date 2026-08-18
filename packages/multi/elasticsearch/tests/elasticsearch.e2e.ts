import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ElasticsearchService from '../src/index.ts'
import type { ElasticsearchAuthConfig } from '../src/index.ts'

const target = process.env.DSH_ELASTICSEARCH_TEST_URL
const caFingerprint = process.env.DSH_ELASTICSEARCH_TEST_CA_FINGERPRINT
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe.skipIf(target === undefined)('real Elasticsearch connection', () => {
  it('boots the service and reads cluster information through an operation', async () => {
    let url: URL
    try {
      url = new URL(target!)
    } catch {
      throw new Error('DSH_ELASTICSEARCH_TEST_URL must be a valid absolute URL')
    }

    const hasUsername = url.username.length > 0
    const hasPassword = url.password.length > 0
    if (hasUsername !== hasPassword) {
      throw new Error('DSH_ELASTICSEARCH_TEST_URL must contain both a username and password')
    }
    const auth: ElasticsearchAuthConfig | undefined = hasUsername
      ? {
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      }
      : undefined
    url.username = ''
    url.password = ''

    ctx = new Context()
    await ctx.plugin(ElasticsearchService, {
      node: url.toString(),
      ...(auth === undefined ? {} : { auth }),
      ...(caFingerprint === undefined ? {} : { caFingerprint }),
      allowInsecureHttp: url.protocol === 'http:',
      maxRetries: 0,
      requestTimeoutMs: 5000,
      pingTimeoutMs: 5000,
    })

    const info = await ctx.elasticsearch.operation(async client => client.info())
    expect(info.version.number).toMatch(/^\d+\./)
  })
})
