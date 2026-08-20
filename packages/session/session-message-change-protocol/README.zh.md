# @deepseek-ai/dsh-session-message-change-protocol

[English](README.md) | 中文

一项由会话缓存失效与消息搜索投影消费方共享的严格、不含内容 Kafka 线协议。此包是一项纯库：它不注册 Cordis 服务、不打开传输，也不执行 I/O。[多用户参考](../../../docs/multi-user/session-change-projections.md)定义交付流程；[Agent Note](../../../.agents/notes/proposed/architecture/2026-08-19-user-scoped-session-change-projections.md)负责其理由和替代方案。

## Event

版本 1 只携带：

```json
{
  "schemaVersion": 1,
  "eventId": "evt-9001",
  "eventType": "session.message.changed",
  "userId": "user-8",
  "sessionId": "session-100",
  "messageId": "message-12",
  "operation": "upsert",
  "sourceSeq": 12,
  "occurredAt": "2026-08-19T13:49:00.000Z"
}
```

`operation` 是 `upsert` 或 `delete`。`sourceSeq` 是一项不大于 `SESSION_MESSAGE_CHANGE_MAX_SOURCE_SEQ` 的非负会话内序号，为正数 Elasticsearch 外部版本保留一次精确递增。`occurredAt` 是规范 UTC 诊断时间，绝不决定顺序。

事件不携带消息文本、推理、失败的部分输出、缓存键、索引名、凭据或授权断言。`userId` 是物理单租户部署内由可信 Host 生产者复制的权威所有权；它不是调用方提供的授权。

## API

- `encodeSessionMessageChange(event, { maxBytes })` 发出规范字段顺序的 UTF-8 JSON，并拒绝非法限制或超限完整载荷。
- `decodeSessionMessageChange(value, { maxBytes })` 执行严格 UTF-8、JSON、精确字段、discriminant、身份、序号、时间戳和完整载荷验证。
- `sessionMessageChangeKafkaKey(userId, sessionId)` 编码一项无歧义 JSON tuple，使相同用户／会话对选择相同 Kafka key。
- `SessionMessageChangeEventId()` 和 `SessionMessageChangeUserId()` 为生产者已验证的不透明 id 建立品牌类型。既有 `SessionId` 与 `MessageId` 品牌仍分别由 `dsh-session` 和 `dsh-llm` 负责。
- `SessionMessageChangeProtocolError.code` 为 `invalid-limit`、`payload-too-large`、`invalid-utf8`、`invalid-json` 或 `invalid-event`。错误消息绝不包含载荷或受保护 id。

调用方必须提供 `maxBytes`；协议没有部署尺寸默认值。Kafka topic、消费方 group、生产者重试、offset 提交、缓存键、索引映射、源读取和投影重试由后续消费方或部署配置负责。

## Deployment scope

事件只在一个组合、topic、Redis 目标和 Elasticsearch 写入目标服务于一个租户或另一个物理隔离管理域时有效。共享多租户基础设施需要显式租户级协议；`userId` 不能替代 `tenantId`。

## Model Experience

无，因为这项纯 Host 线协议库不注册提示词、工具、消息、会话事件或模型可见服务。

#### KV Cache effect

无；Kafka 记录的编码与解码独立于模型请求。

## Known Limitations and Deferred Work

- **没有生产者或消费方**——固定测试生产者以及后续 outbox 或 binlog 发布者仍在此包以外，Redis 和 Elasticsearch 消费方也是如此。
- **仅版本 1**——未知版本显式失败；预发布包不提供兼容别名或迁移。
- **单租户传输前提**——没有后续显式租户 scope 时，该事件不能安全跨越共享多租户 topic、缓存或索引。
- **调用方负责字节限制**——每个调用方必须一致地配置并传入完整载荷限制。
