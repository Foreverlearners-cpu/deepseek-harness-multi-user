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
  push(message: unknown): void
  end(): void
}

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
    close: ReturnType<typeof vi.fn<() => Promise<void>>>
    consume: ReturnType<typeof vi.fn<(options: unknown) => Promise<TestStream>>>
    options: unknown
    stream: TestStream
  }>,
}))

vi.mock('@platformatic/kafka', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@platformatic/kafka')>()
  function createStream(): TestStream {
    const messages: unknown[] = []
    const waiters: Array<(value: IteratorResult<unknown>) => void> = []
    let ended = false
    const stream: TestStream = {
      [Symbol.asyncIterator]: () => stream,
      close: vi.fn(async () => { stream.end() }),
      next(): Promise<IteratorResult<unknown>> {
        const message = messages.shift()
        if (message !== undefined) return Promise.resolve({ done: false, value: message })
        if (ended) return Promise.resolve({ done: true, value: undefined })
        return new Promise((resolve) => { waiters.push(resolve) })
      },
      push(message: unknown): void {
        const waiter = waiters.shift()
        if (waiter === undefined) messages.push(message)
        else waiter({ done: false, value: message })
      },
      end(): void {
        if (ended) return
        ended = true
        for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined })
      },
    }
    return stream
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
        const stream = createStream()
        this.state = {
          options,
          stream,
          close: vi.fn(async () => { stream.end() }),
          consume: vi.fn(async (_options: unknown) => stream),
        }
        clients.consumers.push(this.state)
      }
      consume = (options: unknown) => this.state.consume(options)
      close = () => this.state.close()
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
        headers: { traceparent: Buffer.from('trace-1') },
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
      mode: 'committed',
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
        autocommit: false,
        highWaterMark: 8,
      })
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
          mode: 'committed',
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

  it('does not commit a failed handler and reports the classified subscription failure', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(KafkaService, config)
    const commit = vi.fn(async () => {})
    const subscription = await ctx.kafka.subscribe({
      id: KafkaSubscriptionId('projection'),
      groupId: KafkaConsumerGroupId('session-projection'),
      topics: [KafkaTopic('session-events')],
      mode: 'earliest',
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
    await subscription.close()
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
})
