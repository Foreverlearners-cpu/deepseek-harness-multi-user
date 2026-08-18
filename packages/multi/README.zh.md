# 多用户基础设施

[English](README.md) | 中文

供多用户领域插件共享的仅限 Host 的基础设施。基础设施包拥有面向部署的客户端及其生命周期；领域消费方拥有授权、projection、数据表、查询和其他领域数据。

| 包 | Context 键 | 职责 |
|---|---|---|
| [`@deepseek-ai/dsh-elasticsearch`](elasticsearch/README.md) | `ctx.elasticsearch` | Elasticsearch client 生命周期与 callback-scoped operation |
| [`@deepseek-ai/dsh-mysql`](mysql/README.md) | `ctx.mysql` | MySQL 连接池生命周期与 callback 作用域的连接租用 |

[Elasticsearch 基础设施参考](../../docs/infrastructure/dsh-elasticsearch.md)说明当前所有权，并链接拟议的 projection、隔离与一致性设计。

[MySQL 连接服务决策](../../.agents/notes/implemented/architecture/2026-08-18-mysql-connection-service.md)记录了当前生命周期和明确暂缓的数据库能力。
