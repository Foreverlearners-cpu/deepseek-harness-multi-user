# Agent Note: 会话搜索 CDC 行投影

Status: implemented

[English](2026-08-23-session-search-cdc-row-projection.md) | 中文

## 问题

会话搜索需要为每条完整可见消息建立租户隔离的 Elasticsearch 文档，同时不能让 CDC producer 耦合搜索行为。Kafka 是至少一次交付并可能重放旧记录，因此延迟的 update 或 delete 不能覆盖较新的索引状态。

## 决策

`@deepseek-ai/dsh-session-search-projection-elasticsearch` 通过 `ctx.kafkaEvents` 消费 `CdcEvent`，并投影固定的会话消息行格式。它只接受配置的 topic、database、table、schema fingerprint，以及相互匹配的 Kafka、event 和 row-image key。Insert 和 update 使用 `after`，delete 使用 `before`。显式且无关的 `changedColumns` update 不写入即可确认；缺少提示时始终处理该行。

Document id 对 tenant、user 和 message 身份求哈希。权威正整数 `revision` 作为 Elasticsearch external version。Version conflict 证明已有相同或更新状态，因此可以确认。Delete、未完成行和对用户不可见的行写入版本化 tombstone；只有完成且用户可见的行包含 role 和可见文本。

插件在订阅前校验已有 index mapping。Elasticsearch 失败和无效 CDC 记录会在 Kafka commit 前拒绝 handler。订阅意外完成会卸载插件，而不会留下 active 但不消费的组件。

## 备选方案

**原样索引通用 CDC 行。** 拒绝，因为这会把存储字段名暴露为搜索 API，缺少租户安全的 document identity，并索引不完整或私有的消息状态。

**使用 Kafka partition offset 作为 Elasticsearch version。** 拒绝，因为 offset 无法跨 partition 或重新分区后比较。

**物理删除 Elasticsearch document。** 拒绝，因为保留版本化 tombstone 能阻止旧 upsert 复活已删除或隐藏的内容。

**每个 event 后查询数据库。** 该 row-image 实现拒绝此方案，因为固定完整 CDC 行已包含完整可见投影，额外读取会增加可用性和延迟耦合。

## 验证

聚焦测试覆盖可见内容索引、租户 document identity、delete 和隐藏状态 tombstone、权威 revision、错误 route、fingerprint 和 key、changed-column 过滤、缺失提示、version conflict、mapping 校验和 scoped subscription 关闭。

## 后果

可见消息文本会进入内部 Kafka CDC topic，因此 broker ACL、retention 和 operator 访问必须保护它。搜索调用方仍需执行已认证 tenant 与 user 过滤。历史回填、对账、index 创建、alias 和 revision 重置后的重建仍由 operator 工作流负责。
