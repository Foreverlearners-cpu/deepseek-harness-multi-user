# dsh-mysql infrastructure proposal

English | [中文](dsh-mysql.zh.md)

This reference defines the planned full `@deepseek-ai/dsh-mysql` Host capability. The shipped connection-only stage is documented by the [`dsh-mysql` package README](../../packages/multi/mysql/README.md). The service is an infrastructure dependency for identity, tenancy, session persistence, settings, audit, and other relational domains; it is not a model tool or a session-specific store.

## Scope

`dsh-mysql` owns MySQL connectivity, connection-pool lifecycle, transaction execution, schema-migration coordination, health, error classification, and database observability. Domain plugins own their tables, queries, authorization, retention, and data interpretation. A caller never gains session or identity access merely because it can name a database binding.

The initial package may contain both the MySQL Service Definition and its Service Provider. A provider-neutral relational package is deferred until a second implementation demonstrates a common API that does not hide dialect, migration, or failure differences. Consumers depend on `dsh-mysql` only inside trusted Host composition. Maintainer documentation includes its Typert-derived API, while the model-facing Cordis catalog, API Proxy, tools, dynamic packages, and execution worlds do not expose it.

The plugin contributes no prompt, tool schema, message, or model-visible data. Session restoration remains the responsibility of a `SessionPersistence` implementation, so model-visible input continues to come from the session event log rather than the database service.

## Package position

The package names below describe the proposed ownership split. Each domain Consumer keeps its existing public capability and uses `dsh-mysql` only as an internal driver.

| Proposed package | Role | Owned data or API |
|---|---|---|
| `@deepseek-ai/dsh-mysql` | MySQL Service Definition and Service Provider | Named bindings, pools, connections, transactions, migration catalog, health, and errors |
| `@deepseek-ai/dsh-session-persistence-mysql` | Consumer and `SessionPersistence` provider | Session headers, append-only event rows, recovery, revisions, and listings |
| `@deepseek-ai/dsh-auth-mysql` | Consumer and identity/tenancy provider | Principals, external identities, tenants, memberships, roles, service accounts, and token metadata |
| Domain MySQL plugins for settings, workspace, audit, and jobs | Consumers behind their domain services | Domain tables, scoped queries, retention, and outbox records |
| `@deepseek-ai/dsh-storage-mysql` | Optional `StorageBackend.kv` Consumer | The existing simple KV form for domains that need no relational query or cross-table transaction |

The existing [`dsh-storage` backend](../../packages/storage/storage/README.md) exposes opaque KV units, while [`storage-domain`](../../packages/storage/storage-domain/README.md) deliberately has no cross-table transactions, secondary indexes, or multi-segment keys. `dsh-storage-mysql` may implement that narrow form, but authentication and session persistence must not be forced through it. The existing [`SessionPersistence` service](../../packages/session/session-persistence/README.md) remains the session contract.

## Service model

The proposed service is a registry of named database bindings. One binding owns one pool and one database target; control-plane and tenant-runtime compositions may use different bindings, credentials, or MySQL deployments without changing domain code.

```text
ctx.mysql
  binding(bindingId) -> MysqlBinding

MysqlBinding
  connection(options, callback)
  transaction(options, callback)
  migrate(owner, manifest, mode)
  health(signal)
```

`connection` and `transaction` lease a driver connection only for the callback. The callback must not retain that connection, a statement, or a transaction-scoped value after settlement. The binding stops new leases during disposal, waits for admitted callbacks up to the configured shutdown bound, destroys connections whose state is uncertain, and closes the pool before disposal resolves.

Every domain plugin selects a binding through validated Cordis plugin configuration. Missing bindings, duplicate binding names, unsupported server capabilities, invalid pool bounds, and an unusable database fail during plugin startup. A binding is explicit at the package boundary; no process-global default silently redirects a domain to another database.

## Configuration and bootstrap

All deployment-varying values are validated configuration rather than plugin constants.

| Configuration area | Required behavior |
|---|---|
| Endpoint and database | Resolve one explicit database target from a host or socket, port, and database name; verify expected server capabilities and reject ambiguous or incomplete targets |
| Bootstrap identity | Resolve a deployment-supplied user and secret without reading tenant credentials stored in the same MySQL deployment |
| TLS | Verify the server identity under server profiles; plaintext or verification bypass requires an explicit trusted-local profile |
| Pool | Configure minimum/maximum connections, acquisition timeout, idle lifetime, and shutdown bound |
| Execution | Configure query timeout, supported transaction isolation levels, UTC session time zone, `utf8mb4`, and required strict SQL behavior |
| Migration | Select `validate` or `apply`, migration-lock timeout, and the migration-capable binding when it differs from runtime credentials |

The MySQL password is a bootstrap secret. Server deployments inject it from an orchestrator or maintained secret service before MySQL-backed credential storage exists; tenant credential records cannot bootstrap their own database. Diagnostics and resolved configuration never expose passwords, connection URIs containing secrets, TLS private keys, or query parameters.

Production runtime credentials receive only required DML privileges. A dedicated migration composition uses DDL privileges and is removed after schema validation. Local profiles may combine those roles when their configuration explicitly accepts the weaker operational separation.

## Transaction and failure semantics

- A transaction callback uses one connection until commit or rollback completes. Nested calls either join an explicitly passed transaction or reject; they never open an independent transaction silently.
- A resolved transaction means `COMMIT` was acknowledged. Loss of connection while committing rejects with a distinct commit-unknown error, so the domain reconciles by durable idempotency key instead of repeating an operation blindly.
- Cancellation applies while waiting for a pool lease and while executing when the driver can cancel safely. If query completion cannot be established, the service destroys the connection before returning it to the pool.
- The service classifies duplicate-key, foreign-key, deadlock, lock-timeout, acquisition-timeout, cancellation, unavailable, schema, and commit-unknown failures without including SQL parameters or protected row content.
- `dsh-mysql` does not automatically rerun arbitrary transaction callbacks. A domain may retry a classified transient failure only when its database work and every external side effect are idempotent.
- Cross-system work does not run inside a database transaction. A domain commits its mutation and outbox record together; independent dispatchers deliver Redis invalidations and Elasticsearch documents after commit.
- Authorization, revocation, session resume, and other fresh reads use the primary. A domain may opt into a replica only for an explicitly stale-tolerant projection.

Statements use parameter binding for values and reviewed static construction for identifiers. Request payloads never become SQL fragments, table names, sort expressions, or migration identifiers.

## Schema ownership and migrations

`dsh-mysql` owns only its binding metadata and migration catalog. Each domain owns a unique migration namespace, its table definitions, indexes, constraints, seed records, and data conversions. Request handlers never create or alter schema objects.

- Migration ids increase monotonically within one owner namespace, and an applied id keeps an immutable checksum.
- One migration runner holds a database-scoped lock while validating and applying a manifest. Other instances wait within the configured bound or fail startup.
- `validate` rejects missing, pending, failed, checksum-mismatched, or unknown future migrations. `apply` runs only through an explicitly migration-capable composition.
- MySQL DDL is not treated as a multi-statement rollback transaction. Every migration defines restart behavior and leaves a recorded failure that must be reconciled before runtime readiness.
- A domain completes migration validation before registering services that can read or mutate its tables.
- Production backup and restore preserve the migration catalog and outbox. Restore validation completes before traffic resumes, while Redis and Elasticsearch projections rebuild from MySQL.

The repository's pre-release policy may reject an ownership-free local format instead of importing it implicitly. A separate importer writes the selected MySQL destination, validates counts and content references through ordinary domain services, and leaves the source unchanged.

## Tenant isolation

MySQL does not provide PostgreSQL-style row-level security, so application ownership checks and relational constraints are mandatory. Every tenant-owned table carries `tenant_id`; primary keys, unique constraints, foreign keys, list indexes, and retention indexes include the tenant before the resource id. Platform-global tables are explicitly classified and are unavailable through tenant product repositories.

Domain methods receive a trusted `TenantScope` derived from `AuthenticatedCall`. They query by composite tenant/resource keys before disclosing existence, content, counts, or timing-sensitive work. `dsh-mysql` does not infer a tenant from ambient process state and never accepts a request-supplied tenant as authorization.

Control-plane and tenant-runtime processes use separate least-privilege database identities. A shared MySQL deployment is an operational topology, not a security excuse: valid cross-tenant ids must reach no unscoped query. Deployments requiring a stronger database boundary may assign a tenant or tenant group a separate database and binding while retaining the same domain services.

The MySQL network, credentials, and client library stay outside model-controlled dynamic Host packages, containers, and microVMs. Those environments call authorized tools and provider adapters; they never receive `ctx.mysql`, a database socket, or a database credential.

## Domain Consumers

### Session persistence

`dsh-session-persistence-mysql` implements the existing append-only, contiguous-sequence, lazy-materialization, inspection, recovery, and revision requirements. It stores immutable tenant and owner metadata on the session row and event rows under `(tenant_id, session_id, seq)`. One append batch materializes the session when necessary and inserts all events in one transaction.

The agent loop continues to depend on `ctx.sessionPersistence`, not `ctx.mysql`. Session queries and Elasticsearch indexing consume the persistence/query capabilities or durable outbox, so changing a SQL driver does not grant a new path around session authorization.

### Identity and administration

Identity Consumers own users, external identity mappings, tenants, memberships, roles, service accounts, token verifiers, revocation state, quotas, and administrative revisions. Authentication secrets and model-provider credentials remain separate concerns. Security-sensitive mutations use optimistic or transactional preconditions and write their audit/outbox fact in the same MySQL transaction.

Redis may accelerate revocation or rate-limit checks, but a cache miss or Redis restart never converts an unverified principal into an authorized one. MySQL remains the durable authority for membership and grant state.

### General domain storage

Settings, workspaces, durable jobs, audit, and other relational domains use dedicated Consumers with narrow service APIs. An optional `dsh-storage-mysql` maps the existing KV form onto MySQL for simple records; it does not expose joins, arbitrary SQL, or transactions to `storage-domain`, and relational Consumers do not route through that KV adapter.

## Redis and Elasticsearch

MySQL, Redis, and Elasticsearch have distinct recovery and consistency rules.

| System | Role | Failure rule |
|---|---|---|
| MySQL | Authoritative relational state and transactional outbox | A required durable mutation fails when MySQL cannot establish its outcome |
| Redis | Cache, rate limits, runtime leases, short-lived idempotency hints, and pub/sub | Loss may degrade or fail closed but cannot erase authoritative state or grant access |
| Elasticsearch | Tenant-scoped search and analytical projections | Indexing is eventually consistent, idempotent by source identity/revision, and rebuildable from MySQL |

An outbox dispatcher delivers at least once. Redis and Elasticsearch Consumers deduplicate by stable event id and source revision, apply deletion tombstones, and expose lag. Search authorization supplies the tenant filter before Elasticsearch executes the query; post-filtering cross-tenant hits is forbidden.

Attachments, spill files, workspace contents, and large binary outputs remain in an object store or tenant volume. MySQL stores their authorized ownership references and lifecycle metadata; this plugin is not a binary object store.

## Lifecycle, security, and observability

- Readiness requires pool acquisition, a lightweight primary query, required server settings, and current migration state. Liveness does not depend on a successful database round trip.
- Metrics include pool capacity/use/waiters, acquisition and named-operation latency, transaction outcomes, classified failures, migration state, and outbox lag. Labels exclude SQL text, parameters, message content, secret values, and unbounded resource ids.
- Logs correlate a request, binding, operation name, and classified failure. They do not log connection URIs, SQL parameters, event payloads, authentication tokens, or credential values.
- Shutdown stops admission, reaches bounded quiescence, records callbacks that exceed the bound, destroys uncertain connections, and closes every pool. Graceful process exit must not leave migrations or acknowledged writes in an unknown local state.
- Backup, point-in-time recovery, replication, capacity, and retention objectives belong to deployment configuration. A restore invalidates Redis state and rebuilds Elasticsearch before those projections report readiness.

## Required verification

- A shared contract suite runs against a real MySQL server and covers pool admission, transactions, cancellation, classified errors, commit uncertainty, and quiescent disposal.
- Migration tests use concurrent application instances and prove lock exclusion, checksum drift rejection, restart behavior after partial DDL, and DML-only runtime credentials.
- Domain integration tests use valid resource ids from two tenants and prove that every read, list, append, update, delete, and foreign-key path remains tenant-scoped.
- Session tests run the existing persistence contract against MySQL, including crash recovery, append atomicity, revision stability, fork seeds, and cold resume.
- Outbox tests interrupt dispatch between commit and delivery and prove Redis/Elasticsearch convergence without duplicate authority or lost deletion.
- Assembled server tests prove that remote and model-controlled paths, including in-process dynamic Host packages, cannot obtain the MySQL service or database credentials; configured trusted Host Consumers retain access.

## Open decisions

- Maintained asynchronous MySQL driver and whether a query builder removes enough owned SQL without obscuring MySQL behavior.
- Shared deployment, separate control/session databases, or dedicated tenant databases for the first server profile.
- Migration execution as a dedicated command, deployment job, or restricted startup composition.
- Outbox polling versus binlog-based change capture, including ordering and retention.
- Exact pool, timeout, retry, backup, and recovery defaults for each deployment profile.

The [MySQL connection-service Agent Note](../../.agents/notes/implemented/architecture/2026-08-18-mysql-connection-service.md) records the implemented first-stage lifecycle decision.
