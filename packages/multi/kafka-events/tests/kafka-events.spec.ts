import { Context, Service } from '@deepseek-ai/cordis'
import {
  KafkaConsumerGroupId,
  type KafkaConsumedMessage,
  type KafkaPublishedOffset,
  type KafkaPublishMessage,
  type KafkaSubscription,
  KafkaSubscriptionId,
  KafkaTopic,
} from '@deepseek-ai/dsh-kafka'
import KafkaEventsService, {
  type EventCodec,
  KafkaEventProducer,
} from '@deepseek-ai/dsh-kafka-events'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface TestEvent {
  id: string
  action: string
}

const topic = KafkaTopic('events.v1')
const groupId = KafkaConsumerGroupId('projection')
const subscriptionId = KafkaSubscriptionId('projection-worker')
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const codec: EventCodec<TestEvent> = {
  encode: event => encoder.encode(JSON.stringify(event)),
  decode: (value) => {
    if (value === undefined) throw new Error('missing event value')
    return JSON.parse(decoder.decode(value)) as TestEvent
  },
}

function message(event: TestEvent, offset = 1n): KafkaConsumedMessage {
  return {
    topic,
    partition: 0,
    offset,
    timestamp: 10n,
    key: Buffer.from(event.id),
    value: Buffer.from(codec.encode(event)!),
    headers: [],
  }
}

class TestKafkaService extends Service {
  published: readonly KafkaPublishMessage[] | undefined
  request: {
    id: KafkaSubscriptionId
    groupId: KafkaConsumerGroupId
    topics: readonly KafkaTopic[]
    fallbackMode: 'earliest' | 'latest' | 'fail'
    handle(message: KafkaConsumedMessage): void | Promise<void>
  } | undefined
  readonly completion = Promise.withResolvers<undefined>()
  readonly closeGate = Promise.withResolvers<undefined>()
  closeStarted = false
  blockClose = false

  constructor(ctx: Context) {
    super(ctx, 'kafka')
  }

  async publish(messages: readonly KafkaPublishMessage[]): Promise<readonly KafkaPublishedOffset[]> {
    this.published = messages
    return messages.map((item, index) => ({ topic: item.topic, partition: 0, offset: BigInt(index) }))
  }

  async subscribe(request: NonNullable<TestKafkaService['request']>): Promise<KafkaSubscription> {
    this.request = request
    return {
      id: request.id,
      done: this.completion.promise,
      close: async () => {
        this.closeStarted = true
        if (this.blockClose) await this.closeGate.promise
        this.completion.resolve(undefined)
      },
    }
  }
}

const cleanups: Array<() => Promise<void>> = []

async function setup(): Promise<{
  ctx: Context
  kafka: TestKafkaService
  events: KafkaEventsService
}> {
  const ctx = new Context()
  const kafkaFiber = await ctx.plugin(TestKafkaService)
  const kafka = ctx.get('kafka') as unknown as TestKafkaService
  const eventsFiber = await ctx.plugin(KafkaEventsService)
  cleanups.push(async () => {
    await Promise.allSettled([eventsFiber.dispose(), kafkaFiber.dispose()])
  })
  return { ctx, kafka, events: ctx.kafkaEvents }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('KafkaEventProducer', () => {
  it('encodes routing fields and returns the single acknowledgement', async () => {
    const publish = vi.fn(async (): Promise<readonly KafkaPublishedOffset[]> => [
      { topic, partition: 2, offset: 9n },
    ])
    const producer = new KafkaEventProducer({ publish }, codec, {
      route: event => ({
        topic,
        key: encoder.encode(event.id),
        headers: { operation: encoder.encode(event.action) },
        timestamp: 42n,
      }),
    })

    await expect(producer.publish({ id: 'm1', action: 'upsert' })).resolves.toEqual({
      topic,
      partition: 2,
      offset: 9n,
    })
    expect(publish).toHaveBeenCalledWith([{
      topic,
      key: encoder.encode('m1'),
      value: codec.encode({ id: 'm1', action: 'upsert' }),
      headers: { operation: encoder.encode('upsert') },
      timestamp: 42n,
    }])
  })

  it('publishes batches without changing transport ordering or failures', async () => {
    const failure = new Error('publish failed')
    const publish = vi.fn().mockRejectedValue(failure)
    const producer = new KafkaEventProducer({ publish }, codec, { route: () => ({ topic }) })

    await expect(producer.publishBatch([])).rejects.toThrow('must not be empty')
    await expect(producer.publishBatch([
      { id: 'm1', action: 'upsert' },
      { id: 'm2', action: 'delete' },
    ])).rejects.toBe(failure)
    expect(publish).toHaveBeenCalledOnce()
  })

  it('rejects an invalid acknowledgement count', async () => {
    const producer = new KafkaEventProducer(
      { publish: async () => [] },
      codec,
      { route: () => ({ topic }) },
    )
    await expect(producer.publish({ id: 'm1', action: 'upsert' })).rejects.toThrow(
      'invalid acknowledgement count',
    )
  })
})

describe('KafkaEventsService', () => {
  it('creates producers over the injected transport', async () => {
    const { kafka, events } = await setup()
    const producer = events.producer(codec, { route: () => ({ topic }) })

    await producer.publish({ id: 'm1', action: 'upsert' })
    expect(kafka.published).toEqual([{
      topic,
      value: codec.encode({ id: 'm1', action: 'upsert' }),
    }])
  })

  it('decodes, filters, handles, and reports detached health snapshots', async () => {
    const { kafka, events } = await setup()
    const handled: TestEvent[] = []
    const subscription = await events.subscribe({
      id: subscriptionId,
      groupId,
      topics: [topic],
      fallbackMode: 'fail',
      codec,
      filter: { accept: ({ event }) => event.action !== 'ignore' },
      handler: { handle: ({ event }) => { handled.push(event) } },
    })

    expect(kafka.request).toMatchObject({
      id: subscriptionId,
      groupId,
      topics: [topic],
      fallbackMode: 'fail',
    })
    await kafka.request!.handle(message({ id: 'm1', action: 'ignore' }))
    await kafka.request!.handle(message({ id: 'm2', action: 'upsert' }, 2n))

    expect(handled).toEqual([{ id: 'm2', action: 'upsert' }])
    expect(subscription.health()).toEqual({
      id: subscriptionId,
      status: 'running',
      received: 2,
      filtered: 1,
      handled: 1,
      failures: 0,
    })
    expect(events.health()).toEqual([subscription.health()])
  })

  it('propagates handler failure through both delivery and done', async () => {
    const { kafka, events } = await setup()
    const failure = new Error('projection failed')
    const subscription = await events.subscribe({
      id: subscriptionId,
      groupId,
      topics: [topic],
      fallbackMode: 'earliest',
      codec,
      handler: { handle: () => { throw failure } },
    })

    await expect(kafka.request!.handle(message({ id: 'm1', action: 'upsert' }))).rejects.toBe(failure)
    kafka.completion.reject(failure)
    await expect(subscription.done).rejects.toBe(failure)
    expect(subscription.health()).toMatchObject({ status: 'failed', failures: 1 })
    await vi.waitFor(() => { expect(events.health()).toEqual([]) })
  })

  it('counts codec and filter failures without replacing their causes', async () => {
    const { kafka, events } = await setup()
    const decodeFailure = new Error('invalid wire event')
    const filterFailure = new Error('filter failed')
    const decodeSubscription = await events.subscribe({
      id: KafkaSubscriptionId('decode'),
      groupId,
      topics: [topic],
      fallbackMode: 'latest',
      codec: { encode: codec.encode, decode: () => { throw decodeFailure } },
      handler: { handle: () => {} },
    })
    await expect(kafka.request!.handle(message({ id: 'm1', action: 'upsert' }))).rejects.toBe(decodeFailure)
    expect(decodeSubscription.health()).toMatchObject({ status: 'failed', failures: 1 })

    kafka.completion.resolve(undefined)
    await decodeSubscription.done
    const second = await setup()
    const filterSubscription = await second.events.subscribe({
      id: KafkaSubscriptionId('filter'),
      groupId,
      topics: [topic],
      fallbackMode: 'latest',
      codec,
      filter: { accept: () => { throw filterFailure } },
      handler: { handle: () => {} },
    })
    await expect(second.kafka.request!.handle(message({ id: 'm2', action: 'upsert' }))).rejects.toBe(filterFailure)
    expect(filterSubscription.health()).toMatchObject({ status: 'failed', failures: 1 })
  })

  it('keeps close idempotent and waits for the underlying subscription', async () => {
    const { kafka, events } = await setup()
    kafka.blockClose = true
    const subscription = await events.subscribe({
      id: subscriptionId,
      groupId,
      topics: [topic],
      fallbackMode: 'fail',
      codec,
      handler: { handle: () => {} },
    })

    let closed = false
    const first = subscription.close().then(() => { closed = true })
    const second = subscription.close()
    await vi.waitFor(() => { expect(kafka.closeStarted).toBe(true) })
    expect(subscription.health().status).toBe('stopping')
    expect(closed).toBe(false)
    kafka.closeGate.resolve(undefined)
    await Promise.all([first, second])
    expect(subscription.health().status).toBe('stopped')
  })

  it('reports and rethrows an underlying close failure', async () => {
    const { kafka, events } = await setup()
    const failure = new Error('close failed')
    kafka.subscribe = async (request) => {
      kafka.request = request
      return { id: request.id, done: kafka.completion.promise, close: async () => { throw failure } }
    }
    const subscription = await events.subscribe({
      id: subscriptionId,
      groupId,
      topics: [topic],
      fallbackMode: 'fail',
      codec,
      handler: { handle: () => {} },
    })

    await expect(subscription.close()).rejects.toBe(failure)
    expect(subscription.health()).toMatchObject({ status: 'failed', failures: 1 })
    kafka.completion.reject(failure)
    await expect(subscription.done).rejects.toBe(failure)
  })
})
