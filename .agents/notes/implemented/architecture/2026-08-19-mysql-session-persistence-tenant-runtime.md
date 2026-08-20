# Agent Note: MySQL session persistence is a tenant/user-runtime plugin

Status: implemented

English | [中文](2026-08-19-mysql-session-persistence-tenant-runtime.zh.md)

## Problem

The multi-user host needs a durable session backend that can share one MySQL server without allowing a session id from one tenant runtime to resolve a session belonging to another runtime. The existing `SessionPersistence` seam owns event-log semantics, while the MySQL connection service owns pooled connections and transaction lifecycle. A backend-specific implementation must preserve both ownership rules without moving multi-user branching into the session loop.

## Decision

`@deepseek-ai/dsh-session-persistence-mysql` is a separate Host plugin that implements `SessionPersistence` and injects `ctx.sessions`, `ctx.users`, and `ctx.mysql`. One configured provider instance represents one trusted tenant/user runtime scope. Its `tenantId` and `ownerUserId` are validated plugin configuration, never request fields, and every session and record query includes the owner scope. The composite `(tenant_id, session_id)` primary key remains the physical identity, while `(tenant_id, owner_id)` links each session to `dsh_users`.

The provider delegates buffering, write-behind, checkpoint barriers, preparation reuse, crash recovery, and disposal quiescence to `PersistenceCoordinator`. Its storage primitive writes a contiguous batch in one `ctx.mysql.transaction()` call. The transaction locks the session row, verifies the next sequence number, inserts immutable records, advances `next_seq` and `revision`, and commits the lazy materialization together with the first event batch. A failure rolls back the complete batch.

The canonical logical log remains the existing `SessionEvent` stream. A consecutive `assistant/chunk` run is encoded with `packChunkRuns`, gzip-compressed, checksummed, and stored as one physical record. `decodeStorageRecord` expands it during reads and verifies its sequence range and event count. This is physical packing, not deletion or message-only projection; assistant messages, tool calls/results, user messages, and turn boundaries remain reconstructable with their original sequence numbers.

The schema is owned by the plugin and stamped with a monotonic version row. Version 2 contains a state marker, user-owned session metadata, and tenant-scoped immutable records. Session creation writes `owner_kind='user'` and the trusted `ownerUserId`; a composite foreign key points to `dsh_users`. A v1 table containing ownerless rows is rejected during startup instead of being silently assigned to a user. Schema initialization runs during plugin service initialization and rejects unsupported versions.

`@deepseek-ai/dsh-mysql` exposes callback-scoped connections and a transaction helper. Pool lifecycle methods and transaction lifecycle methods are hidden from consumers; leases expire after callback settlement, reset the connection before reuse, and drain before service disposal. This keeps the persistence plugin from owning driver lifecycle or leaking a connection outside its callback.

## Alternatives considered

**Put tenant branching in the session loop.** Rejected: the loop should emit and consume the existing session capability only. Tenant authorization belongs to the trusted runtime composition and the backend's storage scope.

**Use a process-global session id primary key.** Rejected: ids are only unique within the configured tenant scope in the multi-user design. The composite key makes accidental cross-tenant reads fail as not-found at the storage boundary.

**Persist only messages and discard chunks.** Rejected: `SessionEvent.seq` is append-only and source-event references can point to chunk sequences. Dropping rows would create gaps and make validation, resume, and repair incorrect. Packing preserves the full logical stream while reducing physical row count.

**Write each event synchronously or add Kafka/Outbox in this backend.** Rejected for this foundation: `PersistenceCoordinator` already supplies bounded asynchronous write-behind and its flush listeners define the durability barrier. CDC, Redis, Elasticsearch projections, and an Outbox are separate consumers and are deferred until their failure and retry contracts are owned.

**Expose raw `mysql2` connections to the plugin.** Rejected: callers could release a connection early, change session state, or commit outside the coordinator's transaction. The callback-scoped façade keeps those operations owned by `dsh-mysql`.

## Consequences

The plugin can be mounted beside the existing SQLite or JSONL providers and can use one MySQL database for many trusted tenant runtimes. Reads and writes are scoped to both tenant and the configured user, and batch atomicity is enforced by InnoDB transactions. Chunk-heavy sessions use fewer physical rows while preserving exact event replay. The first user-aware bridge is intentionally one provider instance per trusted owner; request-scoped `AuthenticatedCall` authorization and shared-process multiplexing are still deferred. Redis live streams, Kafka/CDC, Elasticsearch projections, and Outbox delivery remain separate consumers. Production schema migrations remain a later shared migration-service responsibility; the plugin currently ensures and validates its own versioned schema.

## Testing

The MySQL service tests cover transaction commit/rollback, façade restrictions, lease invalidation, pool cleanup, and disposal drainage. The user provider tests cover lifecycle and tenant isolation. The MySQL persistence integration tests boot the real Cordis composition against Docker MySQL, round-trip a packed chunk run, verify sequence reconstruction and physical row reduction, bind a session to a user, and assert that another user cannot load or list it.
