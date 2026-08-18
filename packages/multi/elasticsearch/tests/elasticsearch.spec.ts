import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import ElasticsearchService from '../src/index.ts'
import type { ElasticsearchAuthConfig, ElasticsearchClient } from '../src/index.ts'

const clientState = vi.hoisted(() => ({
  constructor: vi.fn<(options: unknown) => void>(),
  ping: vi.fn<(
    params?: Record<string, never>,
    options?: { requestTimeout?: number; maxRetries?: number; signal?: AbortSignal },
  ) => Promise<boolean>>(),
  close: vi.fn<() => Promise<void>>(),
}))

vi.mock('@elastic/elasticsearch', () => ({
  Client: class FakeClient {
    constructor(options: unknown) {
      clientState.constructor(options)
    }

    ping(
      params?: Record<string, never>,
      options?: { requestTimeout?: number; maxRetries?: number; signal?: AbortSignal },
    ): Promise<boolean> {
      return clientState.ping(params, options)
    }

    close(): Promise<void> {
      return clientState.close()
    }
  },
}))

const CONFIG = {
  node: 'https://search.internal:9200',
  maxRetries: 2,
  requestTimeoutMs: 15_000,
  pingTimeoutMs: 2_000,
}

const HEX_FINGERPRINT = 'a1'.repeat(32)
const COLON_FINGERPRINT = Array.from({ length: 32 }, () => 'B2').join(':')

const contexts: Context[] = []

beforeEach(() => {
  clientState.constructor.mockReset()
  clientState.ping.mockReset().mockResolvedValue(true)
  clientState.close.mockReset().mockResolvedValue(undefined)
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
})

async function boot(config: typeof CONFIG & Record<string, unknown> = CONFIG): Promise<{
  ctx: Context
  fiber: ReturnType<Context['plugin']>
}> {
  const ctx = new Context()
  contexts.push(ctx)
  const fiber = ctx.plugin(ElasticsearchService, config)
  await fiber
  return { ctx, fiber }
}

describe('ElasticsearchService', () => {
  it.each([undefined, {}])('accepts omitted or empty authentication during direct construction', (auth) => {
    const ctx = new Context()
    contexts.push(ctx)

    new ElasticsearchService(ctx, {
      ...CONFIG,
      ...(auth === undefined ? {} : { auth }),
    })

    const options: unknown = clientState.constructor.mock.calls[0]?.[0]
    expect(options).not.toHaveProperty('auth')
  })

  it('constructs the client, verifies startup, and returns operation results', async () => {
    const { ctx, fiber } = await boot()

    expect(clientState.constructor).toHaveBeenCalledWith({
      node: CONFIG.node,
      maxRetries: CONFIG.maxRetries,
      requestTimeout: CONFIG.requestTimeoutMs,
      pingTimeout: CONFIG.pingTimeoutMs,
      redaction: { type: 'replace' },
    })
    expect(clientState.ping.mock.calls[0]?.[0]).toEqual({})
    const pingOptions = clientState.ping.mock.calls[0]?.[1]
    expect(pingOptions?.requestTimeout).toBe(CONFIG.pingTimeoutMs)
    expect(pingOptions?.maxRetries).toBe(0)
    expect(pingOptions?.signal).toBeInstanceOf(AbortSignal)

    await expect(ctx.elasticsearch.operation(async client => client.constructor.name))
      .resolves.toBe('FakeClient')

    await fiber.dispose()
    expect(clientState.close).toHaveBeenCalledOnce()
  })

  it.each([
    [{ username: 'dsh', password: 'test-only' }, { username: 'dsh', password: 'test-only' }],
    [{ apiKey: 'encoded-key' }, { apiKey: 'encoded-key' }],
    [{ bearer: 'service-token' }, { bearer: 'service-token' }],
  ])('forwards one authentication strategy', async (auth, expected) => {
    await boot({ ...CONFIG, auth })
    expect(clientState.constructor).toHaveBeenCalledWith(expect.objectContaining({ auth: expected }))
  })

  it.each([HEX_FINGERPRINT, COLON_FINGERPRINT])('forwards a valid HTTPS CA fingerprint', async (fingerprint) => {
    await boot({ ...CONFIG, caFingerprint: fingerprint })
    expect(clientState.constructor).toHaveBeenCalledWith(expect.objectContaining({ caFingerprint: fingerprint }))
  })

  it('permits explicitly trusted plaintext HTTP', async () => {
    await boot({ ...CONFIG, node: 'http://127.0.0.1:9200', allowInsecureHttp: true })
    expect(clientState.constructor).toHaveBeenCalledWith(expect.objectContaining({
      node: 'http://127.0.0.1:9200',
    }))
  })

  it.each([
    [{ ...CONFIG, node: 'not a url' }, /valid absolute URL/],
    [{ ...CONFIG, node: 'ftp://search.internal' }, /must use http or https/],
    [{ ...CONFIG, node: 'https://user:secret@search.internal' }, /must not contain credentials/],
    [{ ...CONFIG, node: 'https://:secret@search.internal' }, /must not contain credentials/],
    [{ ...CONFIG, node: 'https://search.internal/proxy?token=ignored' }, /query or fragment/],
    [{ ...CONFIG, node: 'https://search.internal/proxy#fragment' }, /query or fragment/],
    [{ ...CONFIG, node: 'https://search.internal/proxy?token=ignored#fragment' }, /query or fragment/],
    [{ ...CONFIG, node: 'https://search.internal/proxy?' }, /query or fragment/],
    [{ ...CONFIG, node: 'https://search.internal/proxy#' }, /query or fragment/],
    [{ ...CONFIG, node: 'https://search.internal/proxy?#' }, /query or fragment/],
    [{ ...CONFIG, node: 'http://search.internal' }, /allowInsecureHttp/],
    [{ ...CONFIG, node: 'http://search.internal', allowInsecureHttp: true, caFingerprint: 'AA' }, /requires an HTTPS/],
    [{ ...CONFIG, auth: { username: 'dsh' } }, /configured together/],
    [{ ...CONFIG, auth: { password: 'test-only' } }, /configured together/],
    [{ ...CONFIG, auth: { apiKey: 'key', bearer: 'token' } }, /exactly one/],
    [{ ...CONFIG, auth: { username: 'dsh', password: 'test-only', apiKey: 'key' } }, /exactly one/],
    [{ ...CONFIG, auth: { username: 'dsh', password: 'test-only', bearer: 'token' } }, /exactly one/],
    [{
      ...CONFIG,
      auth: { username: 'dsh', password: 'test-only', apiKey: 'key', bearer: 'token' },
    }, /exactly one/],
  ])('rejects invalid connection configuration', async (config, message) => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(ElasticsearchService, config)).rejects.toThrow(message)
    expect(clientState.constructor).not.toHaveBeenCalled()
  })

  it('preserves a path prefix in the node URL', async () => {
    const node = 'https://search.internal/elasticsearch/proxy/'
    await boot({ ...CONFIG, node })
    expect(clientState.constructor).toHaveBeenCalledWith(expect.objectContaining({ node }))
  })

  it.each([
    ['api_key', 'hidden-api-key'],
    ['apikey', 'hidden-api-key'],
    ['token', 'hidden-token'],
  ])('rejects unsupported authentication field %s without exposing its value', async (field, value) => {
    const ctx = new Context()
    contexts.push(ctx)
    const activation = ctx.plugin(ElasticsearchService, {
      ...CONFIG,
      auth: { [field]: value },
    })

    await expect(activation).rejects.toThrow(`unsupported auth field ${JSON.stringify(field)}`)
    await expect(activation).rejects.not.toThrow(value)
    expect(clientState.constructor).not.toHaveBeenCalled()
  })

  it('rejects unsupported authentication fields even beside a valid strategy', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const auth: ElasticsearchAuthConfig & { api_key: string } = {
      apiKey: 'valid-key',
      api_key: 'ignored-key',
    }

    await expect(ctx.plugin(ElasticsearchService, {
      ...CONFIG,
      auth,
    })).rejects.toThrow('unsupported auth field "api_key"')
    expect(clientState.constructor).not.toHaveBeenCalled()
  })

  it.each([
    '',
    'AA:BB:CC',
    'g1'.repeat(32),
    Array.from({ length: 32 }, () => 'AA').join('-'),
  ])('rejects malformed CA fingerprint %j', async (caFingerprint) => {
    const ctx = new Context()
    contexts.push(ctx)

    await expect(ctx.plugin(ElasticsearchService, { ...CONFIG, caFingerprint })).rejects.toThrow()
    expect(clientState.constructor).not.toHaveBeenCalled()
  })

  it('accepts the largest safe ping timeout and does not cap request timeout', async () => {
    await boot({
      ...CONFIG,
      pingTimeoutMs: MAX_TIMER_DELAY_MS,
      requestTimeoutMs: MAX_TIMER_DELAY_MS + 1,
    })
    expect(clientState.constructor).toHaveBeenCalledWith(expect.objectContaining({
      pingTimeout: MAX_TIMER_DELAY_MS,
      requestTimeout: MAX_TIMER_DELAY_MS + 1,
    }))
  })

  it('rejects a ping timeout above the Node timer limit before client construction', async () => {
    const ctx = new Context()
    contexts.push(ctx)

    await expect(ctx.plugin(ElasticsearchService, {
      ...CONFIG,
      pingTimeoutMs: MAX_TIMER_DELAY_MS + 1,
    })).rejects.toThrow()
    expect(clientState.constructor).not.toHaveBeenCalled()
  })

  it.each([
    { username: '', password: 'test-only' },
    { username: 'dsh', password: '' },
    { apiKey: '' },
    { bearer: '' },
  ])('rejects an empty authentication field', async (auth) => {
    const ctx = new Context()
    contexts.push(ctx)

    await expect(ctx.plugin(ElasticsearchService, { ...CONFIG, auth })).rejects.toThrow()
    expect(clientState.constructor).not.toHaveBeenCalled()
  })

  it('propagates callback failures and remains usable', async () => {
    const { ctx } = await boot()

    await expect(ctx.elasticsearch.operation(() => {
      throw new Error('query failed')
    })).rejects.toThrow('query failed')
    await expect(ctx.elasticsearch.operation(() => 'available')).resolves.toBe('available')
  })

  it('drains admitted callbacks before closing and rejects late work', async () => {
    const { ctx, fiber } = await boot()
    const service = ctx.elasticsearch
    const entered = Promise.withResolvers<undefined>()
    const unblock = Promise.withResolvers<undefined>()
    const running = service.operation(async () => {
      entered.resolve(undefined)
      await unblock.promise
    })
    await entered.promise

    const disposing = fiber.dispose()
    await expect(service.operation(() => 'late')).rejects.toThrow(/closing or closed/)
    await Promise.resolve()
    expect(clientState.close).not.toHaveBeenCalled()
    unblock.resolve(undefined)
    await running
    await disposing

    expect(clientState.close).toHaveBeenCalledOnce()
    await expect(service.operation(() => 'later')).rejects.toThrow(/closing or closed/)
  })

  it('drains concurrent callbacks that complete out of admission order', async () => {
    const { ctx, fiber } = await boot()
    const releases = Array.from({ length: 3 }, () => Promise.withResolvers<undefined>())
    const entered = Array.from({ length: 3 }, () => Promise.withResolvers<undefined>())
    const running = releases.map((release, index) => ctx.elasticsearch.operation(async () => {
      entered[index]!.resolve(undefined)
      await release.promise
      return index
    }))
    await Promise.all(entered.map(item => item.promise))

    const disposing = fiber.dispose()
    releases[1]!.resolve(undefined)
    await expect(running[1]).resolves.toBe(1)
    expect(clientState.close).not.toHaveBeenCalled()
    releases[2]!.resolve(undefined)
    await expect(running[2]).resolves.toBe(2)
    expect(clientState.close).not.toHaveBeenCalled()
    releases[0]!.resolve(undefined)

    await expect(running[0]).resolves.toBe(0)
    await disposing
    expect(clientState.close).toHaveBeenCalledOnce()
  })

  it('closes after an admitted callback rejects during disposal', async () => {
    const { ctx, fiber } = await boot()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const running = ctx.elasticsearch.operation(async () => {
      entered.resolve(undefined)
      await release.promise
      throw new Error('operation failed during disposal')
    })
    const rejected = expect(running).rejects.toThrow('operation failed during disposal')
    await entered.promise

    const disposing = fiber.dispose()
    release.resolve(undefined)

    await rejected
    await disposing
    expect(clientState.close).toHaveBeenCalledOnce()
  })

  it('waits for a pending startup ping before closing', async () => {
    const pingEntered = Promise.withResolvers<undefined>()
    const pingRelease = Promise.withResolvers<boolean>()
    clientState.ping.mockImplementationOnce(async () => {
      pingEntered.resolve(undefined)
      return pingRelease.promise
    })
    const ctx = new Context()
    contexts.push(ctx)
    const fiber = ctx.plugin(ElasticsearchService, CONFIG)
    await pingEntered.promise
    const service = ctx.elasticsearch

    const disposing = fiber.dispose()
    await Promise.resolve()
    expect(clientState.close).not.toHaveBeenCalled()
    pingRelease.resolve(true)

    await fiber
    await disposing
    expect(clientState.close).toHaveBeenCalledOnce()
    await expect(service.operation(() => 'late')).rejects.toThrow(/closing or closed/)
  })

  it('rejects consumer operations until the startup ping succeeds', async () => {
    const pingEntered = Promise.withResolvers<undefined>()
    const pingRelease = Promise.withResolvers<boolean>()
    clientState.ping.mockImplementationOnce(async () => {
      pingEntered.resolve(undefined)
      return pingRelease.promise
    })
    const ctx = new Context()
    contexts.push(ctx)
    const fiber = ctx.plugin(ElasticsearchService, CONFIG)
    await pingEntered.promise

    await expect(ctx.elasticsearch.operation(() => 'too early')).rejects.toThrow(/not active/)
    pingRelease.resolve(true)
    await fiber

    await expect(ctx.elasticsearch.operation(() => 'ready')).resolves.toBe('ready')
  })

  it('closes the client when startup ping fails', async () => {
    clientState.ping.mockRejectedValueOnce(new Error('authentication failed'))
    const ctx = new Context()
    contexts.push(ctx)

    await expect(ctx.plugin(ElasticsearchService, CONFIG)).rejects.toThrow('authentication failed')
    expect(clientState.close).toHaveBeenCalledOnce()
  })

  it('closes the client when startup ping reports the node unavailable', async () => {
    clientState.ping.mockResolvedValueOnce(false)
    const ctx = new Context()
    contexts.push(ctx)

    await expect(ctx.plugin(ElasticsearchService, CONFIG)).rejects.toThrow('elasticsearch: startup ping failed')
    expect(clientState.close).toHaveBeenCalledOnce()
  })

  it('exposes request APIs while owner-only members are unavailable', () => {
    const acceptsBorrowedClient = (client: ElasticsearchClient): void => {
      void client.search<{ title: string }>({ index: 'documents' })
      void client.search<{ title: string }>({ index: 'documents' }, {
        maxRetries: 0,
        requestTimeout: 100,
      })
      void client.indices.create({ index: 'documents' })
      void client.indices.close({ index: 'documents' })
    }

    expectTypeOf(acceptsBorrowedClient).toBeFunction()
    expectTypeOf<'info'>().toExtend<keyof ElasticsearchClient>()
    expectTypeOf<'search'>().toExtend<keyof ElasticsearchClient>()
    expectTypeOf<'helpers'>().toExtend<keyof ElasticsearchClient>()
    expectTypeOf<'close'>().not.toExtend<keyof ElasticsearchClient>()
    expectTypeOf<'child'>().not.toExtend<keyof ElasticsearchClient>()
    expectTypeOf<'connectionPool'>().not.toExtend<keyof ElasticsearchClient>()
    expectTypeOf<'diagnostic'>().not.toExtend<keyof ElasticsearchClient>()
    expectTypeOf<'serializer'>().not.toExtend<keyof ElasticsearchClient>()
    expectTypeOf<'name'>().not.toExtend<keyof ElasticsearchClient>()
    expectTypeOf<ElasticsearchClient['transport']>().toEqualTypeOf<never>()
    expectTypeOf<ElasticsearchClient['indices']['transport']>().toEqualTypeOf<never>()
  })
})
