# Multi-user infrastructure

English | [中文](README.zh.md)

Host-only infrastructure shared by multi-user domain plugins. Infrastructure packages own deployment-facing clients and their lifecycle; domain Consumers own authorization, projections, tables, queries, and other domain data.

| Package | Context key | Role |
|---|---|---|
| [`@deepseek-ai/dsh-elasticsearch`](elasticsearch/README.md) | `ctx.elasticsearch` | Elasticsearch client lifecycle and callback-scoped operations |
| [`@deepseek-ai/dsh-mysql`](mysql/README.md) | `ctx.mysql` | MySQL pool lifecycle and callback-scoped connection leases |
| [`@deepseek-ai/dsh-redis`](redis/README.md) | `ctx.redis` | Redis client lifecycle and callback-scoped shared-client operations |

The [Elasticsearch infrastructure reference](../../docs/infrastructure/dsh-elasticsearch.md) maps current ownership and links the proposed projection, isolation, and consistency design.

The [MySQL connection-service decision](../../.agents/notes/implemented/architecture/2026-08-18-mysql-connection-service.md) records the current lifecycle and deliberately deferred database capabilities.

The [dsh-redis infrastructure reference](../../docs/infrastructure/dsh-redis.md) defines the Redis data, authorization, isolation, and deployment rules.
