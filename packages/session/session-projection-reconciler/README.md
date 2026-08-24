# @deepseek-ai/dsh-session-projection-reconciler

English | [中文](README.zh.md)

Operator-triggered rebuilding of session projections from an authoritative application snapshot. This package does not consume Kafka and does not infer authoritative state from CDC events.

## Composition

Load the service with an explicit `maxBatchSize`. The application injects its authoritative `SessionProjectionSource` by wrapping `ctx.sessionProjectionReconciler.registerSource(source)` in the provider plugin's `ctx.effect()`. Redis, Elasticsearch, or another adapter registers a named `SessionProjectionSink` the same way. Registration disposal removes only that exact source or sink.

Exactly one source and at least one sink must be registered before a job starts. The package contains no MySQL provider: table ownership, snapshot consistency, authorization, and database reads stay in the application. Redis and Elasticsearch packages may provide sink adapters independently.

## Record and pagination

`SessionProjectionRecord` fixes the transport-neutral fields `tenantId`, `userId`, `sessionId`, `messageId`, `revision`, `status`, `visibility`, `role`, `visibleText`, `occurredAt`, and `deleted`. A source page returns ordered records and an optional opaque `nextCursor`; omission marks completion.

`reconcile()` requires a positive `batchSize` no greater than `maxBatchSize` and an explicit `sinkStrategy: 'sequential'`. A source may return an empty terminal page. An empty non-terminal page, a page larger than `batchSize`, a non-advancing cursor, or a record outside the requested tenant stops the job as `invalid-page` before cursor advancement.

## Sink execution and resume

Sequential execution is record-major and follows sink registration order: each record reaches every sink before the next record begins. The service stops on the first source or sink failure and does not invoke later work.

The page start is the durable recovery point. The service advances it only after every record in the page succeeds in every sink. A failure or cancellation returns that page-start cursor, processed-record and completed-page counts, and the failing sink name when applicable. Replaying a page can repeat writes that succeeded before a later write failed, so every sink must be idempotent by record identity and revision. The service provides no cross-sink transaction.

Only one reconcile job may run on a service instance. A second call fails immediately. Caller cancellation and service disposal share one job signal; disposal aborts active work and waits for it to settle.

## Health and privacy

`health()` returns a detached idle or running snapshot. Running state contains only the page cursor, completed counts, optional tenant id, and active sink name. Health and resumable failure results never include records, `visibleText`, or adapter exception details.

## Model Experience

### Projection reconciliation

#### What the model sees

Nothing. `ctx.sessionProjectionReconciler` is Host-only and registers no tool, prompt, message, or session event.

#### Token effect

Zero direct tokens per request.

#### KV Cache effect

Independent of model requests.

## Known Limitations and Deferred Work

- **No MySQL source provider** — the application injects the authoritative source and owns snapshot consistency.
- **No Kafka consumption or automatic scheduling** — an operator or application explicitly starts each job.
- **No cross-sink transaction** — page replay depends on idempotent sinks.
- **One execution strategy** — sinks run sequentially in registration order.
- **No bundled Redis or Elasticsearch adapters** — those packages may provide sink adapters separately.
