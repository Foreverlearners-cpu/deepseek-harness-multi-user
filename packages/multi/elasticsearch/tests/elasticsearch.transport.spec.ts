import { createServer } from 'node:http'
import { inspect } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ElasticsearchService from '../src/index.ts'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElasticsearchAuthConfig } from '../src/index.ts'

interface ObservedRequest {
  method: string | undefined
  url: string | undefined
  authorization: string | undefined
}

const INFO_RESPONSE = {
  name: 'test-node',
  cluster_name: 'dsh-test',
  cluster_uuid: 'dsh-test-cluster',
  version: {
    number: '9.5.0',
    build_flavor: 'default',
    build_type: 'tar',
    build_hash: 'test-build',
    build_date: '2026-08-18T00:00:00.000Z',
    build_snapshot: false,
    lucene_version: '10.3.1',
    minimum_wire_compatibility_version: '8.19.0',
    minimum_index_compatibility_version: '8.0.0',
  },
  tagline: 'You Know, for Search',
}

let server: Server | undefined
let ctx: Context | undefined
let requests: ObservedRequest[]

beforeEach(() => {
  requests = []
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (server === undefined) return
  const closing = new Promise<void>((resolve, reject) => {
    server!.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  server.closeAllConnections()
  await closing
  server = undefined
})

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'x-elastic-product': 'Elasticsearch',
  })
  response.end(JSON.stringify(body))
}

async function listen(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  server = createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
    })
    handle(request, response)
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${String(address.port)}`
}

function sendSuccessfulResponse(request: IncomingMessage, response: ServerResponse): void {
  if (request.method === 'HEAD') {
    response.writeHead(200, { 'x-elastic-product': 'Elasticsearch' })
    response.end()
    return
  }
  sendJson(response, 200, INFO_RESPONSE)
}

async function boot(node: string, auth?: ElasticsearchAuthConfig, pingTimeoutMs = 500): Promise<Context> {
  ctx = new Context()
  await ctx.plugin(ElasticsearchService, {
    node,
    ...(auth === undefined ? {} : { auth }),
    allowInsecureHttp: true,
    maxRetries: 0,
    requestTimeoutMs: 500,
    pingTimeoutMs,
  })
  return ctx
}

describe('ElasticsearchService official transport', () => {
  it('boots and reads cluster information through the official client', async () => {
    const node = await listen(sendSuccessfulResponse)
    const context = await boot(node)

    await expect(context.elasticsearch.operation(async client => client.info()))
      .resolves.toMatchObject({ version: { number: '9.5.0' } })
    expect(requests.map(request => [request.method, request.url])).toEqual([
      ['HEAD', '/'],
      ['GET', '/'],
    ])
  })

  it.each([
    [
      { username: 'dsh', password: 'test-only' },
      `Basic ${Buffer.from('dsh:test-only').toString('base64')}`,
    ],
    [{ apiKey: 'encoded-api-key' }, 'ApiKey encoded-api-key'],
    [{ bearer: 'service-token' }, 'Bearer service-token'],
  ] satisfies Array<[ElasticsearchAuthConfig, string]>)('sends the configured authentication strategy', async (
    auth,
    expected,
  ) => {
    const node = await listen(sendSuccessfulResponse)
    await boot(node, auth)

    expect(requests[0]?.authorization).toBe(expected)
  })

  it('preserves a reverse-proxy path prefix for startup and requests', async () => {
    const origin = await listen(sendSuccessfulResponse)
    const context = await boot(`${origin}/elasticsearch/proxy`)

    await context.elasticsearch.operation(async client => client.info())
    expect(requests.map(request => request.url)).toEqual([
      '/elasticsearch/proxy/',
      '/elasticsearch/proxy/',
    ])
  })

  it('aborts a stalled startup ping under the configured timeout', async () => {
    const node = await listen(() => {})
    ctx = new Context()

    await expect(ctx.plugin(ElasticsearchService, {
      node,
      allowInsecureHttp: true,
      maxRetries: 0,
      requestTimeoutMs: 1_000,
      pingTimeoutMs: 100,
    })).rejects.toThrow()
    expect(requests).toHaveLength(1)
  })

  it('rejects a negative startup ping response', async () => {
    const node = await listen((_request, response) => {
      response.writeHead(404, { 'x-elastic-product': 'Elasticsearch' })
      response.end()
    })

    await expect(boot(node)).rejects.toThrow('elasticsearch: startup ping failed')
    expect(requests.map(request => [request.method, request.url])).toEqual([['HEAD', '/']])
  })

  it.each([
    [
      'API key',
      { apiKey: 'transport-api-key-secret' },
      'transport-api-key-secret',
      'ApiKey transport-api-key-secret',
    ],
    [
      'bearer',
      { bearer: 'transport-bearer-secret' },
      'transport-bearer-secret',
      'Bearer transport-bearer-secret',
    ],
    [
      'basic',
      { username: 'dsh', password: 'transport-password-secret' },
      'transport-password-secret',
      `Basic ${Buffer.from('dsh:transport-password-secret').toString('base64')}`,
    ],
  ] satisfies Array<[string, ElasticsearchAuthConfig, string, string]>)('redacts %s authentication from official-client error metadata', async (
    _strategy,
    auth,
    secret,
    expectedAuthorization,
  ) => {
    const node = await listen((request, response) => {
      if (request.method === 'HEAD') {
        sendSuccessfulResponse(request, response)
        return
      }
      sendJson(response, 401, {
        error: { type: 'security_exception', reason: 'authentication failed' },
        status: 401,
      })
    })
    const context = await boot(node, auth)

    const failure = await context.elasticsearch.operation(async client => client.info())
      .then(() => undefined, (error: unknown) => error)
    const metadata = inspect(failure, { depth: 12 })

    expect(failure).toBeInstanceOf(Error)
    expect(requests.at(-1)?.authorization).toBe(expectedAuthorization)
    expect(metadata).not.toContain(secret)
    expect(metadata).not.toContain(expectedAuthorization)
    expect(metadata).toContain('[redacted]')
  })
})
