# multi/ — 多用户服务器基础设施

[English](README.md) | 中文

本组包含多用户服务器组合使用的 Host-only 基础设施。系统永远不会把这些服务投射到模型控制的执行环境中。

| 包 | 角色 | ctx key |
|---|---|---|
| [`kafka/`](kafka/README.md) | Kafka broker 连接、metadata health、错误分类和 client 生命周期 | `ctx.kafka` |

领域插件继续负责 authorization、event schema、topic、partition key 和持久状态。基础设施连接不会授予 tenant data 访问权。
