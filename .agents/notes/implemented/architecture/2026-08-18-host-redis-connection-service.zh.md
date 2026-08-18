# Agent Note: Host Redis 连接服务

Status: implemented

[English](2026-08-18-host-redis-connection-service.md) | 中文

## 问题

多用户领域插件需要 Redis 支撑可重建 cache、rate limit、短期 coordination 和 invalidation wakeup。如果让每个消费方构造原始客户端，就会重复 target validation、启动检查、error listener 所有权、重连策略、credential handling 和资源释放逻辑，也容易让消费方在自身插件生命周期结束后继续保留客户端，或者跨越 Host 信任边界直接暴露 Redis。

Redis 不能作为 identity、membership、grant、ownership、持久 session、audit record 或其他状态的 authority，因为这些状态一旦丢失就会改变授权或正确性。因此，共享连接包需要承担狭窄的生命周期所有权，同时不能在消费方出现前凭空设计领域 cache 或 coordination 语义。

## 决策

`@deepseek-ai/dsh-redis` 是仅限 Host 的 Cordis 服务，同时承担 Redis Service Definition 和 Service Provider。它拥有一条独立部署模式的 `@redis/client` 命令连接，并通过 `ctx.redis.withClient(callback)` 暴露。领域插件仍是消费方，拥有 key namespace、可信 tenant 派生、serialization、TTL、atomic command、授权、重试和故障策略。

该包校验一个包含 host 的绝对 `redis:` 或 `rediss:` URL。其 `connectTimeoutMs` 配置默认为 `10000`，不得超过 Node 的 `2147483647` 毫秒 timer 上限，既限制该次 socket 连接尝试，也为初始 `connect()` 加 `PING` 提供一个总时限。完整 URL 是 secret 配置值，包自身编写的诊断不包含 endpoint 或 credential 字段。

客户端禁用离线命令队列与自动重连。启用时安装包拥有的 `error` 与 `ready` listener，连接并要求 `PING` 成功，然后才接纳回调。超时会销毁客户端，因此连接工作不能在启用失败后继续存在。其他启用失败会撤销已注册的资源 effect，并关闭已打开的客户端。发生意外断线后，服务会保持不可用，直到重新挂载插件。在每个不可用期间，该包记录一条通用 warning；收到 `ready` 后，后续不可用期间可以再记录一条。

只有服务仍接纳回调且 Node Redis 客户端 ready 时，`withClient` 才接纳工作。系统在调用回调前同步完成接纳。服务跟踪每个已接纳回调，原样返回其结果，并在结算后把它从 active set 中移除。回调必须等待自身启动的每个命令，并且不能保留、关闭、复制、订阅或重新配置共享客户端。阻塞命令、Pub/Sub、`WATCH` 范围内的 transaction 和其他具有连接状态的操作不属于该 API。

资源释放会先停止接纳，再等待全部已接纳回调，并在连接错误 listener 仍生效时关闭已打开的客户端。关闭结算后才移除包拥有的 listener，避免关闭期间的 socket 故障变成未处理的 EventEmitter 错误。资源释放会使服务拥有的资源完全停稳；它特意不设置时限，因为中止任意 Redis 命令不能证明消费方工作已经停止。

Redis 状态可以丢弃并重建。领域消费方从 authenticated call 获取 tenant scope，在构造或读取 key 前，根据权威状态执行授权。Redis miss、stale value、eviction、restart 和 outage 都不能授予 authority。Typert、API Proxy、工具、模型控制的 container 与 microVM 均无法取得客户端、URL、credential 或 network。

## 验证

Unit coverage 覆盖 URL 与 timeout 校验、解析后的客户端选项、启用时连接与 `PING`、通用错误去重、回调结果与失败、readiness 拒绝、超时销毁、启用失败后的清理、listener 清理，以及资源释放等待并发的已接纳回调。无需 credential 的本地 TCP fixture（测试前置数据）使用真实 Node Redis 客户端覆盖静默 peer、立即关闭和已建立连接丢失，并验证资源释放后不会重连或执行延迟连接工作。Opt-in test 使用 `DSH_REDIS_TEST_URL` 连接真实 Redis server，启动服务，并通过 `withClient` 执行 `PING`。

该包具有说明原因的空 invariant companion。Redis 可用性是外部状态，并非包拥有的进程内关系；生命周期行为在 operation 与资源释放位置进行断言。

## 考虑过的替代方案

**在每个领域插件中构造客户端。** 不采用，因为连接设置、secret handling、error listener 所有权和完全停稳的资源释放是共同的 Host 职责，而独立客户端会增加 socket 与重连 loop 数量。

**使用 Node Redis 自动重连。** 不采用，因为依赖拥有的 backoff timer 无法通过公开客户端 API 取消或等待，可能在启用 deadline 或资源释放之后继续运行。未来的重连设计必须让 retry 状态受服务生命周期管理；在此之前，重新挂载是显式恢复机制。

**现在就公开提供方无关的 cache 或 coordination API。** 不采用，因为尚无具体消费方能够确定 cache、rate limiter、lease、idempotency hint 与 Pub/Sub 之间统一的 operation set 或 failure policy。

**把 Redis 作为授权或持久状态 authority。** 不采用，因为 expiry、eviction、restart、stale read 和 partition 行为会让数据丢失或延迟变成错误访问或持久状态丢失。

**通过远程或模型可见接口暴露原始客户端。** 不采用，因为调用方可以绕过领域授权、选择任意 key 与 command，并获得基础设施 credential 或 network reachability。

**从 pool、Sentinel、Cluster 或专用有状态客户端开始。** 不采用，因为初始非阻塞命令用途只需要一条多路复用的独立部署客户端。每种额外 topology 或连接模式都需要具体 deployment 或消费方以及独立生命周期语义。

## 后果

连接生命周期、readiness、secret handling 和回调等待具有唯一的包所有者，而领域行为保留在理解其正确性与授权要求的插件中。初始 API 特意保持很小，本身尚未提供可用的 cache、limiter、lease 或 Pub/Sub 功能。

消费方必须在从 `withClient` 返回前等待每个命令；一个卡住的回调就可能无限延迟资源释放。发生意外断线后，服务不可用，直到重新挂载。需要自动恢复、其他 Redis topology、自定义 TLS material、有状态命令或有界关闭策略的部署，必须通过后续设计引入拥有它的消费方与测试。
