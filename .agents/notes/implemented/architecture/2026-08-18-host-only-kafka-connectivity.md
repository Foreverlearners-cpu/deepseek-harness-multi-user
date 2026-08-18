# Agent Note: Host-only Kafka transport

Status: implemented

English | [中文](2026-08-18-host-only-kafka-connectivity.zh.md)

## Problem

Server domains need a shared Kafka lifecycle for metadata readiness, production, and consumption. Letting every domain instantiate a client duplicates bootstrap validation, security settings, error classification, and shutdown. A fully generic transport would also let callers select arbitrary topics or groups before the repository has domain-owned event contracts.

The dependency must support the repository's Node `^22.19.0 || >=24.0.0` range on Windows, macOS, and Linux without requiring a native build toolchain for ordinary installation. The service must remain unavailable to model-authored dynamic Cordis packages.

## Decision

`@deepseek-ai/dsh-kafka` is a Host-only Cordis service at `packages/multi/kafka`. One plugin instance owns a named Admin client and, when at least one topic is configured, an idempotent Producer. Startup forces broker metadata and initializes the Producer before `ctx.kafka` becomes injectable. Failed startup closes all created clients.

Configuration defines explicit topic and consumer-group allowlists. Automatic topic creation is disabled. `publish()` accepts non-empty binary batches, uses `acks: -1` and idempotent production, and returns acknowledged broker positions. `subscribe()` creates one Consumer per subscription, processes records sequentially, and commits only after the awaited handler succeeds. Each subscription belongs to the exact calling Cordis effect. Service disposal stops admission, drains admitted publication and active handlers, and closes Admin, Producer, and Consumers once.

The API deliberately excludes transactions, topic administration, event envelopes, schema management, outbox persistence, deduplication, retries, dead-letter handling, and replay. These semantics remain with domain owners. Idempotent production does not provide end-to-end exactly-once delivery; stable event ids, transactional outbox dispatch, and idempotent durable handlers remain required.

Dynamic Cordis code cannot access, resolve, replace, or probe the `kafka` service. The maintainer subsystem catalog documents it, while the model-facing runtime catalog omits it. Broker ACLs remain an independent production control.

The dependency is pinned to `@platformatic/kafka@1.34.0`, the newest release compatible with the repository's Node range at the time of this decision. It is a JavaScript client with optional platform CRC acceleration, and supports Kafka `3.5` through `4.2`. The earlier `1.10.0` compression overrides are removed because that dependency graph no longer applies.

TLS uses platform trust roots and server-identity verification. Optional username/password SASL supports `PLAIN`, `SCRAM-SHA-256`, and `SCRAM-SHA-512`. Classified `KafkaError` messages contain only a binding and stable category; dependency diagnostics remain only in the non-serialized cause.

## Alternatives considered

**Confluent's JavaScript client.** Rejected because its `librdkafka` addon makes pnpm and cross-platform installation depend on a matching binary or C++ toolchain.

**KafkaJS.** Rejected because its stable release line is inactive compared with Platformatic's maintained line.

**Unrestricted producer and consumer clients.** Rejected because arbitrary topics, groups, autocommit, and topic creation would bypass repository ownership boundaries. The chosen API fixes acknowledgement and commit behavior and admits only configured names.

**Kafka transactions in this stage.** Rejected because no current consume-transform-produce workflow defines transaction ownership, fencing identity, or recovery behavior. Transactions can be added with the first domain that proves those requirements.

**Expose Kafka to dynamic Cordis packages.** Rejected because broker access is infrastructure authority, not a model capability. Host-only enforcement covers direct properties and dynamic context operations, and broker ACLs provide defense in depth.

## Verification

Focused tests cover client configuration, startup cleanup, health, failure classification, idempotent producer initialization, binary publish mapping, allowlist rejection, sequential handler commit ordering, failed-handler non-commit, exact caller-effect ownership, and shutdown draining. Sandbox tests reject property, `get`, `provide`, and membership access. Catalog tests prove the service remains in maintainer docs but is absent from the model runtime API.

The environment-gated real-broker test currently covers startup and health. Production, rebalance, restart, replay, outbox convergence, and tenant-isolation behavior still require domain integration tests before production claims are made.

## Consequences

Trusted Host plugins can now produce and consume through a bounded shared lifecycle without constructing low-level Kafka clients. Topic and group allowlists make accidental cross-domain access reviewable, but they do not replace broker ACLs or payload authorization.

Shutdown-overlapped publication reports `shutdown` even when the broker might have accepted a record. Callers therefore treat that result as uncertain and reconcile with stable event ids. Consumer handlers remain responsible for committing their durable effect before returning and for tolerating duplicate delivery.

One service still represents one cluster binding. Custom CA bundles, mutual TLS, OAuth token refresh, multiple bindings, compression policy, forced-close deadlines, and Kafka transactions remain deferred.
