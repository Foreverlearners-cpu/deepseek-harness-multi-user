# Agent Note: 权威会话投影校准重建

Status: implemented

[English](2026-08-23-session-projection-reconciliation.md) | 中文

## Problem

适配器缺陷、运维误操作或索引替换可能使 Kafka 与 CDC 投影不完整或不一致。传输历史不一定可重放，而且历史重放不能证明当前权威状态。若应用直接分别重建 Redis 或 Elasticsearch，就会重复实现分页、取消、失败和恢复语义。

## Decision

`@deepseek-ai/dsh-session-projection-reconciler` 从应用注入的分页 source 向一个或多个命名 sink 运行单个运维触发任务。它不消费 Kafka，也不提供 MySQL source provider。应用继续负责授权、权威快照一致性和 source 存储。

每个任务显式指定有界页大小、可选 tenant、起始 cursor、取消 signal 和 `sequential` sink 策略。页面与记录保持 source 顺序。每条记录按注册顺序写入各 sink；source 或 sink 失败时服务立即停止。

页起点 cursor 是恢复点。只有整页在全部 sink 中成功后才推进。失败或取消返回当前页起点、完成计数和失败 sink 名称，不包含记录内容或适配器异常详情。因此 sink 适配器必须按记录标识和 revision 保证页重放幂等。

同一服务实例拒绝并发任务。服务销毁会取消活跃工作并等待结束。健康状态只报告 cursor、计数、可选 tenant 和当前 sink 名称，绝不报告 `visibleText`。

## Alternatives considered

**通过 Kafka 或 CDC 历史重建。** 历史可能不可用、已压缩，或来自正待修复的逻辑。校准重建需要当前权威快照，并与实时事件传递保持独立。

**内置 MySQL reader。** 基础设施包无法选择应用的数据表、join、授权或事务隔离。source 仍由应用持有，并由应用注入分页实现。

**并发运行 sink。** 并发写入能缩短延迟，但会使立即停止行为和活跃失败位置更难预测。初始服务采用确定性的记录优先串行执行，仅在出现明确需求后再增加其他显式策略。

**每条记录后推进。** source cursor 标识页面而不是单条记录。页级推进不需要发明记录 cursor，使恢复机制可跨 source provider 使用，代价是必须支持幂等重放。

## Consequences

运维人员获得一个存储无关的修复路径，包含严格 tenant 校验、有界读取、取消、可观察进度和可恢复失败位置。Redis 与 Elasticsearch 适配器可在各自包中演进，不会把本服务耦合到任一客户端。

本服务不提供自动调度、跨 sink 事务或 exactly-once 写入。部分成功的页面会被重放，因此非幂等 sink 不兼容。串行 sink 也使总重建时间成为各 sink 写入延迟之和。
