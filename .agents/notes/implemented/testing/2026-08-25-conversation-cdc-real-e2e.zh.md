# Agent Note：真实 Conversation MySQL 到 Kafka CDC 端到端测试

Status: implemented

[English](2026-08-25-conversation-cdc-real-e2e.md) | 中文

## 问题

Conversation 持久化与 CDC 原本各自有真实服务测试，但没有测试证明两者共享的物理契约。一次改动可能让 `ConversationMysql` 测试仍然通过，却改变 CDC 消费方依赖的消息表、Kafka key 顺序、row image 完整性、时间格式或 checkpoint 行为。单元测试替身也无法证明 agent 一轮产生的 300 条消息在真实 MySQL binlog checkpoint 重启后不丢失、不重复。

## 决策

新增一个选择性启用的端到端测试，对开发环境中的真实 MySQL 与 Kafka 挂载 `Mysql`、`ConversationMysql`、`KafkaService` 和 `CdcService`。测试只通过 `ctx.conversations.append()` 写入两批各 150 条消息，在两批之间使用同一 checkpoint 销毁并重建 CDC，并用唯一 consumer group 消费唯一的单分区 Kafka topic。

测试把 `dsh_conversation_messages` 视为有意保持精简的 CDC 投影：物理表必须恰好十列，不配置 `excludeColumns`；复合 Kafka key 必须依次为 `tenant_id`、`user_id`、`session_id`、`message_id`；row image 必须包含完整十字段；时间必须是规范 UTC。测试要求恰好收到 300 条唯一 insert 事件，并要求事件流与 checkpoint 始终使用同一个 schema fingerprint。清理操作只针对随机生成的 tenant 和 topic，不删除共享表、数据库或容器。

## 曾考虑的替代方案

**通过 SQL 直接写入 CDC 表。** 这只能测试 binlog 传输，不能证明公开 Conversation Provider 会生成约定的表记录，也可能悄悄偏离 `ctx.conversations.append()` 的投影规则。

**模拟 MySQL 或 Kafka。** 模拟无法覆盖 row metadata、row-image 设置、事务边界、Kafka key 原始字节、consumer offset 或 checkpoint 重启行为，而这些正是本测试要验证的契约。

**持久化流式 chunk，再由消费方重组消息。** Conversation 存储有意发布完成的语义记录，而不是传输 chunk。保存 chunk 会放大写入量和事件量，却不会改善本方案要求的恢复粒度。

## 后果

开发者可通过 `DSH_CONVERSATION_CDC_E2E=1` 选择运行一条不会破坏共享资源的真实服务验证。测试依赖文档约定的本地 MySQL binlog 用户和 Kafka broker，会创建一个临时 topic，耗时也会长于单元测试。以后若改变消息物理 schema 或 key 顺序，必须明确协调 CDC 消费方，而不能悄然通过测试。

当前 Elasticsearch Conversation 投影会拒绝空白或仅包含空格的 `visible_text`，而 MySQL 与 Redis 路径可以表示这种值。本端到端测试记录该集成风险，但不改变 Elasticsearch 运行时策略；在把此类消息路由到 ES 前，需要另行作出决策并补充测试。
