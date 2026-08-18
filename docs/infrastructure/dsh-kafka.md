# dsh-kafka infrastructure

English | [中文](dsh-kafka.zh.md)

This reference defines the `@deepseek-ai/dsh-kafka` Host plugin and the requirements for domain-event delivery built on it. The current [package](../../packages/multi/kafka/README.md) provides bounded producer and consumer transport plus lifecycle management; it is not an authorization service, a model tool, or an authoritative database. The [Kafka transport Agent Note](../../.agents/notes/implemented/architecture/2026-08-18-host-only-kafka-connectivity.md) owns the dependency and API decision.

## Scope

`dsh-kafka` currently owns one named Admin client, an optional idempotent Producer, caller-scoped Consumers, startup metadata verification, metadata health, allowlist enforcement, classified failures, and client shutdown. Domain plugins still own topic schemas, event meaning, partition keys, retention requirements, stable event ids, durable consumer effects, and projection behavior.

The plugin runs only in trusted Host compositions. It is never projected through Typert, API Proxy, a model tool, or a session execution world. A caller does not gain access to a tenant or topic merely because it can name a Kafka binding.

Kafka carries committed domain events after MySQL transactions complete. MySQL remains authoritative for identity, membership, authorization, session logs, settings, audit records, and other relational state. Kafka is a durable transport and replay buffer; consumers must tolerate it being unavailable, delayed, duplicated, or replayed.

## Package position

The package contains the Kafka Service Definition and Service Provider until a second broker implementation demonstrates a useful provider-neutral event transport API. Domain Consumers keep their own public capabilities and use `dsh-kafka` only as an internal transport.

| Package or component | Role | Ownership |
|---|---|---|
| `@deepseek-ai/dsh-kafka` | Kafka Service Definition and Service Provider | Admin, idempotent binary publish, sequential manual-commit subscriptions, metadata health, allowlists, shutdown, and classified failures |
| Domain outbox dispatchers | Producers | Outbox selection, topic and key selection, event envelope construction, publication state, and reconciliation |
| Domain projection workers | Consumers | Subscription, deduplication, checkpoint policy, retries, projection writes, and poison-event handling |
| Session persistence | Authoritative session Consumer | Session headers and append-only event rows in MySQL; Kafka does not implement or replace `SessionPersistence` |

Large attachments, workspace content, spill files, and binary output remain in object storage or tenant volumes. Kafka events contain authorized references and lifecycle metadata rather than binary payloads.

## Service model

The current service owns one named Kafka binding. One plugin instance owns one Admin client configuration, one optional Producer, and one Consumer per active subscription; a future registry may host several bindings only when a current composition requires more than one cluster.

```text
ctx.kafka
  binding -> KafkaBindingId
  health() -> KafkaHealth
  publish(messages) -> KafkaPublishedOffset[]
  subscribe(request) -> KafkaSubscription
```

Validated Cordis plugin configuration supplies the binding, brokers, client id, TLS choice, optional SASL credentials, timeouts, retries, topic allowlist, consumer-group allowlist, and consumer buffer bound. Empty broker lists, duplicate or empty allowlist entries, invalid client settings, and unreachable bootstrap brokers fail before or during plugin startup. No process-global default silently redirects a domain to another cluster.

Admin and Producer belong to the service scope; each Consumer belongs to the exact calling plugin effect and cannot outlive it. Disposal stops operation admission, drains admitted publication and active handlers, and closes every client once. The selected client exposes no forced-close deadline, so the deployment process retains the outer shutdown bound.

## Configuration and security

All deployment-varying values are validated configuration.

| Configuration area | Required behavior |
|---|---|
| Brokers and identity | Resolve an explicit broker list, client id, and named binding; reject empty targets |
| Transport security | Verify TLS server identity with platform trust roots; plaintext requires explicit `tls: false` |
| Authentication | Accept deployment-supplied username/password SASL without exposing secret values in classified messages |
| Lifecycle | Configure connection, request, retry count, and retry delay |
| Topic and group access | Require configured topic and consumer-group allowlists; disable automatic topic creation |
| Current limits | Do not expose transactions, topic creation, custom CA, mutual TLS, or OAuth operations |

Kafka credentials are deployment bootstrap secrets. They do not come from tenant-submitted request fields or from a credential store that depends on the same Kafka connection. Production identities receive least-privilege Kafka ACLs: dispatchers may write only their owned topics, and projection workers may read only their subscriptions through dedicated consumer groups.

Tenant ids in event envelopes and partition keys support routing and filtering but never establish authorization. Producers derive tenant identity from trusted domain state. Consumers validate the expected topic and event owner before applying a write, and their target repository performs its own tenant-scoped operation.

Kafka clients and credentials remain outside model-controlled containers and microVMs. Execution environments invoke authorized Harness capabilities and never receive `ctx.kafka`, broker addresses, client certificates, or SASL secrets.

## Event and delivery semantics

Kafka delivery is at least once. A successful publish means the configured broker acknowledgement was received; it does not mean every consumer processed the event. Timeouts and connection loss can leave publication outcome unknown, so an outbox dispatcher reconciles by stable event id rather than assuming failure means absence.

Each event envelope includes a stable event id, event type and schema version, source domain and resource id, source revision, tenant id when applicable, occurrence time, and trace metadata. The envelope excludes authentication tokens, credential values, message bodies not required by the consumer, and unrestricted request payloads.

Partition keys preserve order only within the selected tenant and aggregate. No caller may depend on global order across partitions, topics, tenants, or clusters. A domain that requires sequential application selects a stable key such as `(tenant_id, aggregate_id)` and rejects or defers revisions that arrive out of sequence.

Consumers deduplicate by stable event id and source revision in the authoritative target or projection checkpoint store. Handlers are idempotent because rebalances, retries, producer uncertainty, and operator replay can deliver the same event more than once. A consumer commits its Kafka offset only after its durable effect and deduplication record commit together.

Domain owners define backward- and forward-compatibility rules for their event types. Unknown required schema versions fail visibly and do not advance the affected checkpoint. Retention must cover the longest supported outage and replay interval; Kafka retention is not a substitute for MySQL backup or domain history.

## Transactional outbox

A domain mutation and its outbox row commit in one MySQL transaction. An independent dispatcher leases committed rows, constructs the owned event envelope, publishes it to Kafka, and records publication progress. Request handlers never publish to Kafka inside the authoritative transaction and never report a domain write as failed solely because Kafka is unavailable after commit.

The dispatcher may publish an outbox row more than once when broker acknowledgement or publication-state persistence is uncertain. Stable event ids and idempotent consumers make retries safe. Outbox lag, oldest unpublished age, attempts, and terminal classification are observable; operators can pause, replay, or reconcile a domain stream without editing authoritative domain rows.

Redis remains disposable cache, rate limiting, leases, and short-lived coordination. Elasticsearch remains an eventually consistent, tenant-scoped, rebuildable projection. Kafka may deliver their update events, but neither system becomes an authorization source or a replacement for MySQL and the session event log.

## Failure and lifecycle semantics

- Startup resolves credentials, connects to bootstrap brokers, fetches cluster metadata, and verifies every configured binding before service availability. Authentication, TLS, protocol, or topic-authorization failures fail startup.
- Readiness requires a successful bounded broker metadata check for required bindings. Liveness does not require a Kafka round trip.
- Retry applies only to failures classified as transient and remains bounded by configured attempts or elapsed time. The infrastructure service never retries an arbitrary domain handler.
- Permanent authentication, authorization, unsupported-protocol, invalid-topic, oversized-event, and schema failures fail visibly. Domain Consumers own any retry-topic or dead-letter policy because only they can classify event meaning and repairability.
- Rebalances stop new handler admission for revoked partitions and wait for admitted work within the configured bound before releasing ownership. A handler never continues writing under a revoked partition lease.
- Shutdown stops new leases and polling, drains admitted publications and handlers within the configured bound, records unsettled work, disconnects clients, and reaches complete quiescence before disposal resolves.

## Observability

Metrics include connection state, metadata-check latency, producer queue depth, publish outcomes and latency, consumer-group lag, rebalance count and duration, handler outcomes, retries, outbox lag, and classified failures. Labels may include bounded binding, topic, consumer-group, event-type, and outcome values; they exclude tenant ids, resource ids, event payloads, credentials, and unbounded error text.

Logs correlate binding, topic, partition, offset, stable event id, consumer group, operation, and classified failure when those fields are available. They never record SASL secrets, private keys, authentication tokens, full event payloads, message or tool bodies, or unrestricted broker responses.

## Current implementation stage

The current code implements one named Kafka binding, validated broker and security configuration, Admin and optional idempotent Producer creation, startup metadata verification, bounded metadata health, allowlisted binary publishing, caller-owned sequential manual-commit subscriptions, classified failures, and quiescent shutdown. The [package README](../../packages/multi/kafka/README.md) owns its verification commands and exact caller-visible behavior.

This stage does not expose Kafka transactions, create topics, implement an outbox dispatcher, define an event envelope, persist deduplication state, or add retry and dead-letter topics. Consumer groups are permitted only through configuration; their domain semantics and production ACLs require separate ownership and tests.

## Validation requirements for later stages

- Shared lifecycle tests use a real broker to verify startup admission, metadata health, and clean shutdown; forced shutdown and cancellation require client support before they can be promised.
- Producer integration tests verify acknowledgement modes, backpressure, oversized-event rejection, uncertain publication outcomes, and stable event-id reuse.
- Consumer integration tests verify rebalance safety, durable-effect-before-offset ordering, duplicate delivery, out-of-order revisions, restart recovery, and operator replay.
- Outbox tests interrupt dispatch between MySQL commit, broker acknowledgement, and publication-state recording to prove eventual delivery without duplicate authoritative effects.
- Tenant-isolation tests use valid ids from two tenants and prove that topic selection, keys, payload ownership, projection writes, metrics, and logs do not disclose or mutate another tenant.
- Assembled server tests prove that remote, in-process, and model-controlled paths cannot obtain the Kafka service or broker credentials.

## Known limitations and open decisions

- Whether to add a named binding registry when a current composition requires several Kafka clusters.
- Topic strategy: shared domain topics with tenant partition keys, tenant-specific topics, or a bounded hybrid.
- Event encoding and schema management, including whether to operate a schema registry.
- Whether later domain needs require Kafka transactions, compression, or different batching controls beyond the fixed idempotent all-replica producer.
- Consumer retry, retry-topic, dead-letter, quarantine, and operator-replay policy for each domain.
- Retention, partition count, maximum event size, replication, and disaster-recovery objectives for each deployment profile.
- Custom CA, mutual-TLS, OAuth token-refresh, and forced-close ownership.

The [Kafka connectivity Agent Note](../../.agents/notes/implemented/architecture/2026-08-18-host-only-kafka-connectivity.md) records the current package decision and alternatives.
