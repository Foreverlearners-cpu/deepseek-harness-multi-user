# 流式 chunk 保留策略

[English](stream-chunk-retention.md) | 中文

本文定义多用户部署在持久化会话上下文、实时交付状态和用户事实时如何处理模型提供方的流式 chunk。本文是设计提案，不表示该策略已经交付。[多用户架构](README.md)与[多用户数据和运行时隔离](data-and-runtime-isolation.md)定义了这里适用的所有权和授权规则。

## 决策摘要

组装完成的 assistant message 是后续模型请求使用的持久语义输入。提供方 chunk 属于传输数据：它在回复生成期间有用，但 chunk 边界和时间间隔不构成用户事实。因此，成功回复不需要无限期保留逐条、独立索引的 chunk。

首个实现保留无损的逻辑 session event 契约，并通过批量写入、无损打包和压缩降低物理成本。它不会把每个 chunk 发送到 Kafka 或 Elasticsearch。后续格式只有在 attempt 元数据、partial 恢复和实时流回放不再依赖 canonical event log 后，才可以让成功请求的原始 chunk 变成短期数据。

## 范围和术语

- **chunk** 是提供方的一条流式单元，例如文本 delta、reasoning delta、tool-call delta、usage 报告或流边界。
- **组装消息** 是提供方流结束后生成并校验的 assistant 回复，是重建模型历史时使用的版本。
- **attempt** 是一次提供方请求；包括重试在内，每次 attempt 都有自己的时间、状态、usage 和错误结果。
- **stream artifact** 是可选的原始 chunk 编码记录，用于回放或提供方级审计，不属于模型历史记录。
- **事实** 是从已完成消息及其 tool result 派生的、按用户或租户归属的 projection。未完成的前缀永远不是事实来源。

## 保留类别

保留策略按使用场景选择，而不是只按事件类型选择。每一类数据都有租户范围、所有者和明确的删除或过期规则。

| 类别 | 数据 | 存储 | 读取者 | 保留时间 |
| --- | --- | --- | --- | --- |
| 语义持久数据 | 用户消息、组装后的 assistant message、tool call/result、request header 和已提交 usage | MySQL session 领域 | resume、prompt 组装、导出、事实提取 | session 策略或 legal hold |
| Attempt 持久数据 | 提供方/模型、状态、开始/首 token/结束时间、结束原因、usage、错误和最终消息引用 | MySQL `model_attempts` | billing、指标、失败恢复、运维 | session 策略加聚合报表策略 |
| 实时流 | 合并后的 delta、当前 partial block、最后游标和重连过期时间 | Redis Stream 或有范围的 Redis key | 已连接客户端和重连处理器 | 短期可配置 TTL；可丢弃 |
| 原始流 artifact | 无损打包的 chunk、序列/时间锚点、codec 和 checksum | MySQL `stream_artifacts` 或批准的归档 | 精确回放、支持或合规审计 | 显式选择的保留期；否则短 TTL 或不保存 |

即使存在实时流或原始 artifact，语义记录仍然是权威数据。Redis 丢失、Kafka 重投、Elasticsearch 重建或 artifact 过期都不能改变模型 transcript。

## 权威数据模型

父级 session 设计拥有 canonical event 和 message 表。下面这些逻辑记录补充了将 chunk 视为进行中请求唯一记录所需的信息。

| 逻辑记录 | 必需范围和身份 | 必需内容 |
| --- | --- | --- |
| Canonical session message/event | `tenant_id`、`session_id`、单调事件身份 | 最终 user/assistant message、tool call/result、request header 和产生它的 attempt 引用；原始 chunk 不投影进模型历史 |
| `model_attempts` | 唯一 `(tenant_id, session_id, attempt_id)`，以及 `turn`、`step` 和重试编号 | 提供方和模型、状态、`started_at`、可空的 `first_token_at`、`finished_at`、结束原因、usage、有界错误详情，以及 `final_message_id` 或 `partial_snapshot` |
| `stream_artifacts` | 唯一 `(tenant_id, session_id, attempt_id)` 和 artifact 版本 | 可选压缩 payload、序列/时间范围、chunk 数、codec、checksum、创建时间和 `expires_at`；不建立逐 chunk 二级索引 |
| `user_facts` 与 evidence | 唯一的租户/用户事实身份和来源消息身份 | 规范化事实值、生命周期状态、提取器版本、置信度或 provenance，以及最终消息 evidence 引用；不能引用已删除 chunk 才能解析的证据 |

所有关系键、Redis key、Kafka record 和搜索文档都在资源身份前携带租户范围。全局唯一的 session 或 attempt id 不是授权检查。

## 生命周期操作

1. 打开提供方流之前，创建一条幂等的 `model_attempts` 记录。attempt id 是重试、完成、失败和清理的幂等键。
2. 流 worker 在内存中累积 chunk，并向客户端发送合并后的更新。第一条非空 token delta 到达时只记录一次 `first_token_at`。不要为每个 chunk 开启 MySQL 事务、发送 Kafka 消息或执行 Elasticsearch 索引操作。
3. 如果需要重连或跨进程交付，则向租户和 attempt 专属的 Redis Stream 追加有界批次，并周期性写入 partial checkpoint。checkpoint 保存已组装 block 和游标，不在每个 delta 到达时重写完整副本。
4. 成功时，在一个 MySQL 事务中提交组装后的 assistant message、usage、attempt 完成字段和 transactional outbox 条目。outbox 发布最终消息事件，触发事实提取和派生 projection。
5. 失败、取消或提供方断开时，使用错误和 usage 关闭 attempt；如果产品承诺 partial 恢复，则保存一份有界 partial snapshot。成功 attempt 可以不保存原始 artifact；中断 attempt 按配置保留恢复 artifact，直到保留期限结束。
6. Attempt 进入 terminal 状态后，过期 Redis 状态并运行租户范围的 artifact 清理。清理必须幂等，不能删除 canonical message、attempt 计量或事实 evidence。

## 基础设施职责

| 系统 | 角色 | Chunk 策略 |
| --- | --- | --- |
| MySQL | 权威关系存储和 transactional outbox | 批量写入；把连续 delta 打包成无损行或 blob；保留最终消息和 attempt 摘要；避免逐 chunk 索引 |
| Redis | 实时 fan-out、重连游标、lease 和短期 checkpoint | 使用有上限的 stream 或带 TTL 的有界 key；合并更新；重连窗口之后丢失可接受 |
| Kafka | 持久异步集成 | 发布 terminal attempt/message 和事实提取事件；使用包含租户与 session 身份的 key；不发布 token 级事件 |
| Elasticsearch | 可重建的搜索和分析 projection | 只索引最终消息、attempt 摘要和事实；不为每个提供方 chunk 建文档 |

Kafka consumer 和 Elasticsearch indexer 都是下游 projection，不能成为授权来源、prompt history 来源或 usage 计量的唯一副本。

## 效率规则

- 按时间或字节数界定持久化工作量，不按提供方 chunk 数量界定。一次 flush 写入稳定的有序前缀，并可以包含许多 delta。
- 只打包已识别的连续 run，并保存序列和时间锚点。decoder 必须重建完全相同的逻辑事件；未知 chunk 类型原样通过，不得丢数据。
- 索引集中在 `tenant_id`、`session_id`、`attempt_id` 和 terminal 时间。普通产品查询不要索引 chunk 文本、chunk 序列或每次 partial 更新。
- 不要在每个 delta 到达时重写完整 partial 回复。流期间以内存 accumulator 为准，在有界时间间隔或大小阈值执行 checkpoint。
- 客户端或 Redis consumer 落后时施加 backpressure。只有在后续 checkpoint 或最终消息可供重连读取时，才允许丢弃实时更新。
- 分别测量写操作数、压缩后字节数、binlog 量、Redis 内存、Kafka record 数和端到端首 token 延迟。保留时间和批量上限属于部署配置，不应成为隐藏常量。

## 兼容性和迁移

无损 session 契约不能静默过滤 chunk。首个存储实现中，MySQL session provider 可以使用打包行来满足该契约，并在读取时还原原始事件序列。这样可以在减少行数和 envelope 开销的同时保留 replay、source 引用、时间信息和客户端行为。

丢弃成功请求的原始 chunk 属于后续格式变更。启用前必须持久化首 token 时间、usage、terminal 状态、失败 attempt、有界 partial snapshot 和最终消息的 attempt 级 source 引用。实时 UI 恢复必须迁移到 Redis 或其他明确的 ephemeral channel，导出必须声明是否包含原始提供方回放。保留任务不能删除仍被事实或消息声明为来源的证据。

## 事实提取和隐私

事实提取在消息及其 tool result 进入 terminal 状态后执行。它使用 `(tenant_id, source_message_id, extractor_version)` 作为幂等键，因此 Kafka 重试不会产生重复事实。事实记录指向最终消息 evidence 或稳定事件范围，不能依赖 token chunk 继续存在。

原始 chunk 可能包含 reasoning 文本、tool argument、路径或其他敏感内容。多用户部署默认关闭原始 chunk telemetry 和长期 artifact。任何例外都需要明确的租户策略、目的、脱敏规则、目标、保留期和审计记录。读取实时流、artifact、消息或事实时都必须先授权，重连和后台清理同样适用。

## 待决定事项

- 每种 session 类型是承诺精确提供方回放、partial 恢复，还是只承诺最终消息恢复。
- 各部署层级的默认 Redis 重连窗口和 artifact 最大大小。
- 批准的审计 artifact 存放在 MySQL 还是独立归档，以及支持哪种 codec 和 checksum。
- reasoning 内容、tool argument、usage 和派生用户事实的保留、导出、删除和 legal hold 规则。
