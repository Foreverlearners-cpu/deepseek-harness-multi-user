# 多用户基础设施

[English](README.md) | 中文

供多用户领域插件共享的仅限 Host 的基础设施。本组拥有面向部署的连接机制；认证、租户、会话持久化、设置、审计、搜索 projection 和其他领域仍保留各自服务与数据所有权。

| 包 | Context 键 | 职责 |
|---|---|---|
| [`@deepseek-ai/dsh-redis`](redis/README.md) | `ctx.redis` | Redis client 生命周期与回调范围内的共享客户端操作 |

[dsh-redis 基础设施参考](../../docs/infrastructure/dsh-redis.md)定义了 Redis 数据、授权、隔离和部署规则。
