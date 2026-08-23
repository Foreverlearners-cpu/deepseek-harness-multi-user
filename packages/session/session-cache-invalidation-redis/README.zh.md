# @deepseek-ai/dsh-session-cache-invalidation-redis

[English](README.md) | 中文

仅限 Host 的消费方，通过 `dsh-cdc-protocol` 和 `dsh-kafka-events` 校验 session message CDC 记录，然后原子推进 Redis revision 水位并删除 tenant 隔离的完整 session cache。

## 配置

所有字段都是必填项：`topic`、`groupId`、`subscriptionId`、`fallbackMode`、`maxBytes`、`database`、`table` 和 `schemaFingerprint`。Kafka service 必须授权相同的 topic 和 group。源 route 与 schema fingerprint 必须准确匹配。

## 事件规则

配置表必须准确包含 `tenant_id`、`user_id`、`session_id`、`message_id`、`revision`、`status`、`visibility`、`role`、`visible_text` 和 `occurred_at`。Kafka key 必须准确包含四个 identity 字段，并且等于已编码 event key 和两个可用行镜像。insert 与 delete 会失效缓存。update 只有在 `changedColumns` 存在且与 `status`、`visibility`、`role`、`visible_text`、`occurred_at` 都没有交集时才跳过；缺少 hint 时保守失效。

## Redis 一致性

cache key 和 watermark key 都包含 `tenantId`、`userId` 与 `sessionId`。失效操作使用一个 Lua operation 比较规范正十进制 revision，只为更新的权威 revision 推进 watermark 并删除 cache。Kafka partition offset 绝不会成为数据 version。

`refillSessionContextCache()` 是 cache population 必须使用的 helper。它通过 Lua comparison 拒绝低于当前 watermark 的 candidate，并原子写入被接受的值，防止旧 database read 在失效后重新填充 cache。

decode、route、identity、schema、Redis 和 script failure 都会拒绝 event handler，因此 `dsh-kafka-events` 无法允许 offset commit。dispose 会关闭并排空所属 typed subscription。

## Model Experience

无。该消费方没有面向模型的输出、token effect 或 KV Cache effect。

## Known Limitations and Deferred Work

- 遇到无效记录与 Redis failure 时本包会 fail-stop；retry topic 与 dead-letter administration 位于包外。
- 完整 cache rebuild 与 reconciliation 仍由 session read owner 负责。
- schema change 需要显式更新配置并协调部署。
