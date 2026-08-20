# @deepseek-ai/dsh-session-persistence-mysql

English | [中文](README.zh.md)

User-scoped MySQL `SessionPersistence` provider. It reuses `PersistenceCoordinator` for bounded write-behind, checkpoints, recovery and disposal, and uses `@deepseek-ai/dsh-mysql` for connection and transaction ownership. The provider stores ordinary session events as records and losslessly packs consecutive `assistant/chunk` delta runs with gzip; loading expands them back to the original logical events.

## Configuration

| Key | Required | Meaning |
| --- | --- | --- |
| `ownerUserId` | yes | Trusted authenticated user identity bound to this provider instance. Session headers must carry the same user id. |
| `preparedSessionCacheSize` | no | Maximum detached preparations retained by the coordinator; defaults to the shared persistence value. |
| `writeBatchMaxDelayMs` | no | Maximum intentional write-behind delay; defaults to the shared persistence value. |

The plugin requires `ctx.mysql`, `ctx.users` and `ctx.sessions`. It requires the configured owner user to be active before exposing the backend. MySQL schema objects are owned by this package and are not exposed as model tools or dynamic Host services.

## Durability and chunk storage

`appendBatch` locks the session row, checks the `ownerUserId` owner and next expected sequence, inserts immutable record rows, advances the revision and sequence cursor, and commits as one transaction. A failed transaction leaves the session unchanged. New databases contain no `tenant_id` column.

The database stores a packed representation, not a lossy message-only projection. `assistant/chunk` runs are encoded with the existing session chunk-row vocabulary and compressed as one row; checksum, sequence range and event count are verified during reads. `assistant/message`, `tool/call`, `tool/result`, user messages and turn boundaries remain logically present and can be reconstructed exactly.

## Model Experience

### MySQL session persistence

#### What the model sees

Nothing directly. The package adds no tools, prompts, messages or model-facing catalog entries. Session history continues to come from `ctx.sessionPersistence` and the session event log.

#### Token effect

None directly. Database writes happen outside model requests.

#### KV Cache effect

None directly. Persistence does not alter the model request prefix.

## Known Limitations and Deferred Work

- The first user-aware bridge binds one provider instance to one trusted `ownerUserId`; request-scoped authentication and tenant scoping are deferred.
- A legacy schema containing `tenant_id` is rejected at startup; recreate this unreleased database or run an explicit user-id-only migration.
- Schema setup currently runs during plugin initialization; a shared migration service can own versioned migration execution before production deployment.
- Raw stream artifacts, Redis live streams, Kafka/CDC delivery, Elasticsearch projections and outbox records are not implemented here.
