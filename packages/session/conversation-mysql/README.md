# @deepseek-ai/dsh-conversation-mysql

English | [中文](README.zh.md)

MySQL Provider for [`@deepseek-ai/dsh-conversation`](../conversation/README.md). It registers `ctx.conversations`, injects the Host-only `ctx.mysql` connection service, and stores semantic records and query projections permanently. It does not change or depend on CDC plugins.

The Provider owns `dsh_conversation_schema`, `dsh_conversations`, `dsh_agent_records`, `dsh_conversation_messages`, `dsh_conversation_message_state`, and `dsh_subagent_runs`. Startup serializes schema initialization with a database-scoped `GET_LOCK`, rejects incompatible or partial schemas, and records version 1 only after all owned tables exist. `occurred_at`, `created_at`, and `updated_at` use canonical 24-character UTC timestamps. The CDC-facing `dsh_conversation_messages` table contains exactly `tenant_id`, `user_id`, `session_id`, `message_id`, `revision`, `status`, `visibility`, `role`, `visible_text`, and `occurred_at`; internal pagination state is isolated in `dsh_conversation_message_state`. Message text uses `MEDIUMTEXT`, `revision` is `INT UNSIGNED`, and message identity is the four-field primary key.

`append()` locks the scoped conversation row and commits records, messages, the latest title, subagent projections, revision, and `nextSequence` in one transaction. Message projection preserves each record's explicit `user` or `internal` visibility. Records sharing a `sourceSequence` remain one adjacent group and share a SHA-256 over canonical complete records. Exact retries must match every record and group hash. New records use multi-value inserts of at most 64 rows, so 300 records require five record INSERT statements without splitting the outer transaction. The Provider never uses `INSERT IGNORE`.

All reads require tenant, user, and conversation identity. Listing uses filter-bound opaque keyset cursors rather than offsets. V1 retention is permanent; tenant archival policy remains a later domain feature.

```yaml
- name: mysql
  config:
    host: 127.0.0.1
    user: dsh
    password: ${DSH_MYSQL_PASSWORD}
    database: dsh
- name: conversation-mysql
```

## Model Experience

### MySQL conversation persistence

#### What the model sees

`None`. The Provider persists records already selected by the Conversation Consumer and registers no tools, prompts, or model messages.

#### Token effect

Zero direct tokens per request.

#### KV Cache effect

Independent of model requests.

## Known Limitations and Deferred Work

- V1 supports permanent retention only; archival and deletion policy execution are deferred.
- Schema migration beyond version 1, replica reads, CDC publication, and object garbage collection are outside this Provider.
- Queries return complete records and messages; server-side full-text search and range/object joins are deferred to projections.
