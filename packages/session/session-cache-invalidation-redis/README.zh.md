# @deepseek-ai/dsh-session-cache-invalidation-redis

[English](README.md) | 中文

仅限 Host 的 Kafka 消费方：对每条通过校验的 `session.message.changed` 事件删除一项完整会话上下文 Redis 键。它注入 `ctx.kafka` 与 `ctx.redis`，用 [`@deepseek-ai/dsh-session-message-change-protocol`](../session-message-change-protocol/README.md) 解码记录，并且只执行 `DEL`。[多用户参考](../../../docs/multi-user/session-change-projections.md)定义交付流程；[Agent Note](../../../.agents/notes/implemented/architecture/2026-08-20-session-cache-invalidation-redis.md)负责其理由和替代方案。

该插件是 Cordis 函数插件（`name` / `inject` / `Config` / `apply`），没有 default export，也不注册 Cordis 服务。它为选择加入，不属于任何默认产品组合包。

## Configuration

每个字段都是必填。插件不提供隐藏的 topic、group、字节限制或部署身份默认值。

| 字段 | 行为 |
|---|---|
| `topic` | 非空 topic，且已在 `dsh-kafka` 上授权 |
| `groupId` | 非空消费组，且已在 `dsh-kafka` 上授权 |
| `subscriptionId` | 非空订阅身份，在该 Kafka 服务内唯一 |
| `mode` | `committed`、`earliest` 或 `latest` |
| `maxBytes` | 传给 `decodeSessionMessageChange` 的正数完整载荷字节限制 |
| `deploymentId` | 嵌入每项缓存键的非空部署身份 |

`dsh-kafka` 必须在其允许列表中列入同一 topic 与 group。topic 在应用外创建。

## Cache key

`sessionContextCacheKey({ deploymentId, userId, sessionId })` 返回规范 UTF-8 JSON 数组 `["dsh.session.context", deploymentId, 1, userId, sessionId]`。kind 字符串与格式版本 `1` 固定。JSON 字符串编码使 `userId` 与 `sessionId` 在含有拼接会碰撞的标点时仍无歧义。

`upsert` 与 `delete` 都删除这一键。键不存在视为成功。重复删除幂等。

## Delivery, failure, and disposal

`dsh-kafka` 按顺序交付记录，并只在等待的 handler 返回后提交偏移。handler 解码 value，然后在 `ctx.redis.withClient` 内执行 `DEL`。解码失败或 Redis 失败会抛错，因此偏移保持未提交，该订阅 fail-stop。恢复操作重新挂载插件。

dispose（资源释放）该插件会停止拉取，等待进行中的 handler 及其已准入的 Redis 回调，然后关闭订阅。

日志可包含 topic、partition、offset、成功解码后的 `eventId`，以及错误类别 `invalid-limit`、`payload-too-large`、`invalid-utf8`、`invalid-json`、`invalid-event` 或 `redis`。日志省略 `userId`、`sessionId`、`messageId`、Redis 键和记录正文。

该消费方不读取 MySQL、不回填 Redis、不写入 Elasticsearch，也不授权该事件。冷缓存未命中由会话读取所有者处理。

## Deployment scope

该消费方只在一个组合、topic 和 Redis 目标服务于一个租户或另一个物理隔离管理域时有效。共享多租户基础设施需要显式租户级协议；`userId` 不能替代 `tenantId`。

## Model Experience

无，因为这项仅限 Host 的失效消费方不注册提示词、工具、消息、会话事件或模型可见服务。

#### KV Cache effect

无；消费 Kafka 与删除 Redis 键独立于模型请求。

## Known Limitations and Deferred Work

- **仅 fail-stop** — 非法记录与 Redis 失败会阻塞分区直到重新挂载；重试 topic、死信队列和健康管理仍在此包以外。
- **只删除** — 插件从不写入或回填 Redis；会话读取所有者负责填充缓存。
- **单租户键命名空间** — 键嵌入部署身份与用户身份，不含 `tenantId`。
- **选择加入组合** — 默认产品组合包不挂载此插件。
