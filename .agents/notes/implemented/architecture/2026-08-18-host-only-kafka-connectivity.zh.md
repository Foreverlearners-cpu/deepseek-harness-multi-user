# Agent Note: Host-only Kafka 传输

Status: implemented

[English](2026-08-18-host-only-kafka-connectivity.md) | 中文

## 问题

服务器领域需要共享的 Kafka 生命周期来处理元数据就绪、生产和消费。如果每个领域分别实例化 client，就会重复 bootstrap 校验、安全设置、错误分类和关闭逻辑。完全通用的传输还会让调用方在仓库拥有领域事件契约之前选择任意 topic 或 group。

依赖必须在 Windows、macOS 与 Linux 上支持仓库的 Node `^22.19.0 || >=24.0.0` 范围，且普通安装不能要求 native build toolchain。服务还必须对模型编写的动态 Cordis package 保持不可用。

## 决策

`@deepseek-ai/dsh-kafka` 是位于 `packages/multi/kafka` 的 Host-only Cordis service。一个插件实例拥有一个具名 Admin client，并在至少配置一个 topic 时拥有一个幂等 Producer。启动会强制获取 broker metadata 并初始化 Producer，之后 `ctx.kafka` 才可注入。启动失败会关闭全部已创建 client。

配置定义显式 topic 和 consumer-group allowlist。系统禁用自动创建 topic。`publish()` 接受非空二进制批次，使用 `acks: -1` 与幂等生产，并返回 broker 确认的位置。`subscribe()` 为每个订阅创建一个 Consumer，按顺序处理记录，且只在 awaited handler 成功后提交。每个订阅归属于准确调用它的 Cordis effect。Service dispose 会停止接纳，排空已接纳 publication 和当前 handler，并且只关闭一次 Admin、Producer 与 Consumer。

该 API 有意排除 transaction、topic 管理、event envelope、schema 管理、outbox persistence、去重、重试、dead-letter handling 和 replay。这些语义仍由领域 owner 负责。幂等生产不提供端到端 exactly-once delivery；仍需 stable event id、transactional outbox dispatch 与幂等 durable handler。

动态 Cordis 代码无法访问、解析、替换或探测 `kafka` service。维护者子系统 catalog 会记录它，模型侧运行时 catalog 则省略它。Broker ACL 仍是独立的生产控制。

依赖固定为 `@platformatic/kafka@1.34.0`，这是作出该决策时兼容仓库 Node 范围的最新版本。它是带可选平台 CRC acceleration 的 JavaScript client，支持 Kafka `3.5` 至 `4.2`。早先针对 `1.10.0` 的 compression override 已移除，因为对应依赖图不再适用。

TLS 使用平台信任根与服务器身份校验。可选用户名/密码 SASL 支持 `PLAIN`、`SCRAM-SHA-256` 与 `SCRAM-SHA-512`。分类后的 `KafkaError` message 只包含 binding 与稳定类别；依赖诊断仅保留在不会序列化的 cause 中。

## 考虑过的替代方案

**Confluent JavaScript client。** 不采用，因为其 `librdkafka` addon 使 pnpm 和跨平台安装依赖匹配的 binary 或 C++ toolchain。

**KafkaJS。** 不采用，因为与 Platformatic 的活跃维护线相比，其 stable release line 已不活跃。

**不受限制的 producer 与 consumer client。** 不采用，因为任意 topic、group、autocommit 和 topic creation 会绕过仓库所有权边界。所选 API 固定 acknowledgement 与 commit 行为，并且只接纳已配置名称。

**在该阶段加入 Kafka transaction。** 不采用，因为当前没有 consume-transform-produce 工作流定义 transaction ownership、fencing identity 或 recovery behavior。第一个能够证明这些要求的领域可以加入 transaction。

**向动态 Cordis package 暴露 Kafka。** 不采用，因为 broker access 是基础设施权限，不是模型 capability。Host-only enforcement 覆盖直接属性和动态 context operation，broker ACL 则提供纵深防御。

## 验证

聚焦测试覆盖 client 配置、启动清理、健康检查、错误分类、幂等 producer 初始化、二进制发布映射、allowlist 拒绝、顺序 handler 提交时序、失败 handler 不提交、准确调用方 effect 归属和关闭排空。Sandbox 测试拒绝属性、`get`、`provide` 和成员访问。Catalog 测试证明该服务保留在维护者文档中，但不出现在模型运行时 API 中。

环境门控的真实 broker 测试目前覆盖启动和健康检查。在作出生产声明前，生产、rebalance、restart、replay、outbox convergence 与 tenant isolation 行为仍需领域集成测试。

## 后果

可信 Host 插件现在可以通过有界共享生命周期完成生产和消费，无需构造底层 Kafka client。Topic 与 group allowlist 让意外的跨领域访问可评审，但不能替代 broker ACL 或 payload authorization。

关闭与发布重叠时，即使 broker 可能已经接收记录，publication 仍报告 `shutdown`。因此调用方将该结果视为不确定，并使用 stable event id 协调。Consumer handler 仍负责在返回前提交 durable effect，并容忍重复交付。

一个 service 仍只代表一个 cluster binding。Custom CA bundle、mutual TLS、OAuth token refresh、多个 binding、compression policy、forced-close deadline 与 Kafka transaction 保持延后。
