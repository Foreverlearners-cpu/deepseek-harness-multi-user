# Agent Note: 用户级会话变更投影

Status: proposed

[English](2026-08-19-user-scoped-session-change-projections.md) | 中文

## Problem

一个拥有多个私有用户的单租户服务器部署，需要让会话缓存失效并建立消息搜索投影，同时不能让 Redis 和 Elasticsearch 消费方依赖 MySQL 表名或某一种变更捕获机制。仅限 Host 的 Kafka、Redis 与 Elasticsearch 包提供了有界的客户端生命周期，但尚无包负责一项可由两个消费方共同验证的会话领域线协议事件。

原始行变更记录会暴露两个消费方都不需要的存储字段，把表布局变成它们的协议，还可能把消息正文或受保护列复制进 Kafka。携带内容的搜索事件可以省去源读取，却会让 Kafka 成为另一个保留内容的存储。在 Redis 和 Elasticsearch 包中重复实现解析器，会使验证和版本处理发生偏差。

首次交付不包含 MySQL 到 Kafka 的生产者。测试发布固定事件，后续 outbox 或 binlog 生产者可以采用同一协议，而无需修改任一消费方。

## Proposal

新增 `@deepseek-ai/dsh-session-message-change-protocol`，这是位于 `packages/session/session-message-change-protocol` 的纯线协议库。它负责一项严格、不含内容的 `session.message.changed` 事件、二进制编码与解码，以及确定性的 Kafka 分区键。它不注册 Cordis 服务，也不执行 I/O。

后续两个单一职责消费方使用该协议：

- `@deepseek-ai/dsh-session-cache-invalidation-redis` 通过 `ctx.kafka` 订阅，派生一项部署／用户／会话缓存键，并通过 `ctx.redis` 删除它。`upsert` 与 `delete` 都会使完整上下文缓存失效。缓存回填仍由会话读取所有者负责。
- `@deepseek-ai/dsh-session-search-projection-elasticsearch` 通过独立消费组订阅，经 `ctx.sessionQuery` 读取已标识的完整消息，并通过 `ctx.elasticsearch` 建立索引。删除操作写入带版本的墓碑，而不是丢弃顺序证据。

该协议只适用于一个部署组合、Kafka topic、Redis 目标和 Elasticsearch 写入目标属于一个租户或另一个物理隔离管理域的场景。`userId` 标识该部署内私有会话的所有者。共享的多租户传输或数据目标仍须遵循更广泛的[多用户控制面与数据面](2026-08-18-multi-user-control-and-data-planes.md)和[租户级 Elasticsearch](2026-08-18-tenant-scoped-elasticsearch-search-projections.md)提案，携带显式 `tenantId` scope。本说明不取代任一提案。

## Wire event

Kafka value 是严格的 UTF-8 JSON，只包含以下字段：

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

`operation` 为 `upsert` 或 `delete`。`sourceSeq` 是权威完整消息事实在会话内的非负序号。`occurredAt` 是用于诊断的规范 UTC 时间，绝不代替顺序。生产者为一项源变更创建一个不透明 `eventId`，并在该变更的每次重试中复用它。

编解码器拒绝 null value、非法 UTF-8、非对象 JSON、缺少或额外字段、不支持的版本或事件类型、空 id、未知操作、不安全序号，以及不规范的 UTC 时间戳。编码和解码采用一项由调用方提供的完整载荷字节限制，不含隐藏默认值。失败使用稳定类别，绝不引用载荷或受保护标识符。

Kafka key 是 `(userId, sessionId)` 的无歧义编码。在 topic 分区稳定时，它维持会话内顺序；它不授权该事件。

## Delivery and projection semantics

逻辑 topic 是 `dsh.session.message-changes`。部署配置提供实际 topic 和两个允许的 group；参考 group 名称为 `dsh-session-context-cache` 与 `dsh-session-message-search`。`dsh-kafka` 禁用自动创建，因此 topic 在应用外部配置。

Kafka 采用至少一次交付。传输层只在等待的消费方 handler 成功后提交 offset。Redis 删除天然幂等。Elasticsearch 把 `sourceSeq + 1` 写为外部版本，将相等或更低版本冲突视为成功的无操作，并保留删除墓碑，直到旧 upsert 不可能使已删文档复活。

首批消费方采用 fail-stop：格式错误的记录以及 Redis、源查询或 Elasticsearch 失败会拒绝 handler、保留未提交 offset，并停止该订阅。恢复操作重新挂载插件并重新交付记录。重试 topic、死信队列、自动跳过有害记录、投影重建和消费方健康管理属于独立工作。

dispose 会停止拉取，并等待已接纳 handler 以及借用的 Redis 或 Elasticsearch callback 结算后再关闭订阅。日志可以关联有界传输位置和 `eventId`；它们省略 `userId`、`sessionId`、`messageId`、缓存键、查询正文、文档正文和消息内容。

## Data ownership and security

MySQL 和持久会话日志保持权威。Redis 可丢弃、可重建。Elasticsearch 最终一致且可重建。Kafka 只携带标识、操作、序号和时间；它不携带提示词、消息正文、推理、失败的部分输出、Redis 键、Elasticsearch 索引名、凭据或授权断言。

事件的 `userId` 由可信 Host 生产者从权威会话所有权复制而来。产品请求中的该字段不能作为访问证明。Redis 键派生和 Elasticsearch 文档构造只在经过验证的事件所属物理单租户部署 scope 内使用。后续搜索 API 必须在 Elasticsearch 执行查询前加入已认证用户谓词。

## Package boundaries

协议包负责事件类型、尚未由 `dsh-session` 或 `dsh-llm` 负责的品牌类型、安全编码与解码、完整载荷字节限制输入，以及 Kafka key 派生。它不负责 topic 管理、生产者、消费方、重试循环、缓存键命名空间、索引映射、查询或重建。

Redis 与 Elasticsearch 包保持分离，使其依赖、失败策略、生命周期、测试和后续部署节奏不会耦合。只有两个具体实现证明存在相同且由它们共同拥有的行为后，才提取共享消费方机制；本提案不增加推测性的基类。

## Alternatives considered

**向每个消费方发送原始 binlog 或表变更信封。** 否决，因为它暴露存储布局、扩大 Kafka 载荷，并迫使每个消费方重复字段过滤与表解释。后续生产者可以读取 binlog，但会在发布前把已接受的完整消息变更转换为本领域事件。

**在 Kafka 中携带完整消息内容。** 否决，因为 Redis 不需要内容，Elasticsearch 可以读取权威的已标识事件，而保留的 Kafka 载荷会形成另一个受保护内容存储，并带来独立的访问与保留义务。

**让每个消费方定义自己的事件解析器。** 否决，因为字段严格性、版本支持、字节限制、身份品牌类型、时间戳规则和分区键是一项由两个消费方共享的线协议义务。

**使用一个可配置投影消费方处理 Redis 和 Elasticsearch。** 否决，因为缓存失效与搜索索引具有不同的数据依赖、幂等机制、失败行为和生命周期演化。

**因为会话 id 不透明而不携带所有者 scope。** 否决，因为不可猜测性不是授权，用户私有的会话缓存和文档需要单租户部署内的显式所有者。

**在首个事件中包含 `tenantId`。** 延后而非否决。已接受的部署具有一个物理隔离租户和多个私有用户。共享的多租户 topic 或目标必须采用更广泛多用户提案负责的显式租户约定，而不能静默扩大本事件。

## Acceptance criteria

- 协议包可以往返处理 `upsert` 和 `delete` 事件，并为相同用户／会话对确定性地派生相同 key。
- 边界测试拒绝非法字节、JSON value、字段集、版本、事件类型、id、操作、源序号、时间戳，以及精确或超限字节限制用例，且错误不暴露受保护值。
- 包导出使用现有 `SessionId` 和 `MessageId` 品牌类型，并为每个剩余的不透明跨边界 id 建立品牌类型。
- 包文档说明模型 token 和 KV Cache 均无直接影响、单租户部署前提，以及不存在生产者或消费方行为。
- 后续 Redis 测试证明精确的用户／会话失效、重复安全、失败 handler 不提交，以及完全停稳的 dispose。
- 后续 Elasticsearch 测试证明权威源读取、用户／消息身份匹配、只索引完整消息、源序号排序、墓碑、失败 handler 不提交，以及后续搜索消费方在查询前进行用户过滤。
- 测试专用 Loader 组合通过真实包入口发布固定事件；测试生产者永远不进入出厂组合包，投影消费方在其验收路径通过前保持可选。

## Risks

- 部署可能在共享多租户 topic 或目标上复用这项用户级事件。组合文档和测试必须拒绝该拓扑，而不能把 `userId` 当作租户 scope。
- 后续生产者可能为重新交付生成新的 `eventId`。Redis 仍然安全，Elasticsearch 排序也仍依赖 `sourceSeq`，但诊断和后续任何持久去重都会碎片化。
- 错误或非单调的 `sourceSeq` 可能让陈旧搜索状态获胜。MySQL 持久化所有者必须保留会话事件序号，而不能从墙上时间推导顺序。
- Fail-stop 消费会阻塞分区，直到重新挂载或由操作员修复。该行为可见且无损，但在重试、隔离和健康状态拥有明确所有者前，不足以支持无人值守生产运行。
- 不含内容的事件使 Elasticsearch 索引依赖权威源可用性。它避免 Kafka 保留内容，但可能增加源读取和投影延迟。
