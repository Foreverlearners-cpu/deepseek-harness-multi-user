# @deepseek-ai/dsh-kafka-events

English | [中文](README.zh.md)

Typed event production and consumption for trusted Host plugins. The package builds on [`@deepseek-ai/dsh-kafka`](../kafka/README.md) without defining a domain protocol or depending on CDC.

## Composition

Load `@deepseek-ai/dsh-kafka` first, then load this service. `ctx.kafkaEvents.producer(codec, router)` creates a stateless typed producer. `ctx.kafkaEvents.subscribe(options)` creates a scope-owned typed consumer.

`EventCodec<T>` owns wire encoding and validation. `EventRouter<T>` selects the topic, partition key, headers, and optional timestamp. A consumer combines the same codec with an optional `EventFilter<T>` and one `EventHandler<T>`.

## Publishing

`KafkaEventProducer.publish(event)` publishes one event and requires exactly one broker acknowledgement. `publishBatch(events)` rejects an empty batch and preserves input order when passing records to Kafka. Both methods return the underlying acknowledged offsets and propagate transport failures unchanged.

The runner adds no retry. An uncertain publish outcome therefore retains the exact semantics documented by the Kafka transport. Event ids, outbox durability, deduplication, and routing policy remain protocol or domain responsibilities.

## Consuming

Each subscription declares an id, group, topics, missing-offset `fallbackMode`, codec, optional filter, and handler. Kafka always resumes committed offsets; `fallbackMode` applies only when a partition has no committed position.

Records pass through decode, filter, and handler sequentially. A filter result of `false` is successful handling and permits the transport to commit the offset. A decode, filter, or handler failure is rethrown, rejects `subscription.done`, and prevents commit of the current record. The runner does not retry, skip, pause, or replace failures.

`subscription.close()` is idempotent and awaits the underlying Kafka close, including any active handler. Disposing the service closes all active subscriptions with `Promise.allSettled`, so one close failure cannot prevent another subscription from reaching quiescence.

## Health

`subscription.health()` reports lifecycle status and received, filtered, handled, and failure counters without payloads or exception details. `ctx.kafkaEvents.health()` returns snapshots for active subscriptions ordered by id. Consumers must supervise `done`; health is observation, not failure recovery.

## Model Experience

### Typed Kafka event runners

#### What the model sees

Nothing. The package registers no tool, prompt, message, or session event.

#### Token effect

Zero direct tokens per request.

#### KV Cache effect

Independent of model requests.

## Known Limitations and Deferred Work

- **No schema registry** — codecs own protocol versions and wire validation.
- **No retry policy** — retry topics, dead letters, poison-event handling, and operator restart policy remain consumer-owned.
- **No deduplication** — handlers must use domain event ids or source revisions when effects require idempotence.
- **No consume-transform-produce transaction** — the runner does not add Kafka transactions above the transport.
