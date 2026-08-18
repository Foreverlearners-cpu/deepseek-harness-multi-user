# 多用户基础设施

[English](README.md) | 中文

供多用户领域插件共享的仅限 Host 的基础设施。本组拥有面向部署的 client 机制；授权与搜索 projection 领域仍保留各自服务与数据所有权。

| 包 | Context 键 | 职责 |
|---|---|---|
| [`@deepseek-ai/dsh-elasticsearch`](elasticsearch/README.md) | `ctx.elasticsearch` | Elasticsearch client 生命周期与 callback-scoped operation |

[Elasticsearch 基础设施参考](../../docs/infrastructure/dsh-elasticsearch.md)说明当前所有权，并链接拟议的 projection、隔离与一致性设计。
