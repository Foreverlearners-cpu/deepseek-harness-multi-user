# Session 变更投影

[English](session-change-projections.md) | 中文

本参考定义在物理单租户部署中用于使会话缓存失效并驱动消息搜索投影的用户级 Kafka 事件。[用户级投影 Agent Note](../../.agents/notes/proposed/architecture/2026-08-19-user-scoped-session-change-projections.md)负责其理由和替代方案。更广泛的[数据与运行时隔离](data-and-runtime-isolation.md)规则继续治理共享多租户部署。

## Deployment precondition

一个组合、Kafka topic、Redis 目标和 Elasticsearch 写入目标服务于一个租户或另一个物理隔离管理域。多个私有用户可以共享该部署，`userId` 标识其中的会话所有者。共享多租户 topic、Redis 目标或 Elasticsearch 索引必须改为携带显式租户 scope，不能原样使用本事件。

基础设施客户端保持仅限 Host。产品请求、模型控制代码、Typert、API Proxy、容器和 microVM 都不能获得 Kafka、Redis、Elasticsearch 或其凭据。

## Event flow

```text
fixed test producer; later an accepted durable change producer
  -> Kafka session message change topic
     -> session cache invalidation Consumer -> Redis DEL
     -> session search projection Consumer -> session query -> Elasticsearch
```

首个协议包不选择 outbox 或 binlog 捕获，也不注册生产者。后续生产者把一项已提交的完整消息变更转换为本事件，并在发布结果不确定时复用相同 `eventId`。

## Kafka contract

逻辑 topic 名称为 `dsh.session.message-changes`。部署配置提供实际 topic，并在 `dsh-kafka` 中授权。topic 在应用外部配置。参考消费方 group 是 `dsh-session-context-cache` 和 `dsh-session-message-search`，因此 Redis 与 Elasticsearch 可以彼此独立地观察每一项事件。

Kafka value 是严格的 UTF-8 JSON，只包含以下字段：

| 字段 | 约定 |
|---|---|
| `schemaVersion` | 必须为 `1` |
| `eventId` | 非空白不透明身份，在发布重试间保持稳定 |
| `eventType` | 必须为 `session.message.changed` |
| `userId` | 部署内的非空白权威私有会话所有者 |
| `sessionId` | 既有非空白品牌会话身份 |
| `messageId` | 既有非空白品牌不可变消息身份 |
| `operation` | `upsert` 或 `delete` |
| `sourceSeq` | 从 `0` 到 `Number.MAX_SAFE_INTEGER - 1` 的整数，在会话内单调递增 |
| `occurredAt` | 用于诊断的规范 `YYYY-MM-DDTHH:mm:ss.sssZ` UTC 时间戳 |

value 不包含消息文本、推理、失败的部分输出、缓存键、索引名、凭据或授权断言。调用方需要向编解码器提供显式完整载荷字节限制。Kafka key 是 `(userId, sessionId)` 的确定性无歧义编码。

非法 UTF-8、非法或非对象 JSON、意外字段集、未知版本或事件类型、空身份、未知操作、不安全序号、非法 UTC 时间戳、null value 和超限载荷都会失败，且诊断不包含受保护值。

## Redis invalidation

`upsert` 与 `delete` 都会移除完整会话上下文缓存项。键命名空间包含已配置部署身份、固定键格式版本，以及经过编码的 `userId` 与 `sessionId` 段。键不存在也算成功，重复删除具有幂等性。`@deepseek-ai/dsh-session-cache-invalidation-redis` 是选择加入的消费方。

失效消费方不读取 MySQL，也不回填 Redis。活跃会话继续使用其拥有的进程内状态。会话读取所有者在冷缓存未命中时读取完整权威会话并重新填充 Redis。本事件不会使 Redis 成为权威，也不能证明授权。

## Elasticsearch projection

对于 `upsert`，投影消费方通过 `ctx.sessionQuery` 读取 `(sessionId, sourceSeq)` 处的事件，验证权威用户和消息身份，只提取完整用户或 assistant 可见文本，并写入一篇消息文档。文档存储用户、会话、消息、角色、可见内容、源时间、源序号和删除状态。

对于 `delete`，消费方写入一项更高版本的墓碑，其中包含身份、序号和 `deleted: true`。搜索排除墓碑。后续搜索 API 在 Elasticsearch 执行前提供已认证 `userId` 谓词；禁止查询后过滤。

Elasticsearch 保持可从 MySQL 和会话日志重建。索引创建、别名、映射、代际重建、墓碑清理、搜索 API 和结果展示均由线协议包以外的所有者负责。

## Delivery, failure, and lifecycle

交付采用至少一次。`dsh-kafka` 按顺序处理一个订阅，并只在等待的 handler 成功后提交。Redis 删除容忍重复。Elasticsearch 把 `sourceSeq + 1` 写为外部版本，并将相等或更低版本冲突视为成功的无操作。

首批消费方采用 fail-stop。非法事件和依赖失败会拒绝 handler、保留未提交 offset，并停止该订阅。恢复操作重新挂载插件。重试 topic、死信队列、自动跳过有害记录、健康管理和无人值守恢复均延后。

dispose 会停止拉取，并等待活跃 handler 和借用的依赖 callback 结算后再关闭订阅。日志省略所有者 id、资源 id、缓存键、查询正文、文档和消息内容。

## First delivery scope

首个包是 `@deepseek-ai/dsh-session-message-change-protocol`，它是一项纯库，负责事件类型、严格编码与解码、既有会话或消息包未负责的品牌类型、字节限制执行，以及 Kafka key 派生。它不创建 Cordis 服务，也不执行 I/O。

Redis 消费方是选择加入的 Host 插件 `@deepseek-ai/dsh-session-cache-invalidation-redis`。Elasticsearch 消费方、它们的测试生产者、缓存 read-through 行为、生产者捕获、搜索 API、重试、死信处理、投影重建和默认组合包装配需要单独进行包评审。
