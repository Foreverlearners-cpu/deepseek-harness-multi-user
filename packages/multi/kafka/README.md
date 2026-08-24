# @deepseek-ai/dsh-kafka

English | [中文](README.zh.md)

Host-only Kafka transport for trusted server plugins. One service owns metadata health, an optional idempotent producer, and caller-scoped consumers. The [infrastructure reference](../../../docs/infrastructure/dsh-kafka.md) defines the domain-event, outbox, and tenant-isolation requirements above this transport.

## Configuration

| Field | Required | Behavior |
|---|---|---|
| `binding` | yes | Non-empty operator name included in health results and classified errors |
| `brokers` | yes | Non-empty `host:port` bootstrap list; IPv6 uses `[address]:port` |
| `clientId` | yes | Kafka protocol client id |
| `tls` | yes | Enables TLS with platform trust roots and server-identity verification |
| `sasl` | no | Username/password authentication using `PLAIN`, `SCRAM-SHA-256`, or `SCRAM-SHA-512` |
| `requestTimeoutMs` | no | Positive operation deadline; default `10000` |
| `connectionTimeoutMs` | no | Positive TCP/TLS connection timeout; default `5000` |
| `retries` | no | Non-negative safe-integer client retry count; default `3` |
| `retryDelayMs` | no | Non-negative retry delay; default `300` |
| `topics` | no | Unique non-empty topic allowlist for publish and subscribe; default `[]` |
| `consumerGroups` | no | Unique non-empty consumer-group allowlist; default `[]` |
| `consumerHighWaterMark` | no | Per-subscription stream buffer size from `1` through `65536`; default `16` |

An empty `topics` list keeps transport operations disabled and does not create a Producer. Topic creation is always disabled. Passwords remain in deployment configuration and dependency state; callers must not log `KafkaError.cause` because it can contain dependency diagnostics.

## Health and publishing

`Service.init` forces metadata before the service is injectable and initializes the Producer when topics are configured. Startup failure closes every client. `health()` returns only `{ binding, clusterId, brokerCount }`.

`publish(messages)` accepts a non-empty batch of binary keys, values, and headers for configured topics. The Producer uses idempotence, `acks: -1`, and no automatic topic creation. The result contains acknowledged topic, partition, and offset positions. Idempotent production reduces duplicates within one producer session; it does not replace a stable event id, transactional outbox, or idempotent domain consumer. When shutdown overlaps a publish, the call reports `shutdown` even if the broker may have accepted the records, so callers must treat the outcome as uncertain.

## Consuming

`subscribe({ id, groupId, topics, fallbackMode, handle })` creates one Consumer for an authorized group and non-empty authorized topic set. Existing committed offsets always take precedence. For a partition without a committed offset, `fallbackMode` selects `earliest`, `latest`, or `fail`. The call returns only after the stream reports its first offset initialization, so records published after return cannot be skipped by a still-pending initial `latest` lookup. Records are delivered sequentially to the awaited handler and committed only after that handler succeeds.

The subscription belongs to the exact Cordis effect that called `subscribe()`. Disposing that plugin or calling `subscription.close()` stops fetching, awaits the active handler, leaves the group, closes the Consumer, and propagates shutdown failures. `subscription.done` resolves only after caller-initiated close and rejects after a handler failure, client failure, or unexpected stream end; callers must supervise it and decide whether to restart or stop their plugin. Subscription ids must be unique within the service. Handlers still own durable-effect ordering, deduplication, schema validation, retry policy, and poison-event handling.

## Access boundary and lifecycle

`ctx.kafka` is available only to trusted Host plugins. The dynamic Cordis sandbox rejects property access, `get`, `provide`, and membership probes for `kafka`; runtime model API catalogs omit it. This is an application boundary, not a substitute for broker ACLs. Production credentials must independently restrict the configured topics and consumer groups.

Disposal stops new health, publish, and subscription admission. Publish draining, active-handler waiting, and Admin, Producer, and Consumer close attempts are bounded by `requestTimeoutMs`; timed-out dependency operations may continue internally, so deployments still retain an outer process-shutdown bound.

## Errors and verification

`KafkaError.code` is `authentication`, `configuration`, `protocol`, `shutdown`, `timeout`, `unavailable`, or `unknown`. Messages contain only the binding and stable category. The dependency is pinned to `@platformatic/kafka@1.34.0`, compatible with this repository's Node range and Kafka `3.5` through `4.2`.

Focused unit tests cover configuration, startup cleanup, health, failure classification, binary publish, authorization, offset readiness and fallback selection, commit ordering, handler and stream failure, effect ownership, and shutdown draining. The environment-gated e2e test currently verifies real-broker startup and health:

```sh
DSH_KAFKA_BROKERS=127.0.0.1:9092 pnpm exec vitest run --config vitest.e2e.config.ts packages/multi/kafka/tests/kafka.e2e.ts
```

## Model Experience

### Kafka transport

#### What the model sees

Nothing. `ctx.kafka` registers no tool, prompt, message, or session event and is excluded from the model-facing Cordis catalog.

#### Token effect

Zero direct tokens per request.

#### KV Cache effect

Independent of model requests.

## Known Limitations and Deferred Work

- **One binding** — one plugin instance owns one Kafka cluster binding.
- **No transactions** — the transport does not expose Kafka transactions or atomic consume-transform-produce.
- **No domain protocol** — event envelopes, schemas, outbox dispatch, deduplication, retry topics, dead-letter handling, and replay remain domain-owned.
- **No topic administration** — topics must be provisioned outside this service.
- **Limited security options** — custom CA bundles, mutual TLS, TLS server-name overrides, and OAuth token refresh are not configured.
- **No transport compression policy** — callers cannot select codecs through this API; deployments must qualify broker and payload behavior before adding compression.
- **Health-only e2e** — real-broker production, rebalance, restart, and replay behavior still require integration coverage.
