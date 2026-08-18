# Kafka Transport

English | [中文](kafka.zh.md)

The `@deepseek-ai/dsh-kafka` Host plugin provides one named Kafka transport at `ctx.kafka`. It owns bounded metadata health, idempotent binary publishing, sequential manual-commit subscriptions, classified failures, and quiescent client shutdown. The [package README](../../packages/multi/kafka/README.md) defines exact configuration and lifecycle behavior; the [infrastructure reference](../infrastructure/dsh-kafka.md) owns event delivery, tenant isolation, and transactional outbox requirements.

## Health result

```ts type-equiv
/** Successful metadata health result without topic or endpoint disclosure. */
interface KafkaHealth {
  /** Binding that answered the health check. */
  binding: KafkaBindingId
  /** Broker-reported cluster id. */
  clusterId: string
  /** Number of brokers visible to the client. */
  brokerCount: number
}
```

The binding is an operator-defined branded id. Health forces a metadata refresh but returns no broker endpoints, topics, credentials, or tenant data. Startup and operation failures use the stable `KafkaError` categories documented by the package.

## Transport contract

Configured topic and consumer-group allowlists bound all transport access, and automatic topic creation is disabled. `publish()` sends a non-empty binary batch through an idempotent Producer with all-replica acknowledgement. `subscribe()` creates a caller-owned Consumer, invokes one handler at a time, and commits each offset only after handler success. Kafka transactions, event schemas, outbox state, deduplication, retries, and dead-letter policy are not part of this infrastructure API.

```ts type-equiv
/** Binary message accepted by the trusted Host producer. */
interface KafkaPublishMessage {
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
```

```ts type-equiv
/** Trusted Host consumer registration. */
interface KafkaSubscribeRequest {
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
```

## Ownership

The service and all Kafka clients exist only in trusted Host compositions. Dynamic Cordis code cannot access, resolve, replace, or probe `ctx.kafka`, and the model-facing runtime catalog omits it. The subsystem page retains the generated API for maintainers. Broker ACLs remain independently required because the Host boundary is not broker authorization.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxkafka--kafkaservice"></a>

### `ctx.kafka` — `KafkaService`

One Host-only Kafka binding. Initialization completes only after a forced broker metadata request succeeds; failed initialization closes the client.

```ts cordis-catalog
/**
 * Force a broker metadata refresh and return bounded cluster identity facts.
 * @returns binding, cluster id, and visible broker count.
 * @throws {@link KafkaError} when disposal has started or metadata fails.
 */
async health(): Promise<KafkaHealth>

/**
 * Publish one non-empty batch to configured topics with all-replica acknowledgement.
 * @param messages - binary records whose topics must be present in `Config.topics`.
 * @returns acknowledged broker positions in dependency response order.
 * @throws {@link KafkaError} when unavailable, unauthorized, closing, or rejected by Kafka.
 */
async publish(messages: readonly KafkaPublishMessage[]): Promise<readonly KafkaPublishedOffset[]>

/**
 * Attach one sequential, manual-commit consumer to the calling plugin's Cordis effect.
 * @param request - unique identity, authorized group/topics, start mode, and awaited handler.
 * @returns a subscription handle; caller disposal closes it automatically.
 * @throws {@link KafkaError} when unavailable, unauthorized, duplicated, or rejected by Kafka.
 */
async subscribe(request: KafkaSubscribeRequest): Promise<KafkaSubscription>
```

Source: [`packages/multi/kafka/src/index.ts:372`](../../packages/multi/kafka/src/index.ts)
<!-- END GENERATED cordis-surface -->
