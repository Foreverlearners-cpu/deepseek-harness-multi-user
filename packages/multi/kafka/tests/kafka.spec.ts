import { Context } from '@deepseek-ai/cordis'
import {
  AuthenticationError,
  MultipleErrors,
  NetworkError,
  ProtocolError,
  TimeoutError,
  UserError,
} from '@platformatic/kafka'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import KafkaService, {
  type Config,
  KafkaError,
  type KafkaSaslMechanism,
} from '@deepseek-ai/dsh-kafka'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { classifyKafkaError } from '../src/error.ts'

const client = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  constructorError: undefined as unknown,
  metadata: vi.fn<() => Promise<{ id: string; brokers: Map<number, unknown> }>>(),
  onConstruct: undefined as (() => void) | undefined,
  options: undefined as unknown,
}))

vi.mock('@platformatic/kafka', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@platformatic/kafka')>()
  return {
    ...actual,
    Admin: class {
      constructor(options: unknown) {
        if (client.constructorError !== undefined) throw client.constructorError
        client.options = options
        client.onConstruct?.()
      }
      metadata = client.metadata
      close = client.close
    },
  }
})

const config = {
  binding: 'events',
  brokers: ['localhost:9092'],
  clientId: 'dsh-tests',
  tls: false,
  requestTimeoutMs: 1_000,
  connectionTimeoutMs: 500,
  retries: 1,
  retryDelayMs: 10,
} satisfies Config

beforeEach(() => {
  client.constructorError = undefined
  client.onConstruct = undefined
  client.options = undefined
  client.close.mockReset().mockResolvedValue(undefined)
  client.metadata.mockReset().mockResolvedValue({
    id: 'cluster-a',
    brokers: new Map([[1, {}], [2, {}]]),
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('KafkaService', () => {
  it('verifies metadata at startup, reports health, and closes once', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(KafkaService, config)

    expect(client.options).toEqual({
      clientId: 'dsh-tests',
      bootstrapBrokers: [{ host: 'localhost', port: 9092 }],
      timeout: 1_000,
      connectTimeout: 500,
      retries: 1,
      retryDelay: 10,
      strict: true,
    })
    expect(client.metadata).toHaveBeenNthCalledWith(1, { topics: [], forceUpdate: true })
    await expect(ctx.kafka.health()).resolves.toEqual({
      binding: 'events',
      clusterId: 'cluster-a',
      brokerCount: 2,
    })

    await fiber.dispose()
    await fiber.dispose()
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it('applies defaults and parses DNS, IPv4, and bracketed IPv6 endpoints', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(KafkaService, {
      binding: 'events',
      brokers: ['broker.internal:9092', '127.0.0.1:19092', '[::1]:29092'],
      clientId: 'dsh-tests',
      tls: false,
    })

    expect(client.options).toEqual({
      clientId: 'dsh-tests',
      bootstrapBrokers: [
        { host: 'broker.internal', port: 9092 },
        { host: '127.0.0.1', port: 19092 },
        { host: '::1', port: 29092 },
      ],
      timeout: 10_000,
      connectTimeout: 5_000,
      retries: 3,
      retryDelay: 300,
      strict: true,
    })
    await fiber.dispose()
  })

  it('accepts exact endpoint and numeric configuration bounds', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(KafkaService, {
      ...config,
      brokers: ['localhost:1', '[2001:db8::1]:65535'],
      requestTimeoutMs: MAX_TIMER_DELAY_MS,
      connectionTimeoutMs: 1,
      retries: Number.MAX_SAFE_INTEGER,
      retryDelayMs: 0,
    })

    expect(client.options).toMatchObject({
      bootstrapBrokers: [
        { host: 'localhost', port: 1 },
        { host: '2001:db8::1', port: 65_535 },
      ],
      timeout: MAX_TIMER_DELAY_MS,
      connectTimeout: 1,
      retries: Number.MAX_SAFE_INTEGER,
      retryDelay: 0,
    })
    await fiber.dispose()
  })

  it.each<KafkaSaslMechanism>(['PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512'])(
    'maps TLS and %s SASL settings without logging secrets',
    async (mechanism) => {
      const ctx = new Context()
      const fiber = await ctx.plugin(KafkaService, {
        ...config,
        tls: true,
        sasl: { mechanism, username: 'service', password: 'secret' },
      })

      expect(client.options).toMatchObject({
        tls: { rejectUnauthorized: true },
        sasl: { mechanism, username: 'service', password: 'secret' },
      })
      await fiber.dispose()
    },
  )

  it('rejects an empty programmatic broker list before creating a client', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(KafkaService, { ...config, brokers: [] })).rejects.toMatchObject({
      code: 'configuration',
      binding: 'events',
    })
    expect(client.metadata).not.toHaveBeenCalled()
  })

  it.each([
    'localhost',
    'localhost:0',
    'localhost:65536',
    'http://localhost:9092',
    'user@localhost:9092',
    'localhost:9092/topic',
    'localhost:9092?rack=a',
    'localhost:9092#broker',
    '::1:9092',
    ' localhost:9092',
    'local\thost:9092',
    ':9092',
    'localhost:',
    ' ',
  ])('rejects invalid bootstrap endpoint %j before creating a client', async (broker) => {
    const ctx = new Context()
    const fiber = ctx.plugin(KafkaService, { ...config, brokers: [broker] })
    try {
      await expect(fiber).rejects.toMatchObject({
        code: 'configuration',
        binding: 'events',
      })
      expect(client.options).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })

  it.each([
    { binding: ' ', clientId: 'dsh-tests' },
    { binding: 'events', clientId: '\t' },
  ])('rejects blank binding or client identity before creating a client', async (identity) => {
    const ctx = new Context()
    const fiber = ctx.plugin(KafkaService, { ...config, ...identity })
    try {
      await expect(fiber).rejects.toMatchObject({ code: 'configuration' })
      expect(client.options).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })

  it.each([
    { requestTimeoutMs: MAX_TIMER_DELAY_MS + 1 },
    { connectionTimeoutMs: MAX_TIMER_DELAY_MS + 1 },
    { retries: Number.MAX_SAFE_INTEGER + 1 },
    { retryDelayMs: MAX_TIMER_DELAY_MS + 1 },
  ])('rejects numeric settings that the runtime cannot represent', async (overrides) => {
    const ctx = new Context()
    const fiber = ctx.plugin(KafkaService, { ...config, ...overrides })
    try {
      await expect(fiber).rejects.toThrow('invalid config')
      expect(client.options).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })

  it.each([
    { requestTimeoutMs: 0 },
    { requestTimeoutMs: 1.5 },
    { requestTimeoutMs: Number.NaN },
    { requestTimeoutMs: Number.POSITIVE_INFINITY },
    { connectionTimeoutMs: 0 },
    { connectionTimeoutMs: 1.5 },
    { retries: -1 },
    { retries: 0.5 },
    { retries: Number.POSITIVE_INFINITY },
    { retryDelayMs: -1 },
    { retryDelayMs: 0.5 },
    { retryDelayMs: Number.POSITIVE_INFINITY },
  ])('rejects non-finite, fractional, or out-of-range numeric setting %#', async (overrides) => {
    const ctx = new Context()
    const fiber = ctx.plugin(KafkaService, { ...config, ...overrides })
    try {
      await expect(fiber).rejects.toThrow('invalid config')
      expect(client.options).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })

  it.each([
    { mechanism: 'OAUTHBEARER', username: 'service', password: 'secret' },
    { mechanism: 'PLAIN', username: '', password: 'secret' },
    { mechanism: 'PLAIN', username: 'service', password: '' },
  ])('rejects unsupported or incomplete SASL setting %#', async (sasl) => {
    const ctx = new Context()
    const fiber = ctx.plugin(KafkaService, { ...config, sasl } as Config)
    try {
      await expect(fiber).rejects.toThrow('invalid config')
      expect(client.options).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })

  it('classifies dependency constructor validation failures', async () => {
    client.constructorError = new UserError('private invalid option')
    const ctx = new Context()
    await expect(ctx.plugin(KafkaService, config)).rejects.toMatchObject({
      code: 'configuration',
      binding: 'events',
      message: "Kafka binding 'events' failed: configuration",
    })
    expect(client.metadata).not.toHaveBeenCalled()
    expect(client.close).not.toHaveBeenCalled()
  })

  it('retains cleanup ownership when disposal is requested during Admin construction', async () => {
    const ctx = new Context()
    let disposal: Promise<void> | undefined
    const fiber = ctx.plugin(KafkaService, config)
    client.onConstruct = () => { disposal = fiber.dispose() }

    await vi.waitFor(() => { expect(disposal).toBeDefined() })
    await disposal

    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it('closes after failed startup and returns the classified failure', async () => {
    client.metadata.mockRejectedValueOnce(new NetworkError('private broker response'))
    const ctx = new Context()
    await expect(ctx.plugin(KafkaService, config)).rejects.toMatchObject({
      code: 'unavailable',
      binding: 'events',
      message: "Kafka binding 'events' failed: unavailable",
    })
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it('reports an authentication failure wrapped by dependency connection setup', async () => {
    client.metadata.mockRejectedValueOnce(new NetworkError('connection failed', {
      cause: new AuthenticationError('private credentials response'),
    }))
    const ctx = new Context()
    await expect(ctx.plugin(KafkaService, config)).rejects.toMatchObject({
      code: 'authentication',
      binding: 'events',
      message: "Kafka binding 'events' failed: authentication",
    })
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it('reports cleanup failure when startup and close both fail', async () => {
    client.metadata.mockRejectedValueOnce(new NetworkError('connect failed'))
    client.close.mockRejectedValueOnce(new Error('close failed'))
    const ctx = new Context()
    const failure: unknown = await Promise.resolve(ctx.plugin(KafkaService, config))
      .catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(KafkaError)
    expect(failure).toMatchObject({ code: 'shutdown', binding: 'events' })
    if (!(failure instanceof KafkaError) || !(failure.cause instanceof AggregateError)) {
      throw new Error('Expected aggregate startup cleanup failure')
    }
    expect(failure.cause.errors[0]).toBeInstanceOf(NetworkError)
    expect(failure.cause.errors[1]).toBeInstanceOf(Error)
  })

  it.each([
    [{ id: '', brokers: new Map([[1, {}]]) }, 'protocol'],
    [{ id: ' \t', brokers: new Map([[1, {}]]) }, 'protocol'],
    [{ id: 'cluster-a', brokers: [] as unknown as Map<number, unknown> }, 'protocol'],
    [{ id: 'cluster-a', brokers: new Map() }, 'unavailable'],
  ] as const)('rejects unusable startup metadata %#', async (metadata, code) => {
    client.metadata.mockResolvedValueOnce(metadata)
    const ctx = new Context()
    const fiber = ctx.plugin(KafkaService, config)
    try {
      await expect(fiber).rejects.toMatchObject({ code, binding: 'events' })
      expect(client.close).toHaveBeenCalledTimes(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('classifies health and shutdown failures', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(KafkaService, config)
    const service = ctx.kafka
    client.metadata.mockRejectedValueOnce(new TimeoutError('late'))
    await expect(service.health()).rejects.toMatchObject({ code: 'timeout' })
    await expect(service.health()).resolves.toMatchObject({ clusterId: 'cluster-a' })
    client.close.mockRejectedValueOnce(new Error('close failed'))
    await expect(fiber.dispose()).resolves.toBeUndefined()
    expect(client.close).toHaveBeenCalledTimes(1)
    await expect(service.health()).rejects.toMatchObject({ code: 'shutdown' })
  })

  it('waits for admitted health work and refuses its late success during disposal', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(KafkaService, config)
    const service = ctx.kafka
    const metadata = Promise.withResolvers<{ id: string; brokers: Map<number, unknown> }>()
    client.metadata.mockReturnValueOnce(metadata.promise)

    const health = service.health()
    let disposed = false
    const disposing = fiber.dispose().then(() => { disposed = true })
    try {
      await vi.waitFor(() => { expect(client.close).toHaveBeenCalledTimes(1) })
      await Promise.resolve()
      expect(disposed).toBe(false)
      metadata.resolve({ id: 'cluster-late', brokers: new Map([[1, {}]]) })
      await expect(health).rejects.toMatchObject({ code: 'shutdown' })
      await disposing
    } finally {
      metadata.resolve({ id: 'cluster-late', brokers: new Map([[1, {}]]) })
      await disposing
    }
  })

  it('waits for health admitted during synchronous dependency diagnostics', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(KafkaService, config)
    const service = ctx.kafka
    const metadata = Promise.withResolvers<{ id: string; brokers: Map<number, unknown> }>()
    let disposing: Promise<void> | undefined
    client.metadata.mockImplementationOnce(() => {
      disposing = fiber.dispose()
      return metadata.promise
    })

    const health = service.health().catch((cause: unknown) => cause)
    await vi.waitFor(() => { expect(disposing).toBeDefined() })
    let disposed = false
    const disposedResult = disposing!.then(() => { disposed = true })
    try {
      await vi.waitFor(() => { expect(client.close).toHaveBeenCalledTimes(1) })
      await Promise.resolve()
      expect(disposed).toBe(false)
    } finally {
      metadata.resolve({ id: 'cluster-late', brokers: new Map([[1, {}]]) })
      await health
      await disposedResult
    }
  })

  it('reports shutdown when admitted health work fails during disposal', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(KafkaService, config)
    const service = ctx.kafka
    const metadata = Promise.withResolvers<{ id: string; brokers: Map<number, unknown> }>()
    client.metadata.mockReturnValueOnce(metadata.promise)

    const health = service.health()
    const disposing = fiber.dispose()
    await vi.waitFor(() => { expect(client.close).toHaveBeenCalledTimes(1) })
    metadata.reject(new NetworkError('closed during metadata'))
    await expect(health).rejects.toMatchObject({ code: 'shutdown' })
    await disposing
  })

  it('waits for every concurrent health operation when client close fails', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(KafkaService, config)
    const service = ctx.kafka
    const first = Promise.withResolvers<{ id: string; brokers: Map<number, unknown> }>()
    const second = Promise.withResolvers<{ id: string; brokers: Map<number, unknown> }>()
    client.metadata
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    client.close.mockRejectedValueOnce(new Error('close failed'))

    const health = [service.health(), service.health()]
      .map(operation => operation.catch((cause: unknown) => cause))
    let disposed = false
    const disposing = fiber.dispose().then(() => { disposed = true })
    await vi.waitFor(() => { expect(client.close).toHaveBeenCalledTimes(1) })
    first.resolve({ id: 'cluster-a', brokers: new Map([[1, {}]]) })
    await Promise.resolve()
    expect(disposed).toBe(false)
    second.reject(new NetworkError('closed during metadata'))

    await expect(Promise.all(health)).resolves.toEqual([
      expect.objectContaining({ code: 'shutdown' }),
      expect.objectContaining({ code: 'shutdown' }),
    ])
    await disposing
  })

  it('closes when disposal starts during startup metadata', async () => {
    const metadata = Promise.withResolvers<{ id: string; brokers: Map<number, unknown> }>()
    client.metadata.mockReturnValueOnce(metadata.promise)
    const ctx = new Context()
    const fiber = ctx.plugin(KafkaService, config)
    await vi.waitFor(() => { expect(client.metadata).toHaveBeenCalledTimes(1) })

    const disposing = fiber.dispose()
    metadata.resolve({ id: 'cluster-a', brokers: new Map([[1, {}]]) })
    await disposing
    expect(client.close).toHaveBeenCalledTimes(1)
  })

  it('bounds a stalled metadata request with requestTimeoutMs', async () => {
    vi.useFakeTimers()
    const metadata = Promise.withResolvers<{ id: string; brokers: Map<number, unknown> }>()
    client.metadata.mockReturnValueOnce(metadata.promise)
    const ctx = new Context()
    const fiber = ctx.plugin(KafkaService, { ...config, requestTimeoutMs: 25 })
    const loading = expect(fiber).rejects.toMatchObject({ code: 'timeout', binding: 'events' })

    await vi.advanceTimersByTimeAsync(0)
    expect(client.metadata).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(25)
    try {
      await loading
      expect(client.close).toHaveBeenCalledTimes(1)
    } finally {
      metadata.reject(new NetworkError('test cleanup'))
      await fiber.dispose()
    }
  })
})

describe('classifyKafkaError', () => {
  it.each([
    [new AuthenticationError('bad credentials'), 'authentication'],
    [new NetworkError('connection wrapper', {
      cause: new AuthenticationError('bad credentials'),
    }), 'authentication'],
    [new NetworkError('offline'), 'unavailable'],
    [new NetworkError('connection wrapper', {
      cause: new Error('connect ECONNREFUSED'),
    }), 'unavailable'],
    [new TimeoutError('late'), 'timeout'],
    [new NetworkError('connection wrapper', {
      cause: new TimeoutError('late'),
    }), 'timeout'],
    [{ code: 'PLT_KFK_TIMEOUT' }, 'timeout'],
    [new UserError('invalid'), 'configuration'],
    [new ProtocolError('UNKNOWN_SERVER_ERROR'), 'protocol'],
    [{ code: 'PLT_KFK_RESPONSE' }, 'protocol'],
    [{ code: 'PLT_KFK_UNEXPECTED_CORRELATION_ID' }, 'protocol'],
    [{ code: 'PLT_KFK_UNFINISHED_WRITE_BUFFER' }, 'protocol'],
    [{ code: 'PLT_KFK_UNSUPPORTED_API' }, 'protocol'],
    [{ code: 'PLT_KFK_UNSUPPORTED_COMPRESSION' }, 'protocol'],
    [{ code: 'PLT_KFK_UNSUPPORTED' }, 'protocol'],
    [{ code: 'PLT_KFK_MULTIPLE' }, 'unknown'],
    [{ code: 1 }, 'unknown'],
    [null, 'unknown'],
  ])('classifies %# without exposing dependency text', (cause, code) => {
    const error = classifyKafkaError(cause, 'events')
    expect(error).toMatchObject({ code, binding: 'events' })
    expect(error.message).not.toContain('credentials')
    expect(error.cause).toBe(cause)
  })

  it('preserves an existing KafkaError', () => {
    const cause = new KafkaError('shutdown', 'events')
    expect(classifyKafkaError(cause, 'other')).toBe(cause)
  })

  it.each([
    [new MultipleErrors('network attempts', [
      new NetworkError('first broker'),
      new NetworkError('second broker'),
    ]), 'unavailable'],
    [new MultipleErrors('timeout attempts', [
      new TimeoutError('first attempt'),
      new TimeoutError('second attempt'),
    ]), 'timeout'],
    [new MultipleErrors('authentication attempts', [
      new NetworkError('first broker', {
        cause: new AuthenticationError('first credentials'),
      }),
      new NetworkError('second broker', {
        cause: new AuthenticationError('second credentials'),
      }),
    ]), 'authentication'],
    [new MultipleErrors('nested attempts', [
      new MultipleErrors('first round', [new NetworkError('first broker')]),
      new MultipleErrors('second round', [new NetworkError('second broker')]),
    ]), 'unavailable'],
    [new MultipleErrors('mixed attempts', [
      new NetworkError('offline'),
      new AuthenticationError('denied'),
    ]), 'unknown'],
  ])('classifies homogeneous aggregate failures %#', (cause, code) => {
    expect(classifyKafkaError(cause, 'events')).toMatchObject({
      code,
      binding: 'events',
      cause,
    })
  })

  it('terminates classification of a cyclic aggregate', () => {
    const cause = new MultipleErrors('cycle', [])
    cause.errors.push(cause)

    expect(classifyKafkaError(cause, 'events')).toMatchObject({
      code: 'unknown',
      binding: 'events',
      cause,
    })
  })

  it('does not serialize dependency diagnostics retained as cause', () => {
    const error = classifyKafkaError(new Error('private dependency response'), 'events')
    const serialized = JSON.stringify(error)
    expect(JSON.parse(serialized)).toMatchObject({
      name: 'KafkaError',
      code: 'unknown',
      binding: 'events',
    })
    expect(serialized).not.toContain('private dependency response')
    expect(serialized).not.toContain('cause')
  })
})
