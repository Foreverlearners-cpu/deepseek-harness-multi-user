import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import KafkaService, {
  type Config,
  KafkaConsumerGroupId,
  KafkaSubscriptionId,
  KafkaTopic,
} from '@deepseek-ai/dsh-kafka'

interface TestStream extends AsyncIterableIterator<unknown> {
  readonly close: ReturnType<typeof vi.fn<() => Promise<void>>>
  fail(error: Error): void
  initializeOffsets(): void
  push(message: unknown): void
  end(): void
}

type TestConsumerClose = (
  force?: boolean,
  callback?: (error: Error | null) => void,
) => void | Promise<void>

type TestConsume = (
  options: unknown,
  callback: (error: Error | null, stream?: TestStream) => void,
) => void

const clients = vi.hoisted(() => ({
  admin: {
    close: vi.fn<() => Promise<void>>(),
    metadata: vi.fn<() => Promise<{ id: string; brokers: Map<number, unknown> }>>(),
    options: undefined as Record<string, unknown> | undefined,
  },
  producer: {
    close: vi.fn<() => Promise<void>>(),
    init: vi.fn<() => Promise<unknown>>(),
    options: undefined as Record<string, unknown> | undefined,
    send: vi.fn<() => Promise<unknown>>(),
  },
  consumers: [] as Array<{
    close: ReturnType<typeof vi.fn<TestConsumerClose>>
    consume: ReturnType<typeof vi.fn<TestConsume>>
    options: unknown
    stream: TestStream
  }>,
  autoInitializeOffsets: true,
}))

vi.mock('@platformatic/kafka', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@platformatic/kafka')>()
  const { EventEmitter } = await import('node:events')

  class MockStream extends EventEmitter implements TestStream {
    [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
      return this
    }

    readonly close = vi.fn(async () => { this.end() })
    private readonly messages: unknown[] = []
    private readonly waiters: Array<PromiseWithResolvers<IteratorResult<unknown>>> = []
    private ended = false
    private initialized = false

    next(): Promise<IteratorResult<unknown>> {
      if (clients.autoInitializeOffsets && !this.initialized) {
        queueMicrotask(() => { this.initializeOffsets() })
      }
      const message = this.messages.shift()
      if (message !== undefined) return Promise.resolve({ done: false, value: message })
      if (this.ended) return Promise.resolve({ done: true, value: undefined })
      const waiter = Promise.withResolvers<IteratorResult<unknown>>()
      this.waiters.push(waiter)
      return waiter.promise
    }

    fail(error: Error): void {
      this.emit('error', error)
      for (const waiter of this.waiters.splice(0)) waiter.reject(error)
    }

    initializeOffsets(): void {
      if (this.initialized) return
      this.initialized = true
      this.emit('offsets', [])
    }

    push(message: unknown): void {
      const waiter = this.waiters.shift()
      if (waiter === undefined) this.messages.push(message)
      else waiter.resolve({ done: false, value: message })
    }

    end(): void {
      if (this.ended) return
      this.ended = true
      this.emit('close')
      for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined })
    }
  }

  return {
    ...actual,
    Admin: class {
      constructor(options: unknown) { clients.admin.options = options as Record<string, unknown> }
      metadata = clients.admin.metadata
      close = clients.admin.close
    },
    Producer: class {
      constructor(options: unknown) { clients.producer.options = options as Record<string, unknown> }
      initIdempotentProducer = clients.producer.init
      send = clients.producer.send
      close = clients.producer.close
    },
    Consumer: class {
      readonly state: (typeof clients.consumers)[number]
      constructor(options: unknown) {
        const stream = new MockStream()
        this.state = {
          options,
          stream,
          close: vi.fn((force?: boolean, callback?: (error: Error | null) => void) => {
            stream.end()
            if (force === true) callback?.(null)
            else return Promise.resolve()
          }),
          consume: vi.fn((_options: unknown, callback: (error: Error | null, value?: TestStream) => void) => {
            callback(null, stream)
          }),
        }
        clients.consumers.push(this.state)
      }
      consume = (options: unknown, callback: (error: Error | null, value?: TestStream) => void) => {
        this.state.consume(options, callback)
      }
      close = (force?: boolean, callback?: (error: Error | null) => void) => {
        return this.state.close(force, callback)
      }
    },
  }
})

const config = {
  binding: 'events',
  brokers: ['localhost:9092'],
  clientId: 'dsh-tests',
  tls: false,
  topics: ['session-events', 'audit-events'],
  consumerGroups: ['session-projection'],
  consumerHighWaterMark: 8,
} satisfies Config

beforeEach(() => {
  clients.consumers.splice(0)
  clients.autoInitializeOffsets = true
  clients.admin.options = undefined
  clients.admin.close.mockReset().mockResolvedValue(undefined)
  clients.admin.metadata.mockReset().mockResolvedValue({
    id: 'cluster-a',
    brokers: new Map([[1, {}]]),
  })
  clients.producer.options = undefined
  clients.producer.close.mockReset().mockResolvedValue(undefined)
  clients.producer.init.mockReset().mockResolvedValue({ producerId: 1n, producerEpoch: 0 })
  clients.producer.send.mockReset().mockResolvedValue({
    offsets: [{ topic: 'session-events', partition: 0, offset: 12n }],
  })
})

describe('KafkaService transport', () => {
  it('starts an idempotent producer and publishes an acknowledged binary batch', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(KafkaService, config)

    expect(clients.producer.options).toMatchObject({
      acks: -1,
      autocreateTopics: false,
      idempotent: true,
    })
    expect(clients.producer.init).toHaveBeenCalledWith({
      acks: -1,
      autocreateTopics: false,
      idempotent: true,
    })

    await expect(ctx.kafka.publish([{
      topic: KafkaTopic('session-events'),
      key: Buffer.from('session-1'),
      value: Buffer.from('{"type":"created"}'),
      headers: { traceparent: Buffer.from('trace-1') },
    }])).resolves.toEqual([{
      topic: 'session-events',
      partition: 0,
      offset: 12n,
    }])
    expect(clients.producer.send).toHaveBeenCalledWith({
      messages: [{
        topic: 'session-events',
        key: Buffer.from('session-1'),
        value: Buffer.from('{"type":"created"}'),
        headers: new Map([[Buffer.from('traceparent'), Buffer.from('trace-1')]]),
      }],
      acks: -1,
      autocreateTopics: false,
      idempotent: true,
    })

    await fiber.dispose()
    expect(clients.producer.close).toHaveBeenCalledTimes(1)
  })

  it('rejects empty batches and topics outside the configured authorization list', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(KafkaService, config)

    await expect(ctx.kafka.publish([])).rejects.toMatchObject({ code: 'configuration' })
    await expect(ctx.kafka.publish([{
      topic: KafkaTopic('other-events'),
      value: Buffer.from('private'),
    }])).rejects.toMatchObject({ code: 'configuration' })
    expect(clients.producer.send).not.toHaveBeenCalled()

    await fiber.dispose()
  })

  it('commits only after the sequential handler succeeds and closes through the handle', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(KafkaService, config)
    const handled = Promise.withResolvers<undefined>()
    const commit = vi.fn(async () => {})
    const handler = vi.fn(async () => { await handled.promise })
    const subscription = await ctx.kafka.subscribe({
      id: KafkaSubscriptionId('projection'),
      groupId: KafkaConsumerGroupId('session-projection'),
      topics: [KafkaTopic('session-events')],
      fallbackMode: 'fail',
      handle: handler,
    })
    const consumer = clients.consumers[0]!

    expect(consumer.options).toMatchObject({
      autocreateTopics: false,
      groupId: 'session-projection',
      highWaterMark: 8,
    })
    await vi.waitFor(() => {
      expect(consumer.consume).toHaveBeenCalledWith({
        topics: ['session-events'],
        mode: 'committed',
        fallbackMode: 'fail',
        autocommit: false,
        highWaterMark: 8,
      }, expect.any(Function))
    })
    consumer.stream.push({
      topic: 'session-events',
      partition: 2,
      offset: 9n,
      timestamp: 100n,
      key: Buffer.from('session-1'),
      value: Buffer.from('payload'),
      headers: new Map([[Buffer.from('traceparent'), Buffer.from('trace-1')]]),
      commit,
    })
    await vi.waitFor(() => { expect(handler).toHaveBeenCalledTimes(1) })
    expect(commit).not.toHaveBeenCalled()

    handled.resolve(undefined)
    await vi.waitFor(() => { expect(commit).toHaveBeenCalledTimes(1) })
    await subscription.close()
    await expect(subscription.done).resolves.toBeUndefined()
    expect(consumer.stream.close).toHaveBeenCalledTimes(1)
    expect(consumer.close).toHaveBeenCalledTimes(1)

    await fiber.dispose()
  })

  it('owns a subscription through the exact calling plugin effect', async () => {
    const ctx = new Context()
    const kafkaFiber = await ctx.plugin(KafkaService, config)
    const consumerFiber = await ctx.plugin({
      name: 'projection-consumer',
      inject: ['kafka'],
      async apply(owner) {
        await owner.kafka.subscribe({
          id: KafkaSubscriptionId('projection'),
          groupId: KafkaConsumerGroupId('session-projection'),
          topics: [KafkaTopic('session-events')],
          fallbackMode: 'fail',
          handle: async () => {},
        })
      },
    })
    const consumer = clients.consumers[0]!

    await consumerFiber.dispose()
    expect(consumer.stream.close).toHaveBeenCalledTimes(1)
    expect(consumer.close).toHaveBeenCalledTimes(1)

    await kafkaFiber.dispose()
  })

  it('rejects done when the stream ends without caller-initiated close', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(KafkaService, config)
    const subscription = await ctx.kafka.subscribe({
      id: KafkaSubscriptionId('projection'),
      groupId: KafkaConsumerGroupId('session-projection'),
      topics: [KafkaTopic('session-events')],
      fallbackMode: 'latest',
      handle: async () => {},
    })
    const consumer = clients.consumers[0]!

    consumer.stream.end()
    await expect(subscription.done).rejects.toMatchObject({ code: 'unavailable' })
    expect(consumer.close).toHaveBeenCalledTimes(1)
    await expect(subscription.close()).rejects.toMatchObject({ code: 'unavailable' })
    await fiber.dispose()
  })

  it('does not commit a failed handler and reports the classified subscription failure', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(KafkaService, config)
    const commit = vi.fn(async () => {})
    const subscription = await ctx.kafka.subscribe({
      id: KafkaSubscriptionId('projection'),
      groupId: KafkaConsumerGroupId('session-projection'),
      topics: [KafkaTopic('session-events')],
      fallbackMode: 'earliest',
      handle: () => { throw new Error('private handler failure') },
    })
    const consumer = clients.consumers[0]!
    consumer.stream.push({
      topic: 'session-events',
      partition: 0,
      offset: 0n,
      timestamp: 100n,
      key: null,
      value: Buffer.from('payload'),
      headers: new Map(),
      commit,
    })

    await expect(subscription.done).rejects.toMatchObject({ code: 'unknown' })
    expect(commit).not.toHaveBeenCalled()
    expect(consumer.close).toHaveBeenCalledTimes(1)
    await expect(subscription.close()).rejects.toMatchObject({ code: 'unknown' })
    await fiber.dispose()
  })

  it('drains an admitted publish before closing the producer', async () => {
    const sent = Promise.withResolvers<unknown>()
    clients.producer.send.mockReturnValueOnce(sent.promise)
    const ctx = new Context()
    const fiber = await ctx.plugin(KafkaService, config)
    const publishing = ctx.kafka.publish([{
      topic: KafkaTopic('session-events'),
      value: Buffer.from('payload'),
    }])
    const disposing = fiber.dispose()

    await vi.waitFor(() => { expect(clients.admin.close).toHaveBeenCalledTimes(1) })
    expect(clients.producer.close).not.toHaveBeenCalled()
    sent.resolve({ offsets: [{ topic: 'session-events', partition: 0, offset: 1n }] })
    await expect(publishing).rejects.toMatchObject({ code: 'shutdown' })
    await disposing
    expect(clients.producer.close).toHaveBeenCalledTimes(1)
  })

  it('bounds a stalled publish drain and still closes the producer', async () => {
    const sent = Promise.withResolvers<unknown>()
    clients.producer.send.mockReturnValueOnce(sent.promise)
    const ctx = new Context()
    const fiber = await ctx.plugin(KafkaService, { ...config, requestTimeoutMs: 25 })
    const publishing = ctx.kafka.publish([{
      topic: KafkaTopic('session-events'),
      value: Buffer.from('payload'),
    }])

    await expect(fiber.dispose()).resolves.toBeUndefined()
    expect(clients.producer.close).toHaveBeenCalledTimes(1)

    sent.resolve({ offsets: [{ topic: 'session-events', partition: 0, offset: 2n }] })
    await expect(publishing).rejects.toMatchObject({ code: 'shutdown' })
  })
})
