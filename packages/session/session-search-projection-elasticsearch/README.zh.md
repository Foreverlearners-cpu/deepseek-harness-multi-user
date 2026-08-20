# @deepseek-ai/dsh-session-search-projection-elasticsearch

[English](README.md) | 中文

仅限 Host 的 Cordis 函数插件，从不含内容的 `session.message.changed` Kafka 事件把完整会话消息投影到 Elasticsearch。它通过独立消费组订阅，从一项必需的源服务读取已标识的完整消息，并为每条事件写入一篇带外部版本的文档。[会话变更投影参考](../../../docs/multi-user/session-change-projections.md)定义共享交付流程；[消费方 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-20-session-search-projection-elasticsearch.md)负责理由。

此包为 opt-in，不属于随产品交付的 bundle。

## 配置

每个字段都是必需的。插件不提供部署尺寸默认值。

| 字段 | 含义 |
|---|---|
| `topic` | 已在 `ctx.kafka` 上授权的 Kafka topic |
| `groupId` | 已在 `ctx.kafka` 上授权的独立消费组；参考名称为 `dsh-session-message-search` |
| `maxBytes` | 传给 `decodeSessionMessageChange` 的完整 Kafka value 字节上限 |
| `index` | 已存在且映射符合预期的 Elasticsearch 索引 |
| `mode` | Kafka 起始模式：`committed`、`earliest` 或 `latest` |

```yaml
- name: '@deepseek-ai/dsh-session-search-projection-elasticsearch'
  config:
    topic: dsh.session.message-changes
    groupId: dsh-session-message-search
    maxBytes: 4096
    index: dsh-session-messages
    mode: committed
```

## 注入的服务

插件注入 `kafka`、`elasticsearch` 和 `sessionCompleteMessageQuery`。`ctx.sessionQuery` 不是该源：它读取会话日志窗口，并不在 `(sessionId, sourceSeq)` 返回带所有者身份的权威完整消息。

`sessionCompleteMessageQuery.read(sessionId, sourceSeq)` 必须返回一条完整的 user 或 assistant 消息：

- `userId` — 权威私有会话所有者
- `messageId` — 不可变消息身份
- `role` — `user` 或 `assistant`
- `visibleText` — 仅完整可见文本；不含推理或失败的部分输出
- `occurredAt` — 存入文档的规范 UTC 源时间

后续 MySQL 所有者提供该服务。测试提供带该方法的窄 double。插件不伪造 CDC。

## 投影

启动时读取索引映射，并比较每个必需字段的 `type`。允许额外字段。索引缺失、字段缺失或类型不匹配会使插件激活失败。插件从不创建索引，也不更新映射。

Kafka handler 用 `decodeSessionMessageChange` 解码 value。非法 UTF-8、JSON、字段或载荷大小会拒绝 handler。

对于 `upsert`，handler 读取完整消息，要求 `userId` 与 `messageId` 与事件一致，并索引一篇存活文档。对于 `delete`，它不查询源；它索引一篇墓碑，保留身份、`source_seq`、来自 `occurredAt` 的 `source_time`，以及 `deleted: true`。

文档 `_id` 是 `JSON.stringify([userId, messageId])` 的小写十六进制 SHA-256，因此 id 保持稳定且无分隔符碰撞。Elasticsearch `version` 为 `sourceSeq + 1`，`version_type` 为 `'external'`。相等或更低的版本冲突视为成功的无操作。因此重复事件是安全的。

| 字段 | Upsert | 墓碑 |
|---|---|---|
| `user` | 已校验的所有者 | 事件所有者 |
| `session` | 事件会话 | 事件会话 |
| `message` | 已校验的消息 | 事件消息 |
| `role` | `user` 或 `assistant` | 省略 |
| `content` | 完整可见文本 | 省略 |
| `source_time` | 源 `occurredAt` | 事件 `occurredAt` |
| `source_seq` | 事件 `sourceSeq` | 事件 `sourceSeq` |
| `deleted` | `false` | `true` |

必需映射类型：`user`、`session`、`message` 和 `role` 为 `keyword`；`content` 为 `text`；`source_time` 为 `date`；`source_seq` 为 `long`；`deleted` 为 `boolean`。

`dsh-kafka` 只在此 handler 成功后提交记录 offset。解码、身份、源查询和 Elasticsearch 失败会拒绝 handler、保留未提交 offset，并使该订阅 fail-stop。没有重试 topic、死信队列或自动跳过有害记录。

dispose（资源释放）会停止拉取，等待活跃 handler 及其 Elasticsearch 写入，然后关闭订阅。日志可以包含 `eventId`、Kafka 分区、offset 和稳定失败代码。日志省略 `userId`、`sessionId`、`messageId`、查询正文、文档和消息内容。

该事件只对一个物理单租户部署有效。后续搜索 API 必须在 Elasticsearch 执行前加入已认证 `userId` 谓词；此包不搜索。

## 模型体验

无，因为这项仅限 Host 的搜索投影消费方不注册提示词、工具、消息、会话事件或模型可见服务。

#### KV Cache 影响

无；Kafka 消费与 Elasticsearch 写入独立于模型请求。

## 已知限制与暂缓事项

- **没有搜索 API** — 只做索引；调用方不能通过此插件查询文档。
- **没有索引管理** — 由运维提供索引和映射；插件从不创建、设置别名或修改它们。
- **没有重建或墓碑清理** — Elasticsearch 仍可从 MySQL 和会话日志重建，但此包不运行那些作业。
- **Fail-stop 消费** — 有害记录会阻塞分区，直到插件重新挂载；重试和死信处理不在范围内。
- **必需的源服务** — 生产环境的 MySQL 完整消息查找是 `sessionCompleteMessageQuery` 的后续提供方。
- **Opt-in 组合** — 在部署显式挂载之前，插件不出现在随产品交付的 bundle 中。
