# @deepseek-ai/dsh-kafka

[English](README.md) | 中文

供可信服务器插件使用的 Host-only Kafka 传输。一个服务统一拥有元数据健康检查、可选的幂等 Producer 和调用方作用域内的 Consumer。[基础设施参考](../../../docs/infrastructure/dsh-kafka.md)定义该传输之上的领域事件、outbox 与租户隔离要求。

## 配置

| 字段 | 必需 | 行为 |
|---|---|---|
| `binding` | 是 | 非空运维名称，包含在健康结果和分类错误中 |
| `brokers` | 是 | 非空 `host:port` bootstrap 列表；IPv6 使用 `[address]:port` |
| `clientId` | 是 | Kafka 协议 client id |
| `tls` | 是 | 使用平台信任根和服务器身份校验启用 TLS |
| `sasl` | 否 | 使用 `PLAIN`、`SCRAM-SHA-256` 或 `SCRAM-SHA-512` 的用户名/密码认证 |
| `requestTimeoutMs` | 否 | 正整数操作时限；默认 `10000` |
| `connectionTimeoutMs` | 否 | 正整数 TCP/TLS 连接超时；默认 `5000` |
| `retries` | 否 | 非负安全整数重试次数；默认 `3` |
| `retryDelayMs` | 否 | 非负重试间隔；默认 `300` |
| `topics` | 否 | 生产和消费共用的唯一非空 topic allowlist；默认 `[]` |
| `consumerGroups` | 否 | 唯一非空 consumer-group allowlist；默认 `[]` |
| `consumerHighWaterMark` | 否 | 每个订阅的流缓冲大小，范围 `1` 至 `65536`；默认 `16` |

`topics` 为空时传输操作保持禁用，也不会创建 Producer。系统始终禁用自动创建 topic。密码只保留在部署配置和依赖状态中；调用方不得记录 `KafkaError.cause`，其中可能含有依赖诊断信息。

## 健康检查与生产

`Service.init` 在服务可注入前强制获取元数据，并在配置了 topic 时初始化 Producer。启动失败会关闭全部 client。`health()` 只返回 `{ binding, clusterId, brokerCount }`。

`publish(messages)` 接受发送到已配置 topic 的非空批次，key、value 与 header 均为二进制。Producer 使用幂等模式、`acks: -1`，且不自动创建 topic。结果包含 broker 确认的 topic、partition 与 offset。幂等生产只能减少同一 producer session 内的重复，不能替代稳定 event id、transactional outbox 或幂等领域 Consumer。关闭与发布重叠时，即使 broker 可能已经接收记录，调用仍报告 `shutdown`，因此调用方必须把结果视为不确定。

## 消费

`subscribe({ id, groupId, topics, mode, handle })` 为获准的 group 和非空 topic 集创建一个 Consumer。`mode` 可为 `committed`、`earliest` 或 `latest`。记录按顺序交给 awaited handler，且只在 handler 成功后提交。Handler 失败会让记录保持未提交、拒绝 `subscription.done` 并关闭 Consumer。

订阅归属于准确调用 `subscribe()` 的 Cordis effect。处置该插件或调用 `subscription.close()` 会停止拉取、等待当前 handler、退出 group 并关闭 Consumer。订阅 id 在服务内必须唯一。持久化副作用顺序、去重、schema 校验、重试策略和 poison-event 处理仍由 handler 负责。

## 访问边界与生命周期

`ctx.kafka` 只对可信 Host 插件可用。动态 Cordis sandbox 会拒绝对 `kafka` 的属性访问、`get`、`provide` 和成员探测；模型运行时 API catalog 也会省略它。该应用边界不能替代 broker ACL；生产凭据仍必须独立限制已配置的 topic 和 consumer group。

处置会停止接纳新的健康检查、发布和订阅，等待已接纳的健康检查、发布操作和当前 handler，然后只关闭一次 Admin、Producer 与 Consumer。Client 没有独立 forced-close deadline，因此部署仍需提供外层进程关闭时限。

## 错误与验证

`KafkaError.code` 为 `authentication`、`configuration`、`protocol`、`shutdown`、`timeout`、`unavailable` 或 `unknown`。错误消息只含 binding 与稳定类别。依赖固定为 `@platformatic/kafka@1.34.0`，兼容本仓库 Node 范围及 Kafka `3.5` 至 `4.2`。

聚焦单元测试覆盖配置、启动清理、健康检查、错误分类、二进制发布、授权、提交顺序、handler 失败、effect 归属和关闭排空。环境门控的 e2e 测试目前验证真实 broker 的启动与健康检查：

```sh
DSH_KAFKA_BROKERS=127.0.0.1:9092 pnpm exec vitest run --config vitest.e2e.config.ts packages/multi/kafka/tests/kafka.e2e.ts
```

## 模型体验

### Kafka 传输

#### 模型可见内容

无。`ctx.kafka` 不注册 tool、prompt、message 或 session event，并从模型侧 Cordis catalog 中排除。

#### Token 影响

每次请求的直接 token 为零。

#### KV Cache 影响

与模型请求无关。

## 已知限制与延后工作

- **一个 binding** — 一个插件实例拥有一个 Kafka cluster binding。
- **没有 transaction** — 传输层不暴露 Kafka transaction 或原子的 consume-transform-produce。
- **没有领域协议** — event envelope、schema、outbox dispatch、去重、retry topic、dead-letter handling 和 replay 仍由领域负责。
- **没有 topic 管理** — topic 必须在该服务之外预先创建。
- **安全选项有限** — 尚未配置 custom CA bundle、mutual TLS、TLS server-name override 和 OAuth token refresh。
- **没有传输压缩策略** — 调用方不能通过该 API 选择 codec；增加压缩前必须验证 broker 和 payload 行为。
- **e2e 仅覆盖健康检查** — 真实 broker 下的生产、rebalance、restart 和 replay 仍需集成测试。
