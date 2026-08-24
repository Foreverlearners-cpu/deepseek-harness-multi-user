# Agent Note: Authoritative session projection reconciliation

Status: implemented

English | [中文](2026-08-23-session-projection-reconciliation.zh.md)

## Problem

Kafka and CDC projections can become incomplete or inconsistent after an adapter defect, an operator mistake, or an index replacement. Replaying transport history is not always available and does not establish current authoritative state. Rebuilding Redis or Elasticsearch directly inside the application would duplicate pagination, cancellation, failure, and recovery semantics.

## Decision

`@deepseek-ai/dsh-session-projection-reconciler` runs one operator-triggered job from an application-injected paginated source into one or more named sinks. It does not consume Kafka and supplies no MySQL source provider. The application remains responsible for authorization, authoritative snapshot consistency, and source storage.

Each job declares a bounded page size, optional tenant, starting cursor, cancellation signal, and the explicit `sequential` sink strategy. Pages and records retain source order. Each record reaches sinks in registration order, and the service stops immediately when the source or a sink fails.

The page-start cursor is the recovery point. It advances only after the complete page succeeds in every sink. Failure or cancellation returns the current page start, completed counts, and the failing sink name without record content or adapter exception details. Sink adapters must therefore make page replay idempotent by record identity and revision.

The service rejects concurrent jobs on one instance. Service disposal aborts active work and awaits settlement. Health reports only cursor, counters, optional tenant, and active sink name; it never reports `visibleText`.

## Alternatives considered

**Rebuild by replaying Kafka or CDC history.** History may be unavailable, compacted, or produced by logic that needs repair. Reconciliation requires a current authoritative snapshot and stays independent from live event delivery.

**Bundle a MySQL reader.** The infrastructure package cannot choose application tables, joins, authorization, or transaction isolation. Source ownership stays with the application, which injects the pagination implementation.

**Run sinks concurrently.** Concurrent writes reduce latency but make immediate-stop behavior and the active failure location less predictable. The initial service uses deterministic record-major sequential execution and leaves additional explicit strategies for demonstrated needs.

**Advance after each record.** A source cursor identifies a page, not an individual record. Page-level advancement avoids inventing record cursors and makes recovery portable across source providers, at the cost of requiring idempotent replay.

## Consequences

Operators receive a storage-neutral repair path with strict tenant checking, bounded reads, cancellation, observable progress, and a resumable failure position. Redis and Elasticsearch adapters can evolve in their own packages without coupling this service to either client.

The service does not provide automatic scheduling, cross-sink transactions, or exactly-once writes. A partially successful page is replayed, so non-idempotent sinks are not compatible. Sequential sinks also make total rebuild time the sum of their write latency.
