/**
 * Typed event runners over the Host-only Kafka transport. Codecs own event
 * bytes, producers own routing, and consumers own filtering and handling.
 * Kafka retains retry, ordering, and offset-commit semantics.
 * @module @deepseek-ai/dsh-kafka-events
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  KafkaConsumedMessage,
  KafkaConsumerGroupId,
  KafkaPublishedOffset,
  KafkaPublishMessage,
  KafkaService,
  KafkaSubscription,
  KafkaSubscriptionId,
  KafkaTopic,
} from '@deepseek-ai/dsh-kafka'

/** Converts one event between its typed representation and Kafka bytes. */
export interface EventCodec<T> {
  /**
   * Encode one event; `undefined` deliberately publishes a Kafka tombstone.
   * @param event - typed event selected by the producer.
   * @returns bytes stored in the Kafka value, or `undefined` for a tombstone.
   */
  encode(event: T): Uint8Array | undefined

  /**
   * Decode one Kafka value at the untrusted wire boundary.
   * @param value - record bytes, or `undefined` for a tombstone.
   * @param message - immutable transport metadata for validation and diagnostics.
   * @returns the validated typed event.
   * @throws when bytes or metadata do not satisfy the event protocol.
   */
  decode(value: Uint8Array | undefined, message: KafkaConsumedMessage): T
}

/** Kafka destination fields selected independently from event serialization. */
export interface EventRoute {
  /** Authorized destination topic. */
  topic: KafkaTopic
  /** Optional partitioning key. */
  key?: Uint8Array
  /** Optional UTF-8 header names and binary values. */
  headers?: Readonly<Record<string, Uint8Array>>
  /** Optional broker timestamp in Unix milliseconds. */
  timestamp?: bigint
}

/** Selects Kafka destination fields for one typed event. */
export interface EventRouter<T> {
  /**
   * @param event - event being published.
   * @returns its authorized topic, optional key, headers, and timestamp.
   */
  route(event: T): EventRoute
}

/** Immutable input passed to an event filter or handler. */
export interface EventDelivery<T> {
  /** Validated event returned by the codec. */
  event: T
  /** Kafka record metadata, including topic, partition, and offset. */
  message: KafkaConsumedMessage
}

/** Optional asynchronous selection performed before an event handler. */
export interface EventFilter<T> {
  /**
   * @param delivery - decoded event and its Kafka metadata.
   * @returns `true` to invoke the handler; `false` treats the record as handled.
   */
  accept(delivery: EventDelivery<T>): boolean | Promise<boolean>
}

/** Consumer-owned event behavior. */
export interface EventHandler<T> {
  /**
   * Process one selected event. Successful settlement permits the underlying
   * Kafka subscription to commit the record offset.
   * @param delivery - decoded event and its Kafka metadata.
   * @throws to fail the subscription without committing the current record.
   */
  handle(delivery: EventDelivery<T>): void | Promise<void>
}

/** Start position used only when a group partition has no committed offset. */
export type KafkaEventFallbackMode = 'earliest' | 'latest' | 'fail'

/** Configuration for one typed Kafka consumer. */
export interface KafkaEventConsumerOptions<T> {
  /** Stable subscription identity unique within the Kafka binding. */
  id: KafkaSubscriptionId
  /** Authorized consumer group. */
  groupId: KafkaConsumerGroupId
  /** Non-empty authorized topic set. */
  topics: readonly KafkaTopic[]
  /** Start position used only when the group has no committed offset. */
  fallbackMode: KafkaEventFallbackMode
  /** Event wire protocol. */
  codec: EventCodec<T>
  /** Optional consumer-specific selection. */
  filter?: EventFilter<T>
  /** Consumer-specific side effect. */
  handler: EventHandler<T>
}

/** Observable lifecycle state for a typed event subscription. */
export type KafkaEventConsumerStatus = 'running' | 'stopping' | 'stopped' | 'failed'

/** Point-in-time event consumer health without payload or failure disclosure. */
export interface KafkaEventConsumerHealth {
  /** Stable subscription identity. */
  id: KafkaSubscriptionId
  /** Current lifecycle state. */
  status: KafkaEventConsumerStatus
  /** Records admitted to the codec. */
  received: number
  /** Decoded records rejected by the filter. */
  filtered: number
  /** Records whose handler settled successfully. */
  handled: number
  /** Decode, filter, or handler failures. */
  failures: number
}

/** Caller-owned typed event subscription. */
export interface KafkaEventSubscription {
  /** Stable identity shared with the underlying Kafka subscription. */
  readonly id: KafkaSubscriptionId
  /** Completion that preserves the underlying subscription failure. */
  readonly done: Promise<void>
  /**
   * Return current lifecycle counters.
   * @returns a detached point-in-time health snapshot.
   */
  health(): KafkaEventConsumerHealth
  /** Stop fetching and await the active filter or handler and Kafka client close. */
  close(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    kafkaEvents: KafkaEventsService
  }
}

interface KafkaEventTransport {
  publish(messages: readonly KafkaPublishMessage[]): Promise<readonly KafkaPublishedOffset[]>
  subscribe(request: {
    id: KafkaSubscriptionId
    groupId: KafkaConsumerGroupId
    topics: readonly KafkaTopic[]
    fallbackMode: KafkaEventFallbackMode
    handle(message: KafkaConsumedMessage): void | Promise<void>
  }): Promise<KafkaSubscription>
}

function publishMessage<T>(codec: EventCodec<T>, router: EventRouter<T>, event: T): KafkaPublishMessage {
  const route = router.route(event)
  return {
    topic: route.topic,
    value: codec.encode(event),
    ...(route.key === undefined ? {} : { key: route.key }),
    ...(route.headers === undefined ? {} : { headers: route.headers }),
    ...(route.timestamp === undefined ? {} : { timestamp: route.timestamp }),
  }
}

/** Composition-based typed producer that delegates acknowledgement and retry semantics to Kafka. */
export class KafkaEventProducer<T> {
  /**
   * @param kafka - initialized Host Kafka transport.
   * @param codec - event wire protocol.
   * @param router - per-event topic, key, header, and timestamp selection.
   */
  constructor(
    private readonly kafka: Pick<KafkaService, 'publish'>,
    private readonly codec: EventCodec<T>,
    private readonly router: EventRouter<T>,
  ) {}

  /**
   * Publish one event without adding retries.
   * @param event - typed event to encode and route.
   * @returns the broker-acknowledged position.
   * @throws the unchanged Kafka publication failure.
   */
  async publish(event: T): Promise<KafkaPublishedOffset> {
    const offsets = await this.kafka.publish([publishMessage(this.codec, this.router, event)])
    const offset = offsets[0]
    if (offset === undefined || offsets.length !== 1) {
      throw new Error('Kafka returned an invalid acknowledgement count for one event')
    }
    return offset
  }

  /**
   * Publish one non-empty event batch in input order without adding retries.
   * @param events - typed events to encode and route.
   * @returns broker-acknowledged positions in transport response order.
   * @throws the unchanged Kafka publication failure or a local empty-batch error.
   */
  async publishBatch(events: readonly T[]): Promise<readonly KafkaPublishedOffset[]> {
    if (events.length === 0) throw new Error('Kafka event batch must not be empty')
    return this.kafka.publish(events.map(event => publishMessage(this.codec, this.router, event)))
  }
}

class EventConsumerState {
  private status: KafkaEventConsumerStatus = 'running'
  private received = 0
  private filtered = 0
  private handled = 0
  private failures = 0

  constructor(private readonly options: KafkaEventConsumerOptions<unknown>) {}

  async consume(message: KafkaConsumedMessage): Promise<void> {
    this.received += 1
    try {
      const delivery = {
        event: this.options.codec.decode(message.value ?? undefined, message),
        message,
      }
      if (this.options.filter !== undefined && !await this.options.filter.accept(delivery)) {
        this.filtered += 1
        return
      }
      await this.options.handler.handle(delivery)
      this.handled += 1
    } catch (cause) {
      this.markFailure()
      throw cause
    }
  }

  health(id: KafkaSubscriptionId): KafkaEventConsumerHealth {
    return {
      id,
      status: this.status,
      received: this.received,
      filtered: this.filtered,
      handled: this.handled,
      failures: this.failures,
    }
  }

  stopping(): void {
    if (this.status !== 'failed' && this.status !== 'stopped') this.status = 'stopping'
  }

  stopped(): void {
    if (this.status !== 'failed') this.status = 'stopped'
  }

  failed(): void {
    if (this.status !== 'failed') this.markFailure()
  }

  private markFailure(): void {
    this.failures += 1
    this.status = 'failed'
  }
}

class ManagedEventSubscription implements KafkaEventSubscription {
  readonly id: KafkaSubscriptionId
  readonly done: Promise<void>

  private closePromise?: Promise<void>

  constructor(
    private readonly subscription: KafkaSubscription,
    private readonly state: EventConsumerState,
  ) {
    this.id = subscription.id
    this.done = subscription.done
    void this.done.then(
      () => { this.state.stopped() },
      () => { this.state.failed() },
    )
  }

  health(): KafkaEventConsumerHealth {
    return this.state.health(this.id)
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.state.stopping()
      try {
        await this.subscription.close()
        this.state.stopped()
      } catch (cause) {
        this.state.failed()
        throw cause
      }
    })()
    return this.closePromise
  }
}

/** Service that creates typed producers and scope-owned typed consumers. */
export class KafkaEventsService extends Service {
  static inject = ['kafka']

  private readonly subscriptions = new Map<KafkaSubscriptionId, ManagedEventSubscription>()
  private shutdownPromise?: Promise<void>

  /** @param ctx - Host context carrying the initialized Kafka service. */
  constructor(ctx: Context) {
    super(ctx, 'kafkaEvents')
    this.ctx.effect(() => async () => { await this.shutdown() }, 'kafka-events')
  }

  /**
   * Create a stateless typed producer.
   * @param codec - event wire protocol.
   * @param router - per-event Kafka routing.
   * @returns a producer that delegates directly to `ctx.kafka.publish`.
   */
  producer<T>(codec: EventCodec<T>, router: EventRouter<T>): KafkaEventProducer<T> {
    return new KafkaEventProducer(this.ctx.kafka, codec, router)
  }

  /**
   * Start one sequential typed consumer owned by the calling Cordis scope.
   * Decode, filter, and handler failures reject `done`; the underlying Kafka
   * service therefore does not commit the current record.
   * @param options - Kafka subscription and typed event behavior.
   * @returns the running subscription after the broker consumer is ready.
   */
  async subscribe<T>(options: KafkaEventConsumerOptions<T>): Promise<KafkaEventSubscription> {
    const erased = options as KafkaEventConsumerOptions<unknown>
    const state = new EventConsumerState(erased)
    const kafka = this.ctx.kafka as unknown as KafkaEventTransport
    const subscription = await kafka.subscribe({
      id: options.id,
      groupId: options.groupId,
      topics: options.topics,
      fallbackMode: options.fallbackMode,
      handle: async (message) => { await state.consume(message) },
    })
    const managed = new ManagedEventSubscription(subscription, state)
    this.subscriptions.set(options.id, managed)
    void subscription.done.finally(() => {
      this.subscriptions.delete(options.id)
    }).catch(() => {})
    return managed
  }

  /**
   * Return health for subscriptions currently owned by this service scope.
   * @returns detached snapshots ordered by subscription id.
   */
  health(): readonly KafkaEventConsumerHealth[] {
    return [...this.subscriptions.values()]
      .map(subscription => subscription.health())
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  private shutdown(): Promise<void> {
    this.shutdownPromise ??= (async () => {
      const results = await Promise.allSettled(
        [...this.subscriptions.values()].map(subscription => subscription.close()),
      )
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason as unknown)
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'Kafka event consumers failed to close')
    })()
    return this.shutdownPromise
  }
}

export default KafkaEventsService
