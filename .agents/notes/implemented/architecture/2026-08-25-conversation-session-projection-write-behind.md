# Agent Note: Conversation Session projection write-behind

Status: implemented

English | [中文](2026-08-25-conversation-session-projection-write-behind.zh.md)

## Problem

[`@deepseek-ai/dsh-conversation`](../../../../packages/session/conversation/README.md) stores complete semantic records, while the runtime Session log contains both complete facts and high-frequency stream chunks. A Consumer must recover constructor seed history, exclude transient events, attach tenant ownership, preserve source idempotency, and prevent one busy Agent Session from creating an unbounded process queue.

Session event notification is post-commit and fire-and-forget. Durable failure therefore cannot reject the original `Session.append()`, but callers still need a barrier that reports whether all accepted semantic records reached the Conversation Provider.

## Decision

`@deepseek-ai/dsh-conversation-persistence` subscribes to `session/created`, `session/event`, `session/flush`, and `session/disposed`. It scans constructor seeds because restored events are not emitted again, maps complete core events, and excludes `assistant/chunk` and other runtime-only state. It does not append a Session event.

Applications explicitly call `attach(session, attachment)` before semantic work. Attachment establishes tenant and user ownership through the Conversation Provider, scans existing record pages, and removes queued source groups already present. Record ids, turn ids, and step ids are deterministic from Session positions; the Provider allocates contiguous business sequence numbers.

One source Session event may produce an adjacent group of semantic records with the same `sourceSequence`. The group is one atomic Provider append unit. An unfinished model attempt at `turn/end` produces both `assistant/interrupted` and `turn/completed`; a completed assistant response, cancellation before step entry, or cancellation during tool execution produces no invented interrupted response. Partial assistant text is never included.

Tool effect classification and plugin-owned required-event projection are explicit contributions. An unknown effect or unhandled required event fails admission rather than silently treating an operation as safe or discarding durable meaning. Ignorable extension events may be skipped.

Each Session owns a bounded queue and a serialized Promise chain. The first queued record starts a fixed timer; record count or exact UTF-8 size of complete target records may close the batch earlier. A single record larger than the byte bound writes alone. Separate Session controllers call the Provider concurrently. Capacity, projection, and Provider errors retain the first failure, stop automatic writes, and reject every later flush. Flush cancels the delay and drains immediately; Session and plugin disposal start a final drain and await plugin-wide quiescence where the lifecycle permits it.

Defaults are 500 milliseconds, 64 records, 524288 bytes, and 4096 pending records per Session.

## Alternatives considered

**Persist each stream chunk.** Session persistence already owns lossless replay. Chunk rows do not improve semantic recovery and would multiply business-store writes.

**Use one process-wide queue.** A blocked Session would serialize unrelated tenants and Agents. Per-Session controllers preserve local ordering while allowing independent progress.

**Infer tool effects from names or default to read-only.** Names do not prove side-effect behavior. Explicit policy makes an unknown classification a visible configuration failure before semantic persistence proceeds.

**Retry Provider failures automatically forever.** An unavailable Provider combined with a busy Agent can exhaust memory. Sticky failure stops admission growth at a known bound and makes the durability barrier responsible for recovery policy.

## Consequences

Conversation Providers receive fewer, larger atomic appends without losing record-level recovery. A crash may lose the current buffered batch, but recovery restarts from the previous complete semantic source group rather than from a chunk boundary.

Application composition must supply attachment and tool-effect policy before semantic events. Approval, subagent, and file integrations remain explicit because current Session facts do not contain every field required by their semantic record types. The planned local object-storage Provider and 256 KiB result-spill policy remain separate from this package.
