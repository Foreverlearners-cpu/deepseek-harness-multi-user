# Agent Note: Elasticsearch 会话消息搜索投影消费方

Status: implemented

[English](2026-08-20-session-search-projection-elasticsearch.md) | 中文

## Problem

不含内容的 `session.message.changed` 事件只告诉搜索投影哪条完整消息发生了变更，并不携带正文。Host 消费方必须把该信号变成一篇 Elasticsearch 文档，既不能把 Kafka 当作内容存储，也不能耦合 MySQL 表名，更不能让更旧的 upsert 复活已删除消息。

`ctx.sessionQuery.readEvent` 返回会话日志窗口。它不标识私有会话所有者，也不是在 `(sessionId, sourceSeq)` 处的完整消息查找。尚不存在 MySQL 完整消息查询服务。若把映射变更、搜索、重建或 Redis 失效放进同一个插件，会把无关的失败策略与生命周期耦合在一起。

## Decision

`@deepseek-ai/dsh-session-search-projection-elasticsearch` 是仅限 Host 的 Cordis 函数插件。它注入 `kafka`、`elasticsearch` 和 `sessionCompleteMessageQuery`，并且不出现在随产品交付的 bundle 中。

源约定只有一个方法 `read(sessionId, sourceSeq)`，返回完整的 user 或 assistant 可见文本，以及所有者、消息 id、角色和源时间。测试把该方法作为 double 提供。后续 MySQL 插件是生产提供方。消费方不解析 binlog 行，也不把 Kafka 载荷复制进文档内容。

`upsert` 校验源 `userId` 与 `messageId` 与已解码事件一致，然后索引一篇存活文档。`delete` 写入更高版本的墓碑，保留身份、序号和 `deleted: true`，并且不查询源。文档 `_id` 是 `JSON.stringify([userId, messageId])` 的小写十六进制 SHA-256。Elasticsearch 外部版本为 `sourceSeq + 1`；相等或更低的版本冲突视为成功的无操作。

启动时比较每个必需映射字段的 `type`，从不创建或更新索引。Kafka handler 的成功是唯一的 offset 提交信号；解码、身份、源和 Elasticsearch 失败都会 fail-stop。dispose（资源释放）停止拉取，等待活跃 handler 与写入，然后关闭订阅。日志省略所有者 id、资源 id、查询正文、文档和消息内容。

共享事件与 Redis 消费方仍由[用户级投影提案](../../proposed/architecture/2026-08-19-user-scoped-session-change-projections.md)负责。本说明不增加 `tenantId`，也不提供搜索 API。

## Testing

包测试覆盖 upsert 索引、delete 墓碑、旧版本无操作、重复成功、解码／查询／Elasticsearch 不提交、映射拒绝、静止 dispose，以及通过真实插件入口、用 Loader 拉 `cordis.yml` 发布固定事件的组合。它们 mock Kafka、Elasticsearch 和源读取；不声称存在实时集群。

## Alternatives considered

**把 `ctx.sessionQuery.readEvent` 当作源。** 否决，因为该 API 返回没有权威 `userId` 的日志窗口，也不是按会话序号读取完整消息。

**在 Kafka 事件上携带消息正文。** 已在父提案中否决：Redis 不需要内容，保留载荷会再产生一个受保护内容存储。

**用 Elasticsearch `delete` 代替带版本墓碑。** 否决，因为删除文档会丢掉序号证据，并让迟到的更低版本 upsert 重建它。

**在启动时创建或更新映射。** 否决，因为消费方不得变更生产索引映射；由运维提供映射，不匹配则激活失败。

**与 Redis 失效共用一个投影插件。** 已在父提案中否决：缓存删除与搜索索引的依赖、幂等性和生命周期不同。

**在版本冲突时跳过 offset 提交以便 Kafka 重试。** 否决，因为相等或更低的冲突已表示索引持有更新或同等状态；重试会让分区 livelock。

## Consequences

搜索文档可按 `sourceSeq` 重建和排序，且 Kafka 不保留消息文本。生产挂载仍需要 MySQL `sessionCompleteMessageQuery` 提供方、已配置的索引，以及显式组合行。Fail-stop 消费无损且可见，会阻塞分区直到重新挂载。墓碑会累积，直到后续清理作业出现。后续搜索 API 必须在 Elasticsearch 执行前注入已认证用户谓词。
