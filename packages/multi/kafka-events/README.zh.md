# @deepseek-ai/dsh-kafka-events

[English](README.md) | 中文

面向可信 Host 插件的强类型事件生产与消费组件。本包建立在 [`@deepseek-ai/dsh-kafka`](../kafka/README.zh.md) 之上，不定义领域协议，也不依赖 CDC。

## 组合

先加载 `@deepseek-ai/dsh-kafka`，再加载本服务。`ctx.kafkaEvents.producer(codec, router)` 创建无状态强类型生产者，`ctx.kafkaEvents.subscribe(options)` 创建由作用域持有的强类型消费者。

`EventCodec<T>` 负责线格式编码和校验，`EventRouter<T>` 选择 Topic、分区键、Header 和可选时间戳。消费者使用相同的 codec，并组合可选 `EventFilter<T>` 与一个 `EventHandler<T>`。

## 生产

`KafkaEventProducer.publish(event)` 发布一个事件，并要求 Kafka 返回恰好一个确认位置。`publishBatch(events)` 拒绝空批次，并按输入顺序向 Kafka 传递记录。两个方法都返回底层确认位置，并原样传播传输失败。

运行器不增加重试，因此不确定的发布结果保留 Kafka 传输层定义的准确语义。事件 ID、Outbox 持久性、去重和路由策略仍由协议或领域插件负责。

## 消费

每个订阅声明 ID、消费组、Topic、缺失 offset 时的 `fallbackMode`、codec、可选 filter 和 handler。Kafka 始终从已提交 offset 恢复；只有分区没有已提交位置时才使用 `fallbackMode`。

记录依次经过解码、过滤和处理。filter 返回 `false` 表示该记录已成功处理，传输层可以提交 offset。解码、过滤或 handler 失败会被原样抛出，使 `subscription.done` 拒绝，并阻止提交当前记录。运行器不会自动重试、跳过、暂停或替换失败。

`subscription.close()` 可重复调用，并等待底层 Kafka 关闭及正在执行的 handler。服务卸载时通过 `Promise.allSettled` 关闭全部活跃订阅，因此一个关闭失败不会阻止其他订阅进入静止状态。

## 健康状态

`subscription.health()` 报告生命周期状态以及接收、过滤、成功处理和失败计数，不包含事件内容或异常详情。`ctx.kafkaEvents.health()` 按 ID 返回活跃订阅快照。消费者仍必须监督 `done`；健康状态只用于观察，不负责故障恢复。

## 模型体验

### 强类型 Kafka 事件运行器

#### 模型看到什么

没有内容。本包不注册工具、提示词、消息或会话事件。

#### Token 影响

每次请求直接增加零 Token。

#### KV Cache 影响

与模型请求无关。

## 已知限制与延期工作

- **没有 Schema Registry** — codec 负责协议版本和线格式校验。
- **没有重试策略** — 重试 Topic、死信、毒消息处理和运维重启策略由消费者负责。
- **没有去重** — 需要幂等效果时，handler 必须使用领域事件 ID 或源 revision。
- **没有消费-转换-生产事务** — 运行器不会在传输层之上增加 Kafka 事务。
