# `@deepseek-ai/dsh-conversation-persistence-mysql`

English | [中文](README.zh.md)

This plugin is the ToC conversation read/write model. Its `./session-persistence` entry is the AgentLoop-compatible resume adapter used by the MySQL Web profile; the legacy `@deepseek-ai/dsh-session-persistence-mysql` remains available as a compatibility provider for deployments that still need lossless event-log replay.

## Persistence boundary

- `assistant/chunk`, reasoning deltas, and tool-call deltas stay in the live `Session` memory and are streamed to the UI.
- The caller appends one final `user/message`, `assistant/message`, or `tool/result` row after a turn. `appendMessages()` can commit a whole turn in one MySQL transaction.
- The same transaction records model attempts and semantic Outbox rows. `./outbox-consumer` can poll those rows and fan out idempotently to Kafka, Redis, and Elasticsearch; downstream failure never rolls back MySQL.
- An interrupted generation is represented as one `assistant/message` with `status: 'partial'` or `'failed'`; no chunk row is required for recovery.
- If MySQL is temporarily unavailable after a turn is assembled, the optional JSONL durable spool stores only the final message command and retries it on startup.
- JSON content and bounded `extensions` fields are validated before SQL parameters are sent.

## Files

`saveFile()` delegates bytes to the required `fileStorage` service and then commits metadata to MySQL. The shipped `@deepseek-ai/dsh-file-storage` provider uses a local content-addressed layout (`objects/<first-two-sha256>/<sha256>`). MySQL stores the digest, size, media type, provider name, storage key, ownership, and message links, not a large BLOB. The provider root is configured independently (the Web profile uses `$DSH_HOME/conversation-files/v1`).

## Cordis composition

```ts
export {}
declare const ctx: { plugin(plugin: unknown, config?: unknown): Promise<unknown> }
declare const Mysql: unknown
declare const MysqlUserService: unknown
declare const FileStorageService: unknown
declare const MysqlConversationPersistence: unknown
declare const MysqlRuntimeConfigStore: unknown
declare const mysqlConfig: unknown
declare const userId: string
await ctx.plugin(Mysql, mysqlConfig)
await ctx.plugin(MysqlUserService, { bootstrapUserId: userId })
await ctx.plugin(FileStorageService, { root: 'C:/dsh-data/conversation-files/v1' })
await ctx.plugin(MysqlConversationPersistence, { userId })
await ctx.plugin(MysqlRuntimeConfigStore)
```

The `userId` is trusted authentication context supplied when the host composes the plugin. Every conversation, message, attempt, and file query includes that user predicate; a session id alone is never an authorization credential. MySQL stores `user_id` directly on conversations, messages, attempts, conversation files, and Outbox rows. Composite foreign keys `(session_id, user_id)` keep each child row consistent with its conversation.

## Model Experience

### Message-only persistence

#### What the model sees

The plugin contributes no prompt or tool schema. It reconstructs final `user/message`, `assistant/message`, and `tool/result` rows for resume while keeping streaming chunks out of the durable message projection.

#### Token effect

Zero direct tokens during normal operation; persistence and retry metadata are host-side. A recovery adapter may append one short unknown-outcome result when an interrupted tool call has no durable result.

#### KV Cache effect

None for successful writes. Resumed conversations reuse the durable message prefix; a recovery result is appended after that prefix.

## Known Limitations and Deferred Work

- MySQL is the authority for message rows, but the optional outbox consumers are at-least-once and require sink-side idempotency.
- File bytes use the local content-addressed provider in this package family; S3/MinIO adapters remain deferred.
- A crash between an external side effect and its result cannot prove exactly-once execution; recovery records an unknown outcome instead of retrying automatically.
