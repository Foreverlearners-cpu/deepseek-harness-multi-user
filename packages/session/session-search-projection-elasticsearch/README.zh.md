# `@deepseek-ai/dsh-session-search-projection-elasticsearch`

[English](README.md) | 中文

该 Host-only Consumer 校验 MySQL CDC row image，并维护租户隔离的 Elasticsearch 消息投影。它使用 `ctx.kafkaEvents` 管理解码与提交生命周期，使用 `ctx.elasticsearch` 执行版本化写入。

配置指定一个 Kafka topic、group、subscription id、无 offset 时的 fallback、payload 上限、来源 database/table、允许的 schema fingerprint 和一个已存在的 Elasticsearch index。来源行格式固定为：`tenant_id`、`user_id`、`session_id`、`message_id`、正整数 `revision`、`status`、`visibility`、`role`、`visible_text` 和规范 `occurred_at`。

每条记录必须匹配配置的 topic、database、table、schema fingerprint、Kafka key、CDC key 与 row-image key 字段。Insert 和 update 读取 `after`，delete 读取 `before`。带显式 `changedColumns` 的 update 仅在没有投影字段变化时跳过；缺少该提示的记录会被处理。边界或 Elasticsearch 失败会拒绝 handler，因此 Kafka 不提交该记录。

只有 `status=completed` 且 `visibility=user` 的行会保存 role 和可见文本。其他状态与 delete 写入版本化 tombstone。Document id 对 `[tenantId,userId,messageId]` 求哈希；权威 `revision` 作为 Elasticsearch external version，因此重复与旧记录是成功 no-op，且不能复活 tombstone。

配置的 index 必须已将 tenant、user、session、message、status、visibility 和 role 映射为 `keyword`，content 映射为 `text`，source_time 映射为 `date`，revision 映射为 `long`，deleted 映射为 `boolean`。插件在订阅前校验 mapping，且不会创建 index 或 mapping。

该包不提供搜索 API、index 创建、历史回填、对账或授权。调用方必须让每次搜索按已认证 tenant 与 user 过滤。权威 revision 重置时，operator 必须重建 index。

## 模型体验

该 Host-only 投影不会增加模型可见工具、prompt 或 session event。
