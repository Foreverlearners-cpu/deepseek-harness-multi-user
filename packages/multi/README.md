# Multi-user infrastructure

English | [中文](README.zh.md)

Host-only infrastructure shared by multi-user domain plugins. Infrastructure packages own deployment-facing clients and their lifecycle; domain Consumers own authorization, projections, tables, queries, and other domain data.

| Package | Context key | Role |
|---|---|---|
| [`@deepseek-ai/dsh-elasticsearch`](elasticsearch/README.md) | `ctx.elasticsearch` | Elasticsearch client lifecycle and callback-scoped operations |
| [`@deepseek-ai/dsh-mysql`](mysql/README.md) | `ctx.mysql` | MySQL pool lifecycle and callback-scoped connection leases |
| [`@deepseek-ai/dsh-redis`](redis/README.md) | `ctx.redis` | Redis client lifecycle and callback-scoped shared-client operations |
| [`@deepseek-ai/dsh-kafka`](kafka/README.md) | `ctx.kafka` | Kafka broker lifecycle, metadata health, publishing, and subscriptions |
| [`@deepseek-ai/dsh-kafka-events`](kafka-events/README.md) | `ctx.kafkaEvents` | Protocol-neutral typed event producers and consumers over Kafka |
| [`@deepseek-ai/dsh-cdc-protocol`](cdc-protocol/README.md) | - | Transport-independent CDC types and strict wire codec |
| [`@deepseek-ai/dsh-kafka-events`](kafka-events/README.md) | `ctx.kafkaEvents` | Protocol-neutral typed event producers and consumers over Kafka |
| [`@deepseek-ai/dsh-cdc`](cdc/README.md) | `ctx.cdc` | MySQL row-change capture and at-least-once Kafka publication |
| [`@deepseek-ai/dsh-cdc-redis`](cdc-redis/README.md) | - | Kafka CDC projection into Redis |
| [`@deepseek-ai/dsh-cdc-elasticsearch`](cdc-elasticsearch/README.md) | - | Kafka CDC projection into Elasticsearch |

The [Elasticsearch infrastructure reference](../../docs/infrastructure/dsh-elasticsearch.md) maps current ownership and links the proposed projection, isolation, and consistency design.

The [MySQL connection-service decision](../../.agents/notes/implemented/architecture/2026-08-18-mysql-connection-service.md) records the current lifecycle and deliberately deferred database capabilities.

The [dsh-redis infrastructure reference](../../docs/infrastructure/dsh-redis.md) defines the Redis data, authorization, isolation, and deployment rules.

Domain plugins retain ownership of authorization, event schemas, topics, partition keys, and durable state. Infrastructure connectivity does not grant access to tenant data.
