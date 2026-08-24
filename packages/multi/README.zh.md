# 多用户基础设施

[English](README.md) | 中文

供多用户领域插件共享的仅限 Host 的基础设施。基础设施包拥有面向部署的客户端及其生命周期；领域消费方拥有授权、projection、数据表、查询和其他领域数据。

| 包 | Context 键 | 职责 |
|---|---|---|
| [`@deepseek-ai/dsh-elasticsearch`](elasticsearch/README.md) | `ctx.elasticsearch` | Elasticsearch client 生命周期与 callback-scoped operation |
| [`@deepseek-ai/dsh-mysql`](mysql/README.md) | `ctx.mysql` | MySQL 连接池生命周期与 callback 作用域的连接租用 |
| [`@deepseek-ai/dsh-redis`](redis/README.md) | `ctx.redis` | Redis client 生命周期与回调范围内的共享客户端操作 |
| [`@deepseek-ai/dsh-kafka`](kafka/README.md) | `ctx.kafka` | Kafka broker 生命周期、metadata health、生产与订阅 |
| [`@deepseek-ai/dsh-kafka-events`](kafka-events/README.md) | `ctx.kafkaEvents` | Kafka 之上的协议无关强类型事件生产者和消费者 |
| [`@deepseek-ai/dsh-cdc-protocol`](cdc-protocol/README.md) | - | 传输无关的 CDC 类型与严格协议 codec |
| [`@deepseek-ai/dsh-kafka-events`](kafka-events/README.md) | `ctx.kafkaEvents` | Kafka 之上的协议无关强类型事件生产者和消费者 |
| [`@deepseek-ai/dsh-cdc`](cdc/README.md) | `ctx.cdc` | MySQL 行变更采集与至少一次 Kafka 发布 |
| [`@deepseek-ai/dsh-cdc-redis`](cdc-redis/README.md) | - | 将 Kafka CDC 事件投影到 Redis |
| [`@deepseek-ai/dsh-cdc-elasticsearch`](cdc-elasticsearch/README.md) | - | 将 Kafka CDC 事件投影到 Elasticsearch |

[Elasticsearch 基础设施参考](../../docs/infrastructure/dsh-elasticsearch.md)说明当前所有权，并链接拟议的 projection、隔离与一致性设计。

[MySQL 连接服务决策](../../.agents/notes/implemented/architecture/2026-08-18-mysql-connection-service.md)记录了当前生命周期和明确暂缓的数据库能力。

[dsh-redis 基础设施参考](../../docs/infrastructure/dsh-redis.md)定义了 Redis 数据、授权、隔离和部署规则。

领域插件继续负责 authorization、event schema、topic、partition key 和持久状态。基础设施连接不会授予 tenant data 访问权。
