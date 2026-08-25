# @deepseek-ai/dsh-conversation

English | [中文](README.zh.md)

Provider-independent Host service for tenant-owned conversations, complete semantic Agent records, user-interface message projections, and parent-child subagent runs. It defines storage obligations without selecting MySQL, Redis, Kafka, or a file backend.

## Public API

| API | Purpose |
|---|---|
| `ctx.conversations.attach(input)` | Bind a runtime Session to tenant/user ownership before its first business record; child Sessions may inherit the owner from an attached parent |
| `ctx.conversations.create(input)` | Create explicit conversation metadata for an import or administrative workflow |
| `ctx.conversations.get(identity)` | Read current tenant-scoped metadata |
| `ctx.conversations.append(request)` | Atomically append a non-empty contiguous range at `expectedNextSequence` |
| `ctx.conversations.list(query)` | List tenant-user conversations with an opaque keyset cursor |
| `ctx.conversations.records(query)` | List complete semantic records in business-sequence order |
| `ctx.conversations.messages(query)` | List complete user and assistant message projections |
| `ctx.conversations.subagents(query)` | List direct child delegations without copying child transcripts |

Every identity is explicitly tenant- and user-scoped. A root Session supplies both identities through `attach()` before its first business record. A child Session supplies its attached parent Session and inherits that owner. Repeating the same attachment is idempotent; changing a Session's binding is a conflict. Recovery code that opens stored Sessions must attach them during its initial scan because restored seed events are not emitted again.

## Semantic Records

`AgentRecord` includes the Provider-assigned contiguous `sequence` and the original Session `sourceSequence`. `sequence` provides business ordering; `sourceSequence` gives a projection a stable source identity when it scans or retries Session events. One source event may produce multiple adjacent records in one atomic append, such as `assistant/interrupted` plus `turn/completed`. A retry with the same record identities and content is idempotent, while a different range at a stale `expectedNextSequence` fails.

The closed first-version types are `user/message`, `assistant/message`, `assistant/interrupted`, `tool/call`, `tool/result`, `approval/asked`, `approval/decided`, `subagent/started`, `subagent/completed`, `file/published`, and `turn/completed`. Every entry is a complete small record. `assistant/chunk`, reasoning delta, tool-argument delta, transport frames, heartbeats, and transient progress do not belong in this service.

`assistant/interrupted` contains attempt identity, an optional safe error code, and an optional generated-character count; it contains no partial assistant text. A later projection derives it from an interrupted, aborted, or failed turn boundary rather than adding a new core Session event.

Conversation retention defaults to `{ kind: 'permanent' }`. A tenant policy may provide its revision and optional archive or deletion timestamps. Authorization for configuring or applying that policy remains outside this service.

## Implementing a Provider

A Provider subclasses `ConversationService` and implements attachment, creation, atomic append, and the four query operations. It must enforce tenant/user ownership in the authoritative operation, allocate or verify contiguous sequence ranges atomically, make exact append retries idempotent, and bind every opaque cursor to the complete query scope and filters.

The shared suite in `tests/contract.ts` is the normative Provider test. In-repository Providers bind `runConversationContract()` to a fresh empty storage medium and add backend-specific concurrency, transaction, schema, and restart tests.

## Failure Semantics

`ConversationError` exposes `invalid-input`, `conversation-not-found`, `conversation-conflict`, `sequence-conflict`, `record-conflict`, and `provider-unavailable`. Provider diagnostics, SQL, credentials, record payloads, and file paths must not appear in transport-safe failures.

## Model Experience

### Semantic persistence

#### What the model sees

Nothing directly. This package registers no tool, prompt section, model message, or Session event. Consumers may persist facts that other model-input code already logged.

#### Token effect

Zero. Service calls do not add, remove, or rewrite model-input tokens.

#### KV Cache effect

Independent. Persisting or querying semantic records does not change a model-visible request prefix.

## Known Limitations and Deferred Work

- **No production Provider** - MySQL schema, transactions, keyset encoding, batching, retry, and flush belong to later Provider and persistence-policy packages.
- **No Session event mapper** - this package defines semantic destinations; a later Consumer maps complete Session facts and ignores chunk-level events.
- **No storage policy** - the planned 256 KiB tool-result spill threshold, queue bounds, and flush points do not belong to this Service Definition.
- **No authorization** - authenticated tenant and user context must be established before attachment or query.
- **No file bytes** - `file/published` carries a stable reference only; file lifecycle and bytes belong to file-storage Providers.
