# Agent Note：受监督的会话 CDC 组合

状态：已实现

[English](2026-08-24-session-cdc-starter.md) | 中文

## 问题

Redis cache invalidator 与 Elasticsearch search projection 必须同时收到每一条会话消息 CDC 记录，作为一个部署单元启动和停止，并提供有边界的健康信号。历史修复必须复用二者的幂等权威写入器，同时不能让任一 adapter 依赖 reconciler。

## 决策

`@deepseek-ai/dsh-session-cdc-starter` 是普通 Cordis 组合插件。它依次挂载 typed Kafka events、Elasticsearch projection、Redis invalidation 与可选 reconciliation。两个 consumer 在同一个精确 topic/database/table route 上使用不同 Kafka group 和 subscription id；Redis schema fingerprint 必须属于 Elasticsearch 的显式 allowlist。

Starter 对外提供不含 payload 的聚合健康状态，并监督两个预期 subscription id。任一 subscription 缺失或不是 running 都会 fail-stop 整个 scope。可选 reconciliation 注册两个命名 sink，调用 adapter 不依赖 Kafka 的权威写入器。应用仍负责权威快照 source 与任务调度。

## 结果

同一条 CDC 记录会到达两个独立提交的副作用，部分启动会回滚，运行时 consumer 丢失不会留下虚假的健康组合。实时处理和修复共用 revision 排序与 tombstone 行为。部署必须准备 Kafka groups 与 Elasticsearch mapping、注入 reconciler source，并负责 retry/dead-letter 和重启策略。
