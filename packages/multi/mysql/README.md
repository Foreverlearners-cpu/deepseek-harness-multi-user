# @deepseek-ai/dsh-mysql

English | [中文](README.zh.md)

Host-only MySQL connection service for relational domain plugins. The package exposes `ctx.mysql.connection(callback)`, owns one `mysql2` pool, verifies connectivity during startup, resets each leased server session before reuse, and drains admitted callbacks before closing the pool. It implements the first stage of the [dsh-mysql infrastructure proposal](../../../docs/infrastructure/dsh-mysql.md); authentication, session persistence, settings, audit, and other domains remain separate Consumers that own their tables and SQL.

## Configuration

| Key | Required | Meaning |
|---|---|---|
| `host` | yes | MySQL server hostname or IP address |
| `port` | no | TCP port; defaults to `3306` |
| `user` | yes | Bootstrap database user |
| `password` | yes | Bootstrap password; the config schema marks it as a secret |
| `database` | yes | Database selected for each pooled connection |
| `connectionLimit` | no | Maximum pool connections; defaults to `10` |
| `connectTimeoutMs` | no | Connection-establishment timeout in milliseconds; defaults to `10000` and must not exceed `2147483647` |

The service fails plugin activation when it cannot acquire and ping a connection. It does not log configuration or connection errors, so passwords and connection parameters are not copied into package-owned diagnostics.

## Connection lifecycle

`connection(callback)` admits one operation, waits for a pool connection, and invokes the callback with a `MysqlConnection` façade. The façade omits pool lifecycle methods and raw driver state; it and any prepared statement obtained through it reject operations after callback settlement, and returning either from the callback rejects the lease. After the callback settles, the service issues MySQL `COM_RESET_CONNECTION` to roll back an open transaction and clear session variables and temporary state, then reselects the configured database before releasing the lease. A failed reset or database restore destroys that connection instead of returning uncertain state to the pool; cleanup does not replace the callback's result or error. Disposal stops admission, waits for every admitted callback including callers queued in the pool and connection reset, and calls `pool.end()` only after cleanup completes.

`transaction(callback)` uses the same lease and owns `BEGIN`, `COMMIT`, and `ROLLBACK`. The callback receives a query-only transaction façade, so it cannot settle the transaction or release the connection itself. Callback and commit failures roll back; an uncertain cleanup destroys the connection.

## Model Experience

### MySQL connections

#### What the model sees

Nothing. `ctx.mysql` is available only to trusted Host plugins, is absent from the model-facing Cordis API catalog, and is denied by the dynamic Host sandbox through declared injection, optional `ctx.get()` lookup, and `ctx.provide()` registration. This package registers no tools, prompts, messages, or session events.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: database connection activity never changes a request prefix.

## Known Limitations and Deferred Work

- **Narrow infrastructure API** — migrations, error classification, query timeouts, cancellation, health reporting, and observability are not implemented yet.
- **One TCP target** — named bindings, Unix sockets, TLS policy, replicas, and separate migration credentials remain deferred.
- **Unbounded callback drain** — disposal waits for admitted callbacks without a shutdown deadline; callers must settle their database work.
