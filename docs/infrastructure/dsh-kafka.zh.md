# dsh-kafka 基础设施

[English](dsh-kafka.md) | 中文

本文档定义 Host 插件 `@deepseek-ai/dsh-kafka` 以及基于该插件构建领域事件交付的要求。当前[包](../../packages/multi/kafka/README.md)提供有界 producer、consumer 传输与生命周期管理；它不是 authorization service、模型工具或权威数据库。[Kafka 传输 Agent Note](../../.agents/notes/implemented/architecture/2026-08-18-host-only-kafka-connectivity.md)负责 dependency 与 API 决策。

## 范围

`dsh-kafka` 当前负责一个具名 Admin client、一个可选幂等 Producer、调用方作用域内的 Consumer、启动 metadata verification、metadata health、allowlist enforcement、失败分类和 client shutdown。领域插件仍负责 topic schema、事件含义、partition key、retention 要求、stable event id、durable consumer effect 和 projection 行为。

该插件只在可信 Host 组合中运行。系统永远不通过 Typert、API Proxy、模型工具或会话执行环境投射该插件。调用方不能仅凭命名 Kafka binding 就获得 tenant 或 topic 访问权。

Kafka 在 MySQL transaction 完成后传输已提交领域事件。MySQL 仍是 identity、membership、authorization、会话日志、settings、audit record 和其他关系状态的权威真源。Kafka 是持久传输和 replay buffer；消费方必须容忍 Kafka 不可用、延迟、重复或 replay。

## 包的位置

在第二种 broker 实现证明提供方无关事件传输 API 确有价值之前，该包同时包含 Kafka Service Definition 与 Service Provider。领域消费方保留自身公共能力，只把 `dsh-kafka` 用作内部传输。

| Package 或 component | 角色 | 所有权 |
|---|---|---|
| `@deepseek-ai/dsh-kafka` | Kafka Service Definition 与 Service Provider | Admin、幂等二进制发布、顺序手动提交订阅、metadata health、allowlist、shutdown 和 classified failure |
| 领域 outbox dispatcher | Producer | Outbox selection、topic 与 key selection、event envelope construction、publication state 和 reconciliation |
| 领域 projection worker | Consumer | Subscription、deduplication、checkpoint policy、retry、projection write 和 poison-event handling |
| 会话持久化 | 权威会话消费方 | MySQL 中的 session header 与仅追加 event row；Kafka 不实现或替代 `SessionPersistence` |

大型 attachment、workspace content、spill 文件和 binary output 仍保存在 object storage 或 tenant volume 中。Kafka event 包含经过授权的 reference 与 lifecycle metadata，而不是 binary payload。

## 服务模型

当前 service 拥有一个具名 Kafka binding。一个插件实例拥有一个 Admin client configuration、一个可选 Producer 和每个活动订阅各一个 Consumer；只有当前组合需要多个 cluster 时，未来 registry 才可以承载多个 binding。

```text
ctx.kafka
  binding -> KafkaBindingId
  health() -> KafkaHealth
  publish(messages) -> KafkaPublishedOffset[]
  subscribe(request) -> KafkaSubscription
```

经过校验的 Cordis 插件配置提供 binding、broker、client id、TLS choice、可选 SASL credential、timeout、retry、topic allowlist、consumer-group allowlist 和 consumer buffer bound。空 broker list、重复或空 allowlist entry、无效 client setting 和不可达 bootstrap broker 会在插件启动之前或期间失败。系统不会使用 process-global default 将领域静默重定向到另一 cluster。

Admin 与 Producer 归 service scope 所有；每个 Consumer 归准确调用它的 plugin effect 所有，不能比其存活更久。Dispose 停止接纳操作，排空已接纳 publication 和当前 handler，并且只关闭一次每个 client。所选 client 不暴露 forced-close deadline，因此 deployment process 保留外层 shutdown bound。

## 配置与安全

所有随部署变化的值都由经过校验的配置提供。

| 配置区域 | 必需行为 |
|---|---|
| Broker 与 identity | 解析显式 broker list、client id 与具名 binding；拒绝空 target |
| 传输安全 | 使用 platform trust root 校验 TLS server identity；plaintext 需要显式 `tls: false` |
| Authentication | 接受部署提供的 username/password SASL，且不在 classified message 中暴露 secret value |
| 生命周期 | 配置 connection、request、retry count 和 retry delay |
| Topic 与 group 访问 | 要求配置 topic 和 consumer-group allowlist；禁用自动创建 topic |
| 当前限制 | 不暴露 transaction、topic creation、custom CA、mutual TLS 或 OAuth operation |

Kafka credential 是部署 bootstrap secret。它们不能来自 tenant 提交的请求字段，也不能来自依赖同一 Kafka connection 的 credential store。生产 identity 使用最小权限 Kafka ACL：dispatcher 只能写入自身拥有的 topic，projection worker 只能通过专用 consumer group 读取自身 subscription。

Event envelope 与 partition key 中的 tenant id 支持 routing 和 filtering，但永远不能建立 authorization。Producer 从可信领域状态派生 tenant identity。Consumer 在写入前校验预期 topic 与 event owner，其 target repository 还要执行自身 tenant-scoped operation。

Kafka client 与 credential 保留在模型控制的 container 和 microVM 之外。执行环境调用经过授权的 Harness capability，永远不能获得 `ctx.kafka`、broker address、client certificate 或 SASL secret。

## 事件与交付语义

Kafka 采用至少一次交付。Publish 成功表示系统收到配置要求的 broker acknowledgement；不表示每个 consumer 都已处理事件。Timeout 与 connection loss 可能使 publication outcome 未知，因此 outbox dispatcher 通过 stable event id 对账，不能假设失败等于事件不存在。

每个 event envelope 包含 stable event id、event type 与 schema version、source domain 与 resource id、source revision、适用时的 tenant id、occurrence time 和 trace metadata。Envelope 排除 authentication token、credential value、consumer 不需要的 message body 和不受限 request payload。

Partition key 只在选定 tenant 与 aggregate 内保持顺序。调用方不能依赖 partition、topic、tenant 或 cluster 之间的全局顺序。需要顺序应用的领域选择 `(tenant_id, aggregate_id)` 等 stable key，并拒绝或延后乱序到达的 revision。

Consumer 在权威 target 或 projection checkpoint store 中按 stable event id 与 source revision 去重。Handler 必须幂等，因为 rebalance、retry、producer uncertainty 和 operator replay 都可能多次交付同一事件。Consumer 只有在 durable effect 与 deduplication record 一起 commit 后才提交 Kafka offset。

领域 owner 定义其 event type 的 backward compatibility 与 forward compatibility 规则。未知的必需 schema version 需要显式失败，且不能推进受影响 checkpoint。Retention 必须覆盖支持的最长 outage 与 replay interval；Kafka retention 不能替代 MySQL backup 或 domain history。

## Transactional outbox

领域 mutation 与其 outbox row 在同一个 MySQL transaction 中 commit。独立 dispatcher lease 已提交 row，构造领域拥有的 event envelope，将其 publish 到 Kafka，并记录 publication progress。Request handler 永远不在权威 transaction 内 publish Kafka，也不能仅因 commit 后 Kafka 不可用就把 domain write 报告为失败。

当 broker acknowledgement 或 publication-state persistence 结果不确定时，dispatcher 可能多次 publish 同一 outbox row。Stable event id 与幂等 consumer 使 retry 安全。系统暴露 outbox lag、最早 unpublished age、attempt 和 terminal classification；operator 可以 pause、replay 或 reconcile domain stream，而无需修改权威 domain row。

Redis 仍用于可丢弃 cache、rate limiting、lease 和短期 coordination。Elasticsearch 仍是最终一致、tenant-scoped 且可重建的 projection。Kafka 可以交付它们的 update event，但两者都不能成为 authorization source，也不能替代 MySQL 与 session event log。

## 失败与生命周期语义

- 启动过程解析 credential、连接 bootstrap broker、获取 cluster metadata，并在服务可用前校验每个 configured binding。Authentication、TLS、protocol 或 topic-authorization failure 会使启动失败。
- Readiness 要求必需 binding 在有界时间内成功完成 broker metadata check。Liveness 不要求 Kafka round trip。
- Retry 只应用于分类为 transient 的 failure，并受配置的 attempt 或 elapsed time 限制。基础设施服务永远不 retry 任意 domain handler。
- 永久 authentication、authorization、unsupported-protocol、invalid-topic、oversized-event 和 schema failure 需要显式失败。领域消费方负责 retry-topic 或 dead-letter policy，因为只有领域才能判断 event meaning 与 repairability。
- Rebalance 停止 revoked partition 的新 handler admission，并在配置时限内等待已接纳工作，然后释放 ownership。Handler 永远不能在 revoked partition lease 下继续写入。
- Shutdown 停止新 lease 与 polling，在配置时限内 drain 已接纳 publication 和 handler、记录未完成工作、断开 client，并在 dispose 完成前达到完全停稳。

## 可观测性

Metric 包含 connection state、metadata-check latency、producer queue depth、publish outcome 与 latency、consumer-group lag、rebalance count 与 duration、handler outcome、retry、outbox lag 和 classified failure。Label 可以包含有界 binding、topic、consumer-group、event-type 与 outcome value；不能包含 tenant id、resource id、event payload、credential 和无界 error text。

Log 在字段可用时关联 binding、topic、partition、offset、stable event id、consumer group、operation 和 classified failure。它们永远不记录 SASL secret、private key、authentication token、完整 event payload、message 或 tool body，也不记录不受限 broker response。

## 当前实现阶段

当前代码实现一个具名 Kafka binding、经过校验的 broker 与 security configuration、Admin 与可选幂等 Producer 创建、启动 metadata verification、有界 metadata health、allowlist 限制的二进制发布、调用方拥有的顺序手动提交订阅、classified failure 和达到完全停稳的 shutdown。[包 README](../../packages/multi/kafka/README.md)负责 verification command 和准确的 caller-visible behavior。

该阶段不暴露 Kafka transaction，不创建 topic，不实现 outbox dispatcher，不定义 event envelope，不持久化去重状态，也不添加 retry 与 dead-letter topic。Consumer group 只能通过配置获准；其领域语义与生产 ACL 需要独立所有权和测试支撑。

## 后续阶段的验证要求

- 共享 lifecycle test 使用真实 broker 校验 startup admission、metadata health 和干净 shutdown；forced shutdown 与 cancellation 需要 client 支持后才能成为承诺。
- Producer integration test 校验 acknowledgement mode、backpressure、oversized-event rejection、uncertain publication outcome 和 stable event-id reuse。
- Consumer integration test 校验 rebalance safety、durable-effect-before-offset ordering、duplicate delivery、out-of-order revision、restart recovery 和 operator replay。
- Outbox test 在 MySQL commit、broker acknowledgement 与 publication-state recording 之间中断 dispatch，证明最终交付且不会产生重复 authoritative effect。
- Tenant-isolation test 使用两个 tenant 中的有效 id，证明 topic selection、key、payload ownership、projection write、metric 和 log 不会披露或修改另一 tenant。
- Assembled server test 证明 remote、in-process 和 model-controlled path 都无法取得 Kafka service 或 broker credential。

## 已知限制与待决定问题

- 当前组合需要多个 Kafka cluster 时，是否添加具名 binding registry。
- Topic strategy：带 tenant partition key 的 shared domain topic、tenant-specific topic 或有界 hybrid。
- Event encoding 与 schema management，包括是否运行 schema registry。
- 后续领域需求是否需要 Kafka transaction、compression，或固定幂等全副本 producer 之外的 batching 控制。
- 每个领域的 consumer retry、retry-topic、dead-letter、quarantine 和 operator-replay policy。
- 每种 deployment profile 的 retention、partition count、maximum event size、replication 和 disaster-recovery objective。
- Custom CA、mutual-TLS、OAuth token-refresh 和 forced-close ownership。

[Kafka 连接 Agent Note](../../.agents/notes/implemented/architecture/2026-08-18-host-only-kafka-connectivity.md)记录当前 package decision 与备选方案。
