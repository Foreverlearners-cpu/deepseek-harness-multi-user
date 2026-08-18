# multi/：多用户数据基础设施

[English](README.md) | 中文

本组包含供多用户领域插件使用的仅限 Host 基础设施服务。基础设施包拥有数据库客户端及其生命周期；认证、会话、设置、审计和其他领域消费方拥有自身数据表与 SQL。

| 包 | 职责 | ctx key |
|---|---|---|
| [`mysql/`](mysql/README.md) | 拥有 MySQL 连接池和 callback 作用域的连接租用 | `ctx.mysql` |

[MySQL 连接服务决策](../../.agents/notes/implemented/architecture/2026-08-18-mysql-connection-service.md)记录了当前生命周期和明确暂缓的数据库能力。
