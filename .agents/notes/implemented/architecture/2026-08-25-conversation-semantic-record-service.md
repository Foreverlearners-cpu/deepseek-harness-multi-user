# Agent Note: Conversation semantic record service

Status: implemented

English | [中文](2026-08-25-conversation-semantic-record-service.zh.md)

## Problem

An Agent turn can emit hundreds of meaningful tool, approval, subagent, file, and message facts while model streaming also emits many transient chunks. Product history and recovery need complete business records with tenant ownership and stable ordering, but chunk-level persistence would make the business store larger without improving its recovery point.

Runtime Session headers do not carry tenant or user ownership, and restored seed events are not emitted again. A semantic projection therefore cannot infer a durable owner only from later live events. Provider retries also need both a business ordering key and the original Session position.

## Decision

`@deepseek-ai/dsh-conversation` is the Provider-independent Service Definition for Conversation metadata, complete `AgentRecord` values, message projections, and subagent relations. It depends only on Cordis, branded ids, and runtime invariants; storage and transport packages remain outside it.

A root Session is explicitly attached to tenant and user ownership before its first business record. A child Session may attach through an already attached parent and inherits the same owner. Recovery Consumers scan restored Sessions and attach them before processing later events because Session restoration does not replay `session/event`.

Every semantic record carries a Provider-assigned contiguous `sequence` and its original Session `sourceSequence`. Atomic append compares `expectedNextSequence`; an exact retry is idempotent and a conflicting stale range fails. Query cursors are opaque and scoped by the Provider to tenant, user, conversation, and filters.

The first record union includes complete user and assistant messages, interrupted assistant attempt metadata without partial text, tool calls and results, approvals, subagent lifecycle, file publication, and turn completion. Chunk, reasoning delta, argument delta, transport, heartbeat, and transient progress events are excluded. `assistant/interrupted` is derived from an interrupted turn boundary and does not add a core Session event.

Conversation retention is permanent unless an explicit versioned tenant policy supplies archive or deletion times. Authorization remains a Consumer responsibility.

## Alternatives considered

**Persist every Session event as a business record.** This preserves stream details that product recovery does not use and couples the business schema to runtime event granularity. Session persistence remains the owner of lossless logs.

**Infer ownership from the first message.** Sessions can begin with tools, restoration does not re-emit seed events, and child Sessions need ownership before any record. Explicit attachment makes the security relation an input to the authoritative operation.

**Use only the source Session sequence.** One source event can produce no semantic record or may later require more than one projection record. Separate business and source sequences preserve contiguous product ordering and source idempotency.

**Store partial assistant text on interruption.** Partial text is not a completed product message and can expose content that the user never received as final. The record retains only attempt identity and safe failure metadata.

## Consequences

Providers share one typed operation set and one reusable conformance suite. Later batching and MySQL packages can implement tenant isolation, exact retry, keyset pagination, and per-record recovery without taking chunk data as input.

Explicit attachment adds one required lifecycle operation before semantic writes, and recovery Consumers must scan restored Sessions. The Service Definition does not itself map Session events, schedule persistence, authorize users, store files, or supply a production backend.
