# Agent Note: MySQL Kafka CDC projections

Status: implemented

[English](2026-08-19-mysql-kafka-cdc-projections.md) | 中文

## Problem

部署需要把近期 MySQL 行变更送入 Kafka，使相互独立的 Redis 和 Elasticsearch projection 无需同步数据库写入即可更新。历史复制和强一致性不属于当前阶段，但停机或 Kafka 确认结果不确定时不能静默推进 MySQL 重启位点。

实现必须在所有支持平台上保持 TypeScript 和 JavaScript。MySQL replication、Kafka 发布及各 projection 也具有不同的凭据、生命周期、扩缩容和故障域。

## Decision

`@deepseek-ai/dsh-cdc` 拥有一条专用 `@vlasky/zongji` replication 连接、表路由、带版本的 JSON 事件格式、按字节限制的串行发布队列和原子本地检查点。仅当检查点不存在时才从当前 binlog 尾部开始，并在 ready 前持久记录该初始尾部位点。Kafka 确认先于检查点发布，因此提供至少一次交付和稳定的重复事件 ID。

MySQL 启动时要求 row-based full image 和 full metadata，并在启动 replication 前通过 `INFORMATION_SCHEMA` 校验每个路由表、有序主键和配置字段。运行期 RowsEvent 必须保留完整字段数和 columns-present bitmap。遇到 schema 指纹变化、损坏或不可用的位点、statement-based DML、XA、不支持的压缩或 partial-JSON 事件、任何可识别的 schema-changing DDL、路由表 `TRUNCATE`、缺失路由、解码后超大事件或队列溢出时，producer 会停止而不会推进。配置的敏感字段在序列化前移除，payload 不会写入日志。启动或运行期的可恢复 MySQL 故障和可恢复 Kafka 发布故障使用延迟有上限的指数退避；运行期 MySQL 恢复会从最后一个发布安全检查点继续，而语义和配置故障仍会终止采集。

`@deepseek-ai/dsh-cdc-redis` 和 `@deepseek-ai/dsh-cdc-elasticsearch` 是同一 wire event 的独立消费方。Producer 发布可选的 `changedColumns` metadata，但不筛掉持久流中的事件。每个 projection 可配置 `watchedColumns` 跳过无关 UPDATE，INSERT 和 DELETE 始终处理；旧版 v1 消息从完整行镜像推导变化字段。两者都要求 Kafka key、事件 key 和可用行镜像中的 key 一致。Redis 原子应用数据值以及包含 topic、partition 和 offset 的持久伴随版本；Lua 操作会忽略重复或更旧的 offset，并拒绝 topic 或 partition 迁移。Elasticsearch 使用 MySQL binlog 文件数字后缀乘以 2^32 再加事件 position 得到 `external_gte` 版本。写入或删除目标文档前，它先把顺序 metadata 写入 `stateIndex`，其默认值为 `dsh-cdc-state-v1`。状态 ID 由目标 index、源 database 和 table 及主键组成，并刻意排除 Kafka consumer group；状态文档记录 event 和 source metadata，以及 Kafka topic、partition 和 offset。首次写状态发生冲突表示事件已经过期，可以确认该事件。目标写入冲突后，消费者会再次写入状态：此时冲突证明已有更高源坐标取代该事件，可以确认；若状态写入成功，则传播原始目标冲突并重试。相同版本仍可写入，因此同一事件可以在状态已推进后补写目标。每个外部 effect 都在 Kafka handler 结束前完成；不同 consumer group 使两个 projection 都能收到全部事件。

Kafka 订阅始终从已提交 offset 恢复；fallback 只用于没有 commit 的 partition，且订阅初始化会在返回句柄前完成。两个 projection 插件都会监督订阅的意外完成，关闭失败句柄，并通过指数退避重新订阅；数字重试上限耗尽后会卸载插件，避免插件看似仍然健康。修改主键值时采集会停止，因为旧 key 和新 key 记录位于分别排序的 Kafka partition；支持这种迁移需要能比较版本的 projection 状态或按表分区。

这些包保持分离，因为采集、缓存 projection 和搜索 projection 具有独立的部署权限与故障行为。现有 Kafka、Redis 和 Elasticsearch 包继续只拥有各自连接 transport。

## Alternatives considered

**MySQL 直接写 Redis 和 Elasticsearch。** 拒绝，因为任一下游故障都会把采集绑定到特定 projection，并阻止其他消费者使用持久 Kafka 流。

**一个插件包含采集和两个 projection。** 拒绝，因为消费者无法独立扩缩容、部署或失败，而且一个进程需要持有所有下游凭据。

**Transactional outbox。** 当前范围拒绝，因为不能修改应用写入且不要求强一致性。当数据库写入与事件发布必须原子化时，它仍是合适的后续选择。

**手写 replication protocol。** 拒绝，因为 `@vlasky/zongji` 是 ESM JavaScript 依赖，支持 MySQL row、metadata、GTID 和现代认证；维护同等 parser 会引入大量协议风险。

**删除使用 Kafka tombstone。** 拒绝，因为普通的版本化删除 envelope 能保留源端 metadata，并同时服务 Redis 和 Elasticsearch 消费者。Compact topic tombstone 可在后续作为显式路由策略加入。

## Verification

单元覆盖固定 JSON 校验、变化字段推导、监听字段过滤、精确 scalar 归一化、二进制和时间编码、字段排除、复合 key、route metadata 校验、持久首启位点与重试、损坏检查点拒绝、原子检查点往返、完整 row-image bitmap、statement/XA/DDL 拒绝、重试耗尽、生命周期完全停稳、Redis offset 顺序，以及 Elasticsearch 跨 Kafka partition 和 consumer group 变化的源坐标顺序与严格冲突分支。仓库中的 live smoke 会验证 MySQL 8 行事件、Kafka 发布和独立 group、使用隔离状态索引的 Redis 7 与 Elasticsearch 7 projection、binlog 轮转、producer 重启、排除值以及未监听 UPDATE。一次直接的 Elasticsearch 7.16.3 检查验证了原生 `external_gte` 对新、旧、相同版本及版本化删除后旧写入的行为；状态索引流程由单元测试覆盖，而不是由该次直接 server 测试覆盖。Binlog 保留期缺口、持续背压、schema 变更和全链路故障注入在生产保证前仍需环境门控验证。

## Consequences

Kafka 成为 fan-out 点，Redis 与 Elasticsearch 可以并发消费，MySQL 无需知道任一目的端。本地检查点、手动 Kafka commit 和 projection 侧版本使故障保持可见，并优先忽略重复，而不是静默丢失或用陈旧数据覆盖。Redis 版本 hash 会永久保留，除非协调重建显式重置顺序历史。Elasticsearch 状态文档属于正确性 metadata，必须在业务 ILM 或 rollover 之外永久保留。稳定且不滚动的 `stateIndex` 必须不同于每个 route index，部署还必须避免它与目标 alias 或 backing index 重叠。执行 `RESET MASTER`、切换主库或任何 binlog 序号回退时，必须启用全新状态索引并同时清空或重建目标 index；只更换状态索引会让现有目标文档保留不兼容的 external version。ZongJi 只会在 packet 解析和行解码后报告 RowsEvent 大小，因此 `maxBinlogEventBytes` 可以拒绝队列接纳和发布，但不能限制 parser 内存峰值。

该设计不提供 exactly-once effect、跨表事务原子性、历史数据、HA fencing、自动 schema migration、定时对账，或在 binlog 保留期清除保存位点后的自动恢复。这些情况需要显式重建或后续同步机制。
