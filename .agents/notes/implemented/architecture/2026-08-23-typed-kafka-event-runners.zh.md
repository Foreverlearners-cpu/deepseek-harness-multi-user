# Agent Note: 强类型 Kafka 事件运行器

[English](2026-08-23-typed-kafka-event-runners.md) | 中文

Status: implemented

## Problem

领域消费者需要强类型事件解码、路由、过滤、生命周期观察和一致的 Cordis 所有权。如果每个 Redis、Elasticsearch、配置或审计消费者都重新实现这些机制，会重复容易出错的代码；如果把领域字段解释放进 Kafka 传输层，又会让基础设施耦合所有事件协议。

## Decision

`@deepseek-ai/dsh-kafka-events` 在 `@deepseek-ai/dsh-kafka` 之上提供与协议无关的强类型运行器。`EventCodec<T>` 负责线格式转换，`EventRouter<T>` 负责生产路由，消费者组合可选 `EventFilter<T>` 和一个 `EventHandler<T>`。本包不依赖 CDC，也不定义领域事件字段。

运行器保留 Kafka 语义，不做规范化。生产者不增加重试。消费者从已提交 offset 恢复，只在缺失 offset 时提供回退选择。解码、过滤和 handler 失败会原样到达传输层 handler，因此当前记录不会提交且 `done` 会拒绝。filter 拒绝是消费者的成功决定，允许提交 offset。

订阅健康状态包含生命周期和计数，不包含事件内容或失败详情。`done` 仍是权威失败信号。关闭操作可重复调用并等待传输层订阅；服务卸载会等待所有活跃订阅的关闭操作完成。

## Package topology

```text
dsh-kafka
    ↑
dsh-kafka-events
    ↑
domain event components
```

这个依赖方向让 CDC 事件、配置事件、认证事件和其他协议复用运行器，而不让运行器了解它们的 schema。

## Alternatives considered

**大型生产者和消费者基类。** 继承会把传输行为隐藏在覆写钩子后面，也会让 codec、路由、过滤和处理难以独立测试。小型泛型接口和组合方式让每项职责保持明确。

**在 `dsh-kafka` 内支持领域事件。** 这会让 Host 传输层负责 schema 版本、重试策略和领域解释。传输层继续保持二进制接口并负责 Broker 生命周期和 offset 提交；本包只负责强类型编排。

**自动重试和死信处理。** 通用重试规则无法知道 handler 效果是否幂等，也无法判断事件是否为毒消息。消费者和部署组合继续负责这些决策。

## Consequences

领域插件可以共享简洁的生产者和监听器模型，不必直接处理传输字节。它们仍需定义 schema、校验、分区、幂等、重试和恢复。聚焦测试固定路由、过滤、失败传播、健康计数、可重复关闭、静止卸载和 invariant 注册行为。
