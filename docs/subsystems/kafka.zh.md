# Kafka 传输

[English](kafka.md) | 中文

`@deepseek-ai/dsh-kafka` Host 插件通过 `ctx.kafka` 提供一个具名 Kafka 传输。它统一拥有有界元数据健康检查、幂等二进制生产、顺序手动提交订阅、错误分类和静默 client 关闭。[包 README](../../packages/multi/kafka/README.md)定义准确配置与生命周期行为；[基础设施参考](../infrastructure/dsh-kafka.md)负责事件交付、租户隔离与 transactional outbox 要求。

## 健康检查结果

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

Binding 是运维方定义的 branded id。Health 强制刷新 metadata，但不返回 broker endpoint、topic、credential 或 tenant data。启动和操作失败使用包内记录的稳定 `KafkaError` 类别。

## 传输约定

配置的 topic 与 consumer-group allowlist 限制全部传输访问，且系统禁用自动创建 topic。`publish()` 通过幂等 Producer 和全副本确认发送非空二进制批次。`subscribe()` 创建调用方拥有的 Consumer，每次只调用一个 handler，并且只在 handler 成功后提交 offset。Kafka transaction、事件 schema、outbox 状态、去重、重试和 dead-letter 策略不属于该基础设施 API。

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

## 所有权

Service 与全部 Kafka client 只存在于可信 Host composition。动态 Cordis 代码无法访问、解析、替换或探测 `ctx.kafka`，模型侧运行时 catalog 也会省略它。该子系统页面为维护者保留生成的 API。Host 边界不是 broker authorization，因此仍必须独立配置 broker ACL。

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
