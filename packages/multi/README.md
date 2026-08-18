# multi/ - multi-user data infrastructure

English | [中文](README.zh.md)

This group contains Host-only infrastructure services used by multi-user domain plugins. Infrastructure packages own database clients and their lifecycle; authentication, sessions, settings, audit, and other domain Consumers own their tables and SQL.

| Package | Role | ctx key |
|---|---|---|
| [`mysql/`](mysql/README.md) | Owns the MySQL pool and callback-scoped connection leases | `ctx.mysql` |

The [MySQL connection-service decision](../../.agents/notes/implemented/architecture/2026-08-18-mysql-connection-service.md) records the current lifecycle and deliberately deferred database capabilities.
