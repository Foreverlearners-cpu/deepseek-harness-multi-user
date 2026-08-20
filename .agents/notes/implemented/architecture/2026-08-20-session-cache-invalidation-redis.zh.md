# Agent Note: 通过 Redis 使会话缓存失效

Status: implemented

[English](2026-08-20-session-cache-invalidation-redis.md) | 中文

## Problem

物理单租户 Host 必须在可信生产者发布不含内容的 `session.message.changed` 事件时，删除完整会话上下文 Redis 条目。`@deepseek-ai/dsh-kafka` 与 `@deepseek-ai/dsh-redis` 已负责传输和客户端生命周期。尚无包订阅已授权 topic、派生无碰撞缓存键，或以 fail-stop 提交偏移的方式删除该键。

用冒号拼接的 Redis 键会在用户或会话 id 含分隔符时发生别名碰撞。隐藏 topic、group、字节限制或部署身份的默认值，会让两个组合共享一个消费方却指向不同 broker 或载荷尺寸。若此消费方读取 MySQL 或回填 Redis，会使失效逻辑耦合源表布局，并让 Redis 看起来像权威存储。

[用户级投影提案](../../proposed/architecture/2026-08-19-user-scoped-session-change-projections.md)仍负责共享线协议事件以及后续 Elasticsearch 消费方。

## Decision

`@deepseek-ai/dsh-session-cache-invalidation-redis` 是仅限 Host 的 Cordis 函数插件。它注入 `kafka` 与 `redis`，通过 `ctx.kafka.subscribe` 订阅，用 `decodeSessionMessageChange` 解码每条记录，并经 `ctx.redis.withClient` 执行 `DEL` 删除一项完整会话上下文键。`upsert` 与 `delete` 删除同一键。键不存在视为成功。重复删除幂等。

该插件不注册 Cordis 服务。配置提供 `topic`、`groupId`、`subscriptionId`、`mode`、`maxBytes` 和 `deploymentId`，不含隐藏业务默认值。`dsh-kafka` 必须已经授权该 topic 与 group。

缓存键是规范 JSON 数组 `["dsh.session.context", deploymentId, 1, userId, sessionId]`。`dsh.session.context` 与格式版本 `1` 是固定协议常量。JSON 字符串编码避免分隔符碰撞。`sessionContextCacheKey` 是唯一受支持的构造函数，以便后续会话读取所有者复用同一键。

`dsh-kafka` 只在等待的 handler 返回后提交偏移。解码失败或 Redis 失败会抛错，因此偏移保持未提交，该订阅 fail-stop。恢复操作重新挂载插件。该插件不读取 MySQL、不回填 Redis、不写入 Elasticsearch、不跳过有害记录，也不重试。

dispose（资源释放）即此插件 fiber 拥有的 Kafka 订阅 effect：停止拉取，等待进行中的 handler 及其已准入的 `withClient` 回调结算，然后关闭订阅。

日志可包含 topic、partition、offset、成功解码后的 `eventId`，以及稳定错误类别（`SessionMessageChangeProtocolError.code` 或 `redis`）。日志省略 `userId`、`sessionId`、`messageId`、Redis 键和记录正文。

该包为选择加入。默认产品组合包不挂载它。

## Alternatives considered

**用 `:` 或 `/` 拼接键分段。** 否决，因为用户或会话 id 若含该分隔符会与另一对发生别名。

**只编码 `(userId, sessionId)`。** 否决，因为两个部署共享一个 Redis 目标时会互相删除，且后续键格式变更没有版本可隔离。

**为 `upsert` 与 `delete` 删除不同键。** 否决，因为 Redis 保存的是完整会话上下文而非单条消息。两种操作都使该条目失效。

**跳过非法记录并提交越过它。** 否决，因为静默丢失会掩盖生产者或编解码缺陷。fail-stop 让分区保持阻塞，记录仍可供重新挂载使用。

**在此消费方读取 MySQL 或回填 Redis。** 否决，因为缓存回填属于会话读取所有者，且该事件不证明授权，也不使 Redis 成为权威。

**把 topic、group、`maxBytes` 或部署身份藏在插件默认值后面。** 否决，因为这些值随部署变化，省略时必须在加载时失败。

**现在抽取共享 Kafka 消费方基类。** 否决，直到 Elasticsearch 消费方证明拥有相同的生命周期。重复的订阅与处理接线比投机基类更便宜。

**把该消费方挂进默认产品组合包。** 否决，因为 Host Kafka 与 Redis 凭据因部署而异，且首次交付保持选择加入。

## Consequences

有害记录或 Redis 中断会阻塞该分区，直到操作员重新挂载插件。这是可见且不丢数据的，但在重试与隔离有所有者之前，不足以支持无人值守生产。

后续会话读取所有者必须用同一 `deploymentId` 调用 `sessionContextCacheKey`。键格式变更会递增固定版本常量，旧键留给过期或后续事件删除。

部署仍须在外部创建 topic、在 `dsh-kafka` 上授权它，并保持一个物理隔离的 Redis 目标。`userId` 仍是部署内所有者，不是租户 scope。

## Testing

包测试驱动伪造的 `ctx.kafka` 与 `ctx.redis`：`upsert` 与 `delete` 删除同一派生键，缺键成功，重复删除幂等，解码与 Redis 失败会抛错且不提交偏移，dispose 在进行中的 `DEL` 结算后移除订阅，日志省略受保护标识符。Loader 组合通过真实包入口启动仅用于测试的 `cordis.yml`，并证明该函数插件没有 default export。
