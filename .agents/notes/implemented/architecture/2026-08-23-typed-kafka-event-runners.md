# Agent Note: Typed Kafka event runners

Status: implemented

English | [中文](2026-08-23-typed-kafka-event-runners.zh.md)

## Problem

Domain consumers need typed event decoding, routing, filtering, lifecycle observation, and consistent Cordis ownership. Reimplementing those mechanics beside every Redis, Elasticsearch, configuration, or audit consumer would duplicate failure-prone code, while putting domain field interpretation into the Kafka transport would couple infrastructure to every event protocol.

## Decision

`@deepseek-ai/dsh-kafka-events` provides protocol-neutral typed runners above `@deepseek-ai/dsh-kafka`. `EventCodec<T>` owns wire conversion, `EventRouter<T>` owns production routing, and consumers compose an optional `EventFilter<T>` with one `EventHandler<T>`. The package does not depend on CDC or define domain event fields.

The runner preserves Kafka semantics rather than normalizing them. Producers add no retry. Consumers resume committed offsets and expose a fallback only for missing offsets. Decode, filter, and handler failures reach the transport handler unchanged, so the current record is not committed and `done` rejects. A filter rejection is a successful consumer decision and permits commit.

Subscription health contains lifecycle state and counters without payload or failure detail. `done` remains the authoritative failure signal. Close is idempotent and awaits the transport subscription; service disposal settles every active close before returning.

## Package topology

```text
dsh-kafka
    ↑
dsh-kafka-events
    ↑
domain event components
```

The dependency direction lets CDC events, configuration events, authentication events, and other protocols reuse the runner without making the runner aware of their schemas.

## Alternatives considered

**Large producer and consumer base classes.** Inheritance would hide transport behavior behind override hooks and make codec, routing, filtering, and handling difficult to test independently. Small generic interfaces and composition keep each responsibility explicit.

**Domain event support inside `dsh-kafka`.** That would make the Host transport own schema versions, retry policy, and domain interpretation. The transport remains binary and owns broker lifecycle and offset commits; this package owns only typed orchestration.

**Automatic retry and dead-letter handling.** A generic retry rule cannot know whether a handler effect is idempotent or whether an event is poisonous. Consumers and deployment composition retain those decisions.

## Consequences

Domain plugins share one concise producer and listener model without depending directly on transport bytes. They still must define schemas, validation, partitioning, idempotence, retries, and recovery. Focused tests pin routing, filtering, failure propagation, health counters, idempotent close, quiescent disposal, and invariant registration.
