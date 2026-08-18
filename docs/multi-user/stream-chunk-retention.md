# Stream chunk retention

English | [中文](stream-chunk-retention.zh.md)

This reference defines how a multi-user deployment handles provider stream chunks when it persists session context, live delivery state, and user facts. It is a design proposal, not a statement that the policy is already shipped. The [multi-user architecture](README.md) and [data and runtime isolation](data-and-runtime-isolation.md) define the ownership and authorization rules that apply here.

## Decision summary

The assembled assistant message is the durable semantic input for a later model request. A provider chunk is transport data: it is useful while a response is being generated, but its boundary and timing do not form a user fact. Successful responses therefore do not need indefinitely retained, individually indexed chunks.

The first implementation keeps the logical session event contract lossless and reduces physical cost with batching, lossless packing, and compression. It does not send every chunk to Kafka or Elasticsearch. A later format can make successful raw chunks short-lived after attempt metadata, partial recovery, and live-stream replay no longer depend on the canonical event log.

## Scope and terms

- A **chunk** is one provider stream unit, such as a text delta, reasoning delta, tool-call delta, usage report, or stream boundary.
- An **assembled message** is the validated assistant response produced after the provider stream finishes. It is the version used to reconstruct model history.
- An **attempt** is one provider request, including a retry that has its own timing, status, usage, and error outcome.
- A **stream artifact** is an optional encoded record of raw chunks kept for replay or provider-level audit. It is not a model-history record.
- A **fact** is a derived, user- or tenant-scoped projection extracted from a completed message and its tool results. A partial prefix is never a fact source.

## Retention classes

Retention is selected by use case rather than by event type alone. Every class is tenant-scoped, has an owner, and has an explicit deletion or expiry rule.

| Class | Data | Storage | Readers | Retention |
| --- | --- | --- | --- | --- |
| Semantic durable | User messages, assembled assistant messages, tool calls/results, request headers, and committed usage | MySQL session domain | Resume, prompt assembly, export, fact extraction | Session policy or legal hold |
| Attempt durable | Provider/model, status, start/first-token/finish times, finish reason, usage, error, and final message reference | MySQL `model_attempts` | Billing, metrics, failure recovery, operations | Session policy plus aggregate reporting policy |
| Live stream | Coalesced deltas, current partial blocks, last cursor, and reconnect expiry | Redis Stream or scoped Redis key | Connected clients and reconnect handler | Short configurable TTL; disposable |
| Raw stream artifact | Lossless packed chunks, sequence/time anchors, codec, and checksum | MySQL `stream_artifacts` or an approved archive | Exact replay, support, or compliance audit | Explicit opt-in retention; otherwise short TTL or absent |

The semantic record remains the authority even when a live stream or raw artifact exists. Redis loss, Kafka redelivery, Elasticsearch rebuild, and artifact expiry must not change the model transcript.

## Authoritative data model

The parent session design owns the canonical event and message tables. The following logical records add the information needed to stop treating chunks as the only record of an in-flight request.

| Logical record | Required scope and identity | Required content |
| --- | --- | --- |
| Canonical session message/event | `tenant_id`, `session_id`, monotonic event identity | Final user and assistant messages, tool calls/results, request headers, and references to the producing attempt; raw chunks are not projected into model history |
| `model_attempts` | Unique `(tenant_id, session_id, attempt_id)` plus `turn`, `step`, and retry number | Provider and model, status, `started_at`, nullable `first_token_at`, `finished_at`, finish reason, usage, bounded error details, and `final_message_id` or `partial_snapshot` |
| `stream_artifacts` | Unique `(tenant_id, session_id, attempt_id)` and an artifact version | Optional compressed payload, sequence/time range, chunk count, codec, checksum, creation time, and `expires_at`; no per-chunk secondary indexes |
| `user_facts` and evidence | Unique tenant/principal fact identity and source message identity | Normalized fact value, lifecycle state, extractor version, confidence or provenance, and references to final-message evidence; never a reference that requires a deleted chunk |

All relational keys, Redis keys, Kafka records, and search documents carry tenant scope before resource identity. A globally unique session or attempt id is not an authorization check.

## Lifecycle operations

1. Create one idempotent `model_attempts` record before opening the provider stream. The attempt id is the idempotency key for retries, completion, failure, and cleanup.
2. Accumulate chunks in the stream worker and send coalesced updates to the client. Record `first_token_at` once, on the first non-empty token delta. Do not start a MySQL transaction, Kafka message, or Elasticsearch index operation for each chunk.
3. If reconnect or cross-process delivery is required, append bounded batches to a tenant- and attempt-scoped Redis Stream and periodically write a partial checkpoint. The checkpoint contains assembled blocks and a cursor, not a full copy rewritten on every delta.
4. On success, commit the assembled assistant message, usage, attempt completion fields, and a transactional outbox entry in one MySQL transaction. The outbox publishes a final-message event for fact extraction and derived projections.
5. On failure, cancellation, or provider disconnect, close the attempt with its error and usage, and save one bounded partial snapshot when the product promises partial recovery. A successful attempt may omit its raw artifact; an interrupted attempt keeps the configured recovery artifact until its retention deadline.
6. After the attempt is terminal, expire Redis state and run tenant-scoped artifact cleanup. Cleanup is idempotent and must not delete the canonical message, attempt accounting, or fact evidence.

## Infrastructure responsibilities

| System | Role | Chunk policy |
| --- | --- | --- |
| MySQL | Authoritative relational store and transactional outbox | Batch writes; pack consecutive deltas into a lossless row or blob; retain final messages and attempt summaries; avoid per-chunk indexes |
| Redis | Live fan-out, reconnect cursor, lease, and short-lived checkpoint | Use a capped stream or bounded key with TTL; coalesce updates; loss is acceptable after the reconnect window |
| Kafka | Durable asynchronous integration | Publish terminal attempt/message and fact-extraction events; use keys containing tenant and session identity; do not publish token-sized events |
| Elasticsearch | Rebuildable search and analytics projection | Index final messages, attempt summaries, and facts only; never create one document per provider chunk |

Kafka consumers and Elasticsearch indexers are downstream projections. They cannot become the authorization source, prompt-history source, or only copy of usage accounting.

## Efficiency rules

- Bound persistence work by time or bytes, not by provider chunk count. A flush writes a stable ordered prefix and can contain many deltas.
- Pack only recognized consecutive runs with sequence and timestamp anchors. The decoder must reconstruct the exact logical events; unknown chunk variants pass through without data loss.
- Keep indexes on `tenant_id`, `session_id`, `attempt_id`, and terminal timestamps. Do not index chunk text, chunk sequence, or every partial update for ordinary product queries.
- Avoid rewriting the complete partial response on every delta. Keep the in-memory accumulator authoritative during the stream and checkpoint at bounded intervals or size thresholds.
- Apply backpressure when a client or Redis consumer falls behind. Dropping a live update is acceptable only when a later checkpoint or final message is available to the reconnecting reader.
- Measure write operations, bytes after compression, binlog volume, Redis memory, Kafka records, and end-to-end first-token latency separately. Retention values and batch limits are deployment configuration, not hidden constants.

## Compatibility and migration

The lossless session contract must not silently filter chunks. During the first storage implementation, a MySQL session provider can satisfy that contract with packed rows that decode to the original event sequence. This preserves replay, source references, timing, and clients while removing most row and envelope overhead.

Dropping successful raw chunks is a later format change. Before enabling it, persist first-token timing, usage, terminal status, failure attempts, bounded partial snapshots, and an attempt-level source reference for the final message. Move live UI recovery to Redis or another explicitly ephemeral channel, and make exports state whether raw provider replay is included. A retention job must never remove evidence that a remaining fact or message claims as its source.

## Fact extraction and privacy

Fact extraction runs once a message and its tool results are terminal. It is keyed by `(tenant_id, source_message_id, extractor_version)` so Kafka retries do not create duplicate facts. The fact record points to final-message evidence or a stable event range; it never requires a token chunk to remain available.

Raw chunks can contain reasoning text, tool arguments, paths, or other sensitive content. Multi-user deployments default raw-chunk telemetry and long-term artifacts to disabled. Any exception needs an explicit tenant policy, purpose, redaction rule, destination, retention period, and audit record. Authorization is checked before reading a live stream, artifact, message, or fact, including during reconnect and background cleanup.

## Open decisions

- Whether the product promises exact provider replay, partial recovery, or only final-message recovery for each session class.
- The default Redis reconnect window and the maximum artifact size for each deployment tier.
- Whether approved audit artifacts live in MySQL or a separate archive, and which codec and checksum are supported.
- The retention, export, deletion, and legal-hold rules for reasoning content, tool arguments, usage, and derived user facts.
