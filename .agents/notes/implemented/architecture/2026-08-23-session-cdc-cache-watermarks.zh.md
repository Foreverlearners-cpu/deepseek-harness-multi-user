# Agent Note: Session CDC cache watermark

Status: implemented

[English](2026-08-23-session-cdc-cache-watermarks.md) | 中文

## Problem

当较旧 read 可能更晚完成并重新填充陈旧数据时，仅在 CDC notification 后删除 session cache 并不足够。Kafka offset 无法跨 partition 或重建 topic 对领域数据进行 version control，共享 cache 也必须在多个组织使用同一 Redis deployment 前隔离 tenant。

## Decision

`@deepseek-ai/dsh-session-cache-invalidation-redis` 通过 `dsh-kafka-events` 消费严格 `CdcEvent` 记录。它只接受一个准确的 topic、database、table、schema fingerprint、compound Kafka key 和固定 session message row schema。insert 和 delete 会失效缓存。update 只有在显式 changed-column list 与固定 cached-content column 无交集时才跳过。

每个 tenant/user/session 都有一个 cache key 和独立 revision watermark key。一个 Redis Lua operation 比较规范十进制 revision，只推进更新的 watermark 并删除 cache。实时 CDC handler 与导出的、不依赖 metadata 的 `applySessionContextCacheSnapshot()` 修复 API 共享该 operation。cache population 使用导出的 Lua-backed `refillSessionContextCache()` helper，只在权威 revision 不低于 watermark 时写入。失效与 refill 彼此保持原子性。

插件监督其所属 Kafka subscription。非预期 failure 会记录不含 broker cause 的固定诊断并卸载插件，避免 invalidator 仍显示已加载却不再工作。

## Alternatives considered

**把 Kafka partition offset 用作 revision。** offset 是限定在 topic partition 内的 transport position，在 repartition 或 replay 时会变化；它不能排序权威 session state。

**删除时不保留 watermark。** 这种方案留下竞态：较旧 database read 会在删除后写入陈旧 cache content。

**使用 CDC row content 更新 Redis。** cache assembly 属于 session read owner，并且可能需要多行数据；失效机制保留了该所有权。

## Consequences

重复和乱序 CDC record 及 reconciliation snapshot 根据权威 revision 保持幂等，tenant 不会共享 cache key，旧 refill attempt 无法覆盖当前 cache state。消费方必须使用导出的 refill helper，reconciler 必须使用 snapshot API，revision 必须是规范正十进制整数，任何 row 或 schema change 都需要协调配置和代码变更。subscription 停止时会卸载 invalidator，而不是静默留下陈旧 cache。
