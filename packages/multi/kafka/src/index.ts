/**
 * Host-only Kafka transport. The service owns one named Admin client, an optional
 * idempotent Producer, and caller-scoped Consumers. It verifies broker metadata
 * before service availability and closes every connection with its Cordis scope.
 * @module @deepseek-ai/dsh-kafka
 */

import {
  Admin,
  type AdminOptions,
  type Broker,
  Consumer,
  type Message as PlatformaticMessage,
  type MessageToProduce,
  Producer,
  type SASLMechanisms,
} from '@platformatic/kafka'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import { classifyKafkaError, KafkaError } from './error.ts'

export { KafkaError } from './error.ts'
export type { KafkaErrorCode } from './error.ts'

/** Stable name of one configured Kafka cluster binding. */
export type KafkaBindingId = Branded<'KafkaBindingId'>

/**
 * Brand a validated Kafka binding name.
 * @param value - Non-empty binding name accepted from plugin configuration.
 * @returns the same string with its Kafka binding brand.
 */
export function KafkaBindingId(value: string): KafkaBindingId {
  return value as KafkaBindingId
}

/** Supported username/password SASL mechanisms. */
export type KafkaSaslMechanism = Exclude<
  (typeof SASLMechanisms)[keyof typeof SASLMechanisms],
  'GSSAPI' | 'OAUTHBEARER'
>

/** Username/password SASL configuration. */
export interface KafkaSaslConfig {
  /** Broker authentication mechanism. */
  mechanism: KafkaSaslMechanism
  /** Deployment-supplied SASL username. */
  username: string
  /** Deployment-supplied SASL password. */
  password: string
}

/** Kafka transport plugin configuration. */
export interface Config {
  /** Name used in health results and classified failures. */
  binding: string
  /** Explicit `host:port` bootstrap endpoints; IPv6 hosts use `[address]:port`. */
  brokers: string[]
  /** Kafka protocol client id. */
  clientId: string
  /** Enable TLS with platform trust roots and server-identity verification. */
  tls: boolean
  /** Optional username/password SASL authentication. */
  sasl?: KafkaSaslConfig
  /** Per-operation timeout, including startup and health metadata requests. */
  requestTimeoutMs?: number
  /** TCP/TLS connection timeout. */
  connectionTimeoutMs?: number
  /** Number of client retries for retriable protocol operations. */
  retries?: number
  /** Delay between client retries. */
  retryDelayMs?: number
  /** Topics that trusted Host plugins may publish or consume. */
  topics?: string[]
  /** Consumer groups that trusted Host plugins may join. */
  consumerGroups?: string[]
  /** Per-subscription stream buffer size. */
  consumerHighWaterMark?: number
}

/** Successful metadata health result without topic or endpoint disclosure. */
export interface KafkaHealth {
  /** Binding that answered the health check. */
  binding: KafkaBindingId
  /** Broker-reported cluster id. */
  clusterId: string
  /** Number of brokers visible to the client. */
  brokerCount: number
}

/** Configured Kafka topic name. */
export type KafkaTopic = Branded<'KafkaTopic'>

/**
 * Brand a topic name selected from the service configuration.
 * @param value - Topic name present in `Config.topics`.
 * @returns the same string with its Kafka topic brand.
 */
export function KafkaTopic(value: string): KafkaTopic {
  return value as KafkaTopic
}

/** Configured Kafka consumer-group name. */
export type KafkaConsumerGroupId = Branded<'KafkaConsumerGroupId'>

/**
 * Brand a consumer group selected from the service configuration.
 * @param value - Consumer group present in `Config.consumerGroups`.
 * @returns the same string with its Kafka consumer-group brand.
 */
export function KafkaConsumerGroupId(value: string): KafkaConsumerGroupId {
  return value as KafkaConsumerGroupId
}

/** Caller-owned Kafka subscription identity. */
export type KafkaSubscriptionId = Branded<'KafkaSubscriptionId'>

/**
 * Brand a stable subscription identity.
 * @param value - Non-empty identity unique within one Kafka service.
 * @returns the same string with its Kafka subscription brand.
 */
export function KafkaSubscriptionId(value: string): KafkaSubscriptionId {
  return value as KafkaSubscriptionId
}

/** Binary message accepted by the trusted Host producer. */
export interface KafkaPublishMessage {
  /** Authorized destination topic. */
  topic: KafkaTopic
  /** Optional partitioning key. */
  key?: Uint8Array
  /** Message payload; omission writes a tombstone. */
  value?: Uint8Array
  /** Optional UTF-8 header names and binary values. */
  headers?: Readonly<Record<string, Uint8Array>>
  /** Optional broker record timestamp in Unix milliseconds. */
  timestamp?: bigint
}

/** Broker position acknowledged for one published record. */
export interface KafkaPublishedOffset {
  topic: KafkaTopic
  partition: number
  offset: bigint
}

/** Header delivered to a trusted Host consumer without lossy key coercion. */
export interface KafkaConsumedHeader {
  key: Buffer | null
  value: Buffer | null
}

/** Binary Kafka record delivered to one subscription handler. */
export interface KafkaConsumedMessage {
  topic: KafkaTopic
  partition: number
  offset: bigint
  timestamp: bigint
  key: Buffer | null
  value: Buffer | null
  headers: readonly KafkaConsumedHeader[]
}

/** Start position used when a consumer group has no committed offset. */
export type KafkaSubscriptionMode = 'committed' | 'earliest' | 'latest'

/** Trusted Host consumer registration. */
export interface KafkaSubscribeRequest {
  /** Stable identity unique within this Kafka service. */
  id: KafkaSubscriptionId
  /** Authorized Kafka consumer group. */
  groupId: KafkaConsumerGroupId
  /** Non-empty authorized topic set. */
  topics: readonly KafkaTopic[]
  /** Initial offset behavior. */
  mode: KafkaSubscriptionMode
  /** Sequential handler; its successful settlement commits the record offset. */
  handle(message: KafkaConsumedMessage): void | Promise<void>
}

/** Caller-owned subscription whose completion reports handler or client failure. */
export interface KafkaSubscription {
  readonly id: KafkaSubscriptionId
  readonly done: Promise<void>
  /** Stop fetching, await the active handler, leave the group, and release the caller effect. */
  close(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    kafka: KafkaService
  }
}

const SASL_SCHEMA = z.object({
  mechanism: z.union([
    z.const('PLAIN'),
    z.const('SCRAM-SHA-256'),
    z.const('SCRAM-SHA-512'),
  ] as const).required(),
  username: z.string().min(1).required(),
  password: z.string().min(1).required(),
})

interface ResolvedConfig extends Config {
  requestTimeoutMs: number
  connectionTimeoutMs: number
  retries: number
  retryDelayMs: number
  topics: string[]
  consumerGroups: string[]
  consumerHighWaterMark: number
}

type ClientOptions = Pick<AdminOptions,
  | 'bootstrapBrokers'
  | 'clientId'
  | 'connectTimeout'
  | 'retries'
  | 'retryDelay'
  | 'sasl'
  | 'strict'
  | 'timeout'
  | 'tls'
>

function configurationError(binding: string): KafkaError {
  return new KafkaError('configuration', binding)
}

function validatedNames(values: readonly string[], binding: string): Set<string> {
  const names = new Set<string>()
  for (const value of values) {
    if (value.trim().length === 0 || names.has(value)) throw configurationError(binding)
    names.add(value)
  }
  return names
}

function parseBroker(endpoint: string, binding: string): Broker {
  if (/\s/u.test(endpoint)) throw configurationError(binding)
  let url: URL
  try {
    url = new URL(`tcp://${endpoint}`)
  } catch {
    throw configurationError(binding)
  }
  const port = Number(url.port)
  if (
    url.hostname.length === 0
    || url.port.length === 0
    || !Number.isInteger(port)
    || port < 1
    || port > 65_535
    || url.username.length > 0
    || url.password.length > 0
    || url.pathname.length > 0
    || url.search.length > 0
    || url.hash.length > 0
  ) {
    throw configurationError(binding)
  }
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname
  return { host, port }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, binding: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new KafkaError('timeout', binding)) }, timeoutMs)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function nullableBuffer(value: Uint8Array | null | undefined): Buffer | null {
  return value === null || value === undefined ? null : Buffer.from(value)
}

function consumedMessage(message: PlatformaticMessage): KafkaConsumedMessage {
  return {
    topic: KafkaTopic(message.topic),
    partition: message.partition,
    offset: message.offset,
    timestamp: message.timestamp,
    key: nullableBuffer(message.key),
    value: nullableBuffer(message.value),
    headers: [...message.headers].map(([key, value]) => ({
      key: nullableBuffer(key),
      value: nullableBuffer(value),
    })),
  }
}

class ConsumerSubscription {
  readonly done: Promise<void>
  readonly ready: Promise<void>

  private readonly readyState = Promise.withResolvers<void>()
  private stream?: Awaited<ReturnType<Consumer['consume']>>
  private closeClientsPromise?: Promise<void>
  private closePromise?: Promise<void>
  private closing = false

  constructor(
    readonly id: KafkaSubscriptionId,
    private readonly consumer: Consumer,
    private readonly request: KafkaSubscribeRequest,
    private readonly highWaterMark: number,
    private readonly binding: string,
  ) {
    this.ready = this.readyState.promise
    this.done = this.run()
  }

  private async run(): Promise<void> {
    try {
      this.stream = await this.consumer.consume({
        topics: [...this.request.topics],
        mode: this.request.mode,
        autocommit: false,
        highWaterMark: this.highWaterMark,
      })
      this.readyState.resolve()
      for await (const message of this.stream) {
        await this.request.handle(consumedMessage(message))
        await message.commit()
      }
    } catch (cause) {
      const failure = classifyKafkaError(cause, this.binding)
      this.readyState.reject(failure)
      if (this.closing) return
      throw failure
    } finally {
      await this.closeClients()
    }
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closing = true
      const stopping = await Promise.allSettled([
        this.stream?.close(),
        this.closeClients(),
      ])
      await this.done.catch(() => {})
      const failure = stopping.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )
      if (failure !== undefined) throw failure.reason
    })()
    return this.closePromise
  }

  private closeClients(): Promise<void> {
    this.closeClientsPromise ??= this.consumer.close().catch((cause: unknown) => {
      throw new KafkaError('shutdown', this.binding, { cause })
    })
    return this.closeClientsPromise
  }
}

/**
 * One Host-only Kafka binding. Initialization completes only after a forced
 * broker metadata request succeeds; failed initialization closes the client.
 */
export class KafkaService extends Service {
  static Config: z<Config> = z.object({
    binding: z.string().min(1).required(),
    brokers: z.array(z.string().min(1)).required(),
    clientId: z.string().min(1).required(),
    tls: z.boolean().required(),
    sasl: SASL_SCHEMA.default(undefined as unknown as KafkaSaslConfig),
    requestTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(10_000),
    connectionTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(5_000),
    retries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(3),
    retryDelayMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(300),
    topics: z.array(z.string().min(1)).default([]),
    consumerGroups: z.array(z.string().min(1)).default([]),
    consumerHighWaterMark: z.number().step(1).min(1).max(65_536).default(16),
  })

  /** Stable operator name for this service's only broker binding. */
  readonly binding: KafkaBindingId

  private readonly admin?: Admin
  private readonly producer?: Producer
  private readonly requestTimeoutMs: number
  private readonly clientOptions: ClientOptions
  private readonly topics: ReadonlySet<string>
  private readonly consumerGroups: ReadonlySet<string>
  private readonly consumerHighWaterMark: number
  private readonly healthOperations = new Set<Promise<KafkaHealth>>()
  private readonly publishOperations = new Set<Promise<readonly KafkaPublishedOffset[]>>()
  private readonly subscriptions = new Map<KafkaSubscriptionId, ConsumerSubscription>()
  private available = false
  private adminClosePromise?: Promise<void>
  private producerClosePromise?: Promise<void>

  /**
   * @param ctx - Trusted Host context that will own the Kafka service.
   * @param config - Explicit binding, broker, security, timeout, and retry settings.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'kafka')
    if (
      config.binding.trim().length === 0
      || config.clientId.trim().length === 0
      || config.brokers.length === 0
    ) {
      throw configurationError(config.binding)
    }
    this.binding = KafkaBindingId(config.binding)
    const resolved = config as ResolvedConfig
    this.requestTimeoutMs = resolved.requestTimeoutMs
    this.topics = validatedNames(resolved.topics, this.binding)
    this.consumerGroups = validatedNames(resolved.consumerGroups, this.binding)
    this.consumerHighWaterMark = resolved.consumerHighWaterMark
    this.clientOptions = {
      clientId: resolved.clientId,
      bootstrapBrokers: resolved.brokers.map(endpoint => parseBroker(endpoint, this.binding)),
      timeout: resolved.requestTimeoutMs,
      connectTimeout: resolved.connectionTimeoutMs,
      retries: resolved.retries,
      retryDelay: resolved.retryDelayMs,
      strict: true,
      ...(resolved.tls ? { tls: { rejectUnauthorized: true } } : {}),
      ...(resolved.sasl === undefined ? {} : { sasl: resolved.sasl }),
    }
    // Admin construction publishes diagnostics synchronously, so teardown must
    // already own a client created during a reentrant disposal request.
    this.ctx.effect(() => async () => {
      await this.shutdown()
    }, `kafka:${this.binding}`)
    try {
      this.admin = new Admin(this.clientOptions)
      if (this.topics.size > 0) {
        this.producer = new Producer({
          ...this.clientOptions,
          acks: -1,
          autocreateTopics: false,
          idempotent: true,
        })
      }
    } catch (cause) {
      throw classifyKafkaError(cause, this.binding)
    }
  }

  /** Verify connectivity before the service becomes injectable and own client teardown. */
  protected async [Service.init](): Promise<void> {
    try {
      await this.fetchHealth()
      await this.producer?.initIdempotentProducer({
        acks: -1,
        autocreateTopics: false,
        idempotent: true,
      })
    } catch (cause) {
      const cleanup = await Promise.allSettled([this.closeAdmin(), this.closeProducer()])
      const cleanupFailures = cleanup
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason as unknown)
      if (cleanupFailures.length > 0) {
        throw new KafkaError('shutdown', this.binding, {
          cause: new AggregateError([cause, ...cleanupFailures], 'Kafka startup and cleanup failed'),
        })
      }
      throw classifyKafkaError(cause, this.binding)
    }
    this.available = true
  }

  /**
   * Force a broker metadata refresh and return bounded cluster identity facts.
   * @returns binding, cluster id, and visible broker count.
   * @throws {@link KafkaError} when disposal has started or metadata fails.
   */
  async health(): Promise<KafkaHealth> {
    if (!this.available) throw new KafkaError('shutdown', this.binding)
    const operation = this.healthWhileAvailable()
    this.healthOperations.add(operation)
    try {
      return await operation
    } finally {
      this.healthOperations.delete(operation)
    }
  }

  /**
   * Publish one non-empty batch to configured topics with all-replica acknowledgement.
   * @param messages - binary records whose topics must be present in `Config.topics`.
   * @returns acknowledged broker positions in dependency response order.
   * @throws {@link KafkaError} when unavailable, unauthorized, closing, or rejected by Kafka.
   */
  async publish(messages: readonly KafkaPublishMessage[]): Promise<readonly KafkaPublishedOffset[]> {
    if (!this.available || this.producer === undefined) throw new KafkaError('shutdown', this.binding)
    if (messages.length === 0 || messages.some(message => !this.topics.has(message.topic))) {
      throw configurationError(this.binding)
    }
    const operation = this.publishWhileAvailable(messages)
    this.publishOperations.add(operation)
    try {
      return await operation
    } finally {
      this.publishOperations.delete(operation)
    }
  }

  /**
   * Attach one sequential, manual-commit consumer to the calling plugin's Cordis effect.
   * @param request - unique identity, authorized group/topics, start mode, and awaited handler.
   * @returns a subscription handle; caller disposal closes it automatically.
   * @throws {@link KafkaError} when unavailable, unauthorized, duplicated, or rejected by Kafka.
   */
  async subscribe(request: KafkaSubscribeRequest): Promise<KafkaSubscription> {
    if (!this.available) throw new KafkaError('shutdown', this.binding)
    if (
      request.id.trim().length === 0
      || request.groupId.trim().length === 0
      || !this.consumerGroups.has(request.groupId)
      || request.topics.length === 0
      || request.topics.some(topic => !this.topics.has(topic))
      || new Set(request.topics).size !== request.topics.length
    ) {
      throw configurationError(this.binding)
    }
    if (this.subscriptions.has(request.id)) throw configurationError(this.binding)

    const consumer = new Consumer({
      ...this.clientOptions,
      autocreateTopics: false,
      groupId: request.groupId,
      highWaterMark: this.consumerHighWaterMark,
    })
    const subscription = new ConsumerSubscription(
      request.id,
      consumer,
      request,
      this.consumerHighWaterMark,
      this.binding,
    )
    this.subscriptions.set(request.id, subscription)
    void subscription.done.catch((error: unknown) => {
      const failure = classifyKafkaError(error, this.binding)
      this.ctx.logger.warn(`kafka subscription '${request.id}' stopped: ${failure.code}`)
    })

    const owned = this.ctx.effect(() => async () => {
      this.subscriptions.delete(request.id)
      await subscription.close()
    }, `kafka.subscribe:${request.id}`)
    try {
      await subscription.ready
    } catch (cause) {
      await owned()
      throw cause
    }
    return {
      id: request.id,
      done: subscription.done,
      close: async () => { await owned() },
    }
  }

  private async healthWhileAvailable(): Promise<KafkaHealth> {
    let health: KafkaHealth
    try {
      health = await this.fetchHealth()
    } catch (cause) {
      if (!this.available) throw new KafkaError('shutdown', this.binding, { cause })
      throw classifyKafkaError(cause, this.binding)
    }
    if (!this.available) throw new KafkaError('shutdown', this.binding)
    return health
  }

  private async fetchHealth(): Promise<KafkaHealth> {
    const admin = this.admin
    if (admin === undefined) throw new KafkaError('shutdown', this.binding)
    const metadata = await withTimeout(
      admin.metadata({ topics: [], forceUpdate: true }),
      this.requestTimeoutMs,
      this.binding,
    )
    if (typeof metadata.id !== 'string' || metadata.id.trim().length === 0) {
      throw new KafkaError('protocol', this.binding)
    }
    if (!(metadata.brokers instanceof Map)) throw new KafkaError('protocol', this.binding)
    if (metadata.brokers.size === 0) throw new KafkaError('unavailable', this.binding)
    return {
      binding: this.binding,
      clusterId: metadata.id,
      brokerCount: metadata.brokers.size,
    }
  }

  private async publishWhileAvailable(
    messages: readonly KafkaPublishMessage[],
  ): Promise<readonly KafkaPublishedOffset[]> {
    try {
      const producer = this.producer
      if (producer === undefined) throw new KafkaError('shutdown', this.binding)
      const produced: MessageToProduce[] = messages.map(message => ({
        topic: message.topic,
        ...(message.key === undefined ? {} : { key: Buffer.from(message.key) }),
        ...(message.value === undefined ? {} : { value: Buffer.from(message.value) }),
        ...(message.headers === undefined
          ? {}
          : { headers: Object.fromEntries(Object.entries(message.headers).map(([key, value]) => [key, Buffer.from(value)])) }),
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      }))
      const result = await producer.send({
        messages: produced,
        acks: -1,
        autocreateTopics: false,
        idempotent: true,
      })
      if (!this.available) throw new KafkaError('shutdown', this.binding)
      if (result.unwritableNodes !== undefined && result.unwritableNodes.length > 0) {
        throw new KafkaError('unavailable', this.binding)
      }
      if (result.offsets === undefined) throw new KafkaError('protocol', this.binding)
      return result.offsets.map(offset => ({ ...offset, topic: KafkaTopic(offset.topic) }))
    } catch (cause) {
      if (!this.available) throw new KafkaError('shutdown', this.binding, { cause })
      throw classifyKafkaError(cause, this.binding)
    }
  }

  private async shutdown(): Promise<void> {
    this.available = false
    const producerShutdown = Promise.allSettled([...this.publishOperations])
      .then(async () => { await this.closeProducer() })
    const results = await Promise.allSettled([
      this.closeAdmin(),
      producerShutdown,
      ...[...this.subscriptions.values()].map(subscription => subscription.close()),
      ...this.healthOperations,
    ])
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new KafkaError('shutdown', this.binding, {
        cause: new AggregateError(failures, 'Kafka shutdown failed'),
      })
    }
  }

  private closeAdmin(): Promise<void> {
    this.adminClosePromise ??= Promise.resolve()
      .then(async () => { await this.admin?.close() })
      .catch((cause: unknown) => {
        throw new KafkaError('shutdown', this.binding, { cause })
      })
    return this.adminClosePromise
  }

  private closeProducer(): Promise<void> {
    this.producerClosePromise ??= Promise.resolve()
      .then(async () => { await this.producer?.close() })
      .catch((cause: unknown) => {
        throw new KafkaError('shutdown', this.binding, { cause })
      })
    return this.producerClosePromise
  }
}

export default KafkaService
