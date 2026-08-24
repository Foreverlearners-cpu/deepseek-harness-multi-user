# Agent Note: Kafka 订阅生命周期可靠性

Status: implemented

[English](2026-08-23-kafka-subscription-lifecycle-reliability.md) | 中文

## 问题

持久化 Kafka Consumer 必须在重启后从 committed offset 恢复、区分主动关闭与 stream 意外停止，并避免在首次 offset 已知前报告就绪。没有时限的依赖关闭也可能阻止 Cordis 处置达到静止状态。

## 决策

`KafkaSubscribeRequest.fallbackMode` 仅在 consumer-group partition 没有 committed offset 时选择 `earliest`、`latest` 或 `fail`。其他情况下，每个订阅都以 committed mode 打开。`subscribe()` 在 stream 报告首次 offset 后才 resolve，从而防止仍在进行的初始 latest 查询跳过调用方认为订阅就绪后发布的记录。

`KafkaSubscription.done` 仅在调用方主动关闭后 resolve。Handler 失败、client 失败和 stream 意外完成都会使其 reject，因此 Consumer 插件必须监督该 Promise，并负责重启或终止失败策略。只有成功的 handler 才会提交 offset。

`requestTimeoutMs` 限制订阅就绪、当前 handler 排空、stream 与 client 关闭、已接纳发布排空，以及 Admin 或 Producer 关闭。Consumer 的优雅关闭超过时限或失败时，会升级为依赖提供的强制关闭。延迟结算的依赖 Promise 始终被观察，不会成为未处理 rejection。

## 备选方案

**允许调用方在每次启动时选择 committed、earliest 或 latest。** 拒绝，因为选择 earliest 或 latest 可能忽略已有 committed offset，并在重启后重放或跳过持久化工作。

**在 `consume()` 返回 stream 时报告订阅就绪。** 拒绝，因为 stream 对象已经存在时，依赖仍可能正在解析首次 offset，尤其是 latest fallback。

**把 stream 意外完成视为成功关闭。** 拒绝，因为拥有该订阅的插件会保持 active，却不再消费记录。

**无限等待依赖清理。** 拒绝，因为一个停滞的网络 client 会阻止应用处置达到静止状态。

## 验证

聚焦 transport 测试固定了带显式 fallback 的 committed-mode 打开、offset 初始化后的就绪、顺序提交、失败 handler 和意外 stream rejection、effect 归属，以及有时限的发布和 client 关闭。

## 后果

每个 Consumer 都必须提供 fallback 策略并监督 `subscription.done`。重启订阅的 Consumer 插件继续负责退避、重试耗尽、poison-event 处理和持久化副作用幂等。超时的依赖操作仍可能在 client 库内部继续运行，因此部署仍需提供外层进程关闭期限。
