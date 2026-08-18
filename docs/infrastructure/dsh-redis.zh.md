# dsh-redis 基础设施

[English](dsh-redis.md) | 中文

本文定义仅限 Host 的 `@deepseek-ai/dsh-redis` 服务，以及 Redis 支撑多用户功能时的所有权规则。首个包拥有一个独立部署模式的 Node Redis 客户端及其连接生命周期；cache、rate limit、lease、idempotency、invalidation 和 Pub/Sub 行为由领域消费方拥有。

## 范围

`dsh-redis` 校验一个 Redis 目标，在启用期间连接并发送 `PING`，接纳回调范围内的客户端使用，在资源释放期间停止接纳，等待已接纳回调，并关闭自身客户端。它是可信 Host 依赖，永远不通过 Typert、API Proxy、工具或模型控制的执行环境投影。

该服务不分配 key、不派生 tenant scope、不序列化领域值、不选择 TTL、不实现授权，也不决定 Redis 故障时按允许还是拒绝处理。每个领域消费方拥有这些决定，因为不同领域的正确性和安全后果不同。

Redis 数据必须可以丢弃并重建。持久 identity、grant、session、settings、audit record 和其他权威记录保留在各自所属的持久存储中。Redis miss、restart、eviction、stale value 或服务不可用都不能产生 authority 或授予访问权。

该包不贡献提示词、工具 schema、消息、会话事件或其他模型可见数据。消费方使用 Redis 准备模型可见输入时，仍必须能够从其持久状态与会话事件重建该输入。

## 包位置

| 包或组件 | 角色 | 拥有的数据或行为 |
|---|---|---|
| `@deepseek-ai/dsh-redis` | Redis Service Definition 与 Service Provider | 客户端配置、启用检查、回调接纳、连接生命周期和包级诊断 |
| 领域 Redis 插件 | 领域服务背后的消费方 | Key namespace、tenant scope、serialization、TTL、atomic operation、授权和故障策略 |
| 持久变更发布方 | 权威变更生产方 | 至少一次 invalidation 或 projection record、stable event id、source revision 和 deletion fact |

只有具体消费方证明存在不会抹去 cache、limiter、lease 和 Pub/Sub 之间重要差异的 API 后，才提取提供方无关的 cache 或 coordination service。领域服务只在可信 Host 组合内部依赖 `dsh-redis`；远程调用方继续使用执行授权的领域服务。

## 初始服务模型

```text
ctx.redis
  withClient(callback) -> result
```

`withClient(callback)` 把服务拥有的 Node Redis 客户端传给一个回调，并返回回调结果。系统在回调开始前完成接纳，因此资源释放会等待每个已接纳操作。回调必须等待自身启动的全部命令，并且不能保留、关闭、复制或重新配置客户端，不能添加持久 listener，也不能改变连接状态。

该客户端是一条共享的多路复用命令连接，不是独占 lease。初始 API 只支持普通非阻塞命令。阻塞命令、Pub/Sub subscription、`WATCH` 范围内的 transaction 和其他具有连接状态的操作需要独立拥有的客户端与生命周期规则；`withClient` 不支持这些操作。

系统禁用离线命令队列与自动重连。客户端未 ready 时回调会被拒绝；断开连接竞态会使受影响的 Node Redis 命令失败，而不会保留无界排队工作。发生意外断线后，服务会保持不可用，直到重新挂载插件；每个消费方按照自身领域策略处理操作失败。

## 配置与启用

| 配置键 | 必需行为 |
|---|---|
| `url` | 指定一个独立部署模式的 `redis:` 或 `rediss:` 目标，并包含部署要求的 username、password 和 database number |
| `connectTimeoutMs` | 限制初始连接与 `PING` 的总时间以及该次 socket 连接尝试；默认为 `10000`，且不得超过 `2147483647` |

配置 schema 把完整 URL 标记为 secret，因为其中可能包含 credential。包自身编写的诊断永远不插入 URL、username、password、query parameter 或 TLS material。底层 Node Redis 连接与命令错误会原样传播，并可能标识 network endpoint，因此调用方不能把这些错误与配置值组合记录。URL 无效、scheme 不支持、缺少 host、timeout 无效、连接超时、认证失败或 `PING` 失败都会使插件启用失败。

生产部署使用校验服务端身份的 `rediss:`，并使用最小权限 Redis ACL user。Logical database number 只是 keyspace 便利机制，不是安全边界。部署专用 certificate authority、client certificate、Unix socket、Sentinel、Cluster 和 managed-service identity 暂缓到具体 profile 需要时处理。

## 领域数据规则

每个消费方拥有稳定 namespace，在 resource id 前包含 deployment、domain、key-format version 和可信 tenant scope。不能仅为简化查询而让 key 或 value 包含 authentication token、credential value、原始 prompt、message content 或其他 secret。Key format 变更使用新 version，并提供有界 cleanup 或自然 expiry。

Cache entry、rate-limit bucket、lease 和短期 idempotency hint 具有显式 TTL。消费方定义 serialization versioning、最大 value size、atomic update mechanism，以及 malformed 或 unknown version 的处理方式。禁止 unbounded collection、tenant-wide key scan 和由请求选择的 Redis command name。

| 用途 | 正确性规则 |
|---|---|
| Cache 与 revocation acceleration | Miss 或 malformed value 会读取权威领域服务；stale data 不能绕过当前授权或 revocation check |
| Rate limiting | 消费方按操作定义按允许或拒绝处理；Redis 无法确定结果时，authentication、credential 和 abuse-sensitive limit 按拒绝处理 |
| Runtime lease | Expiry、pause 和 partition 可能产生并发 holder，因此 lease 使用 fencing 或权威 revision，且不能独自证明持久 ownership |
| Idempotency hint | Redis 可以短暂抑制重复工作，但持久修改仍使用权威 uniqueness 或 revision rule 以及持久变更事实 |
| Pub/Sub | 消息只作为 best-effort wakeup；持久 replay 与 recovery 读取所属 outbox 或 event log |

至少一次交付的 projection 消费方应用 stable event id 和 source revision，使重复交付保持幂等，保留足够久的 deletion fact 以实现最终收敛，并暴露 lag，而不把 Redis 提升为持久事件来源。

## 租户隔离与授权

领域方法在构造 Redis key 前，从 authenticated call 派生可信 tenant scope。Tenant segment 可以防止意外碰撞，但不能授权访问：领域通过权威状态校验 membership、resource ownership 和 operation permission，之后才能披露存在性或内容。

`dsh-redis` 永远不把请求提交的 tenant 当作 authority，也不公开跨 tenant scan helper。来自其他 tenant 的有效 resource id 不能到达无 scope 的 key 或 channel。平台全局 key 具有显式分类，租户产品 repository 无法访问它们。

Redis network、URL、ACL credential 和 Node Redis client 留在模型控制的 container 与 microVM 之外。这些环境调用已授权 tool 和 provider adapter；它们永远不接收 `ctx.redis` 或直接 Redis connectivity。

## 生命周期、失败与可观测性

- 启用时创建客户端、安装包拥有的 `error` 与 `ready` listener、在配置时限内连接，并要求 `PING` 成功后才公开服务。
- `withClient` 原样传播回调与命令失败，不改写失败，也不重试回调。消费方只能重试幂等的领域操作。
- 在每个不可用期间，该包记录一条不含连接细节的通用连接错误诊断；`ready` 事件允许在后续不可用期间再次记录。领域 log 与 metric 使用有界 operation name，并排除 key、value、tenant id、credential 和无界 resource id。
- 资源释放会停止接纳新回调，等待每个已接纳回调结算，在连接错误 listener 仍生效时关闭客户端，然后移除包拥有的 listener，最后才完成资源释放。
- Liveness 不要求 Redis round trip。未来 readiness 与 metric 可以报告 connection state、operation latency 和 failure，但不能把 Redis 当作持久 authority。

## 必需验证

- Unit test mock Node Redis，并覆盖已校验的客户端选项、timeout 限制、启用时连接与 `PING`、回调结果与失败、readiness 拒绝、诊断去重、启用失败后的清理、并发回调排空和完全停稳的资源释放。
- 无需 credential 的网络测试使用本地 TCP fixture（测试前置数据）与真实 Node Redis 客户端，覆盖静默启动、立即关闭、已建立连接丢失、关闭自动重连，以及资源释放后没有延迟连接工作。
- Opt-in test 使用 `DSH_REDIS_TEST_URL` 连接真实 Redis 服务，启动 Cordis service，通过 `withClient` 执行 `PING`，并释放连接。
- 后续领域测试使用两个有效 tenant scope，证明 key isolation、强制 expiry、outage policy、malformed-value handling 和重复变更交付的幂等性。
- 完整组装的 server test 证明 remote、in-process model 和 model-controlled execution path 无法取得 Redis service 或 credential。

## 已知限制与暂缓事项

- 初始服务支持一个独立部署 URL 和一条共享非阻塞命令客户端。具名 binding、pool、read replica、Sentinel、Cluster、阻塞操作、Pub/Sub 和专用 transaction client 均暂缓实现。
- 不支持自动重连。发生意外断线后需要重新挂载插件；未来的重连策略必须拥有可取消的 retry 状态，并在资源释放期间等待其结束。
- 初始服务没有 domain cache API、limiter、lease 实现、outbox 消费方、health service、metric 或 Redis error classification。
- 资源释放没有时限地等待已接纳回调。消费方必须等待自身启动的每个命令与回调结算。

[Host 连接服务实操手册](../cookbook/adding-a-host-connection-service.md)解释实现与集成耗时的差异，并给出可复用的交付工作流。

[Host Redis 连接服务 Agent Note](../../.agents/notes/implemented/architecture/2026-08-18-host-redis-connection-service.md)拥有服务拆分与生命周期决策。
