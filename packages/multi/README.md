# Multi-user infrastructure

English | [中文](README.zh.md)

Host-only infrastructure shared by multi-user domain plugins. This group owns deployment-facing connection mechanics; authentication, tenancy, session persistence, settings, audit, search projections, and other domains retain their own services and data ownership.

| Package | Context key | Role |
|---|---|---|
| [`@deepseek-ai/dsh-redis`](redis/README.md) | `ctx.redis` | Redis client lifecycle and callback-scoped shared-client operations |

The [dsh-redis infrastructure reference](../../docs/infrastructure/dsh-redis.md) defines the Redis data, authorization, isolation, and deployment rules.
