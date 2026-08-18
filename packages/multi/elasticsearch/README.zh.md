# @deepseek-ai/dsh-elasticsearch

[English](README.md) | 中文

供搜索 projection 领域插件使用的仅限 Host 的 Elasticsearch client 服务。该包公开 `ctx.elasticsearch.operation(callback)`，拥有一个官方 Elasticsearch JavaScript client，在启动期间校验连通性，并在关闭 client 前等待已接纳 callback 完成。[Elasticsearch 基础设施参考](../../../docs/infrastructure/dsh-elasticsearch.md)说明当前所有权；搜索领域仍保留 authorization、query、index、mapping、document、outbox 消费和 rebuild 的所有权。

## 配置

| 配置键 | 必需 | 含义 |
|---|---|---|
| `node` | 是 | 绝对 HTTP(S) Elasticsearch node URL；允许 path prefix，禁止 credential、query 和 fragment |
| `auth.username` 与 `auth.password` | 否 | Basic authentication pair；password 标记为 secret |
| `auth.apiKey` | 否 | 标记为 secret 的 Base64 编码 API key |
| `auth.bearer` | 否 | 标记为 secret 的 bearer 或 service-account token |
| `caFingerprint` | 否 | CA SHA-256 指纹，格式为 64 个十六进制数字或 32 个以冒号分隔的十六进制 byte |
| `allowInsecureHttp` | 否 | 对 plaintext HTTP 的显式 trusted-local opt-in；默认为 `false` |
| `maxRetries` | 是 | 官方 client 的重试默认值；callback 可通过逐请求选项覆盖该值 |
| `requestTimeoutMs` | 是 | 官方 client 的请求超时默认值，单位为毫秒；callback 可按请求覆盖该值 |
| `pingTimeoutMs` | 是 | 启动与 connection-pool ping 的最大持续时间，单位为毫秒；范围为 `1..2147483647` |

对于显式禁用安全功能的 cluster，可以省略 authentication。其他情况必须配置且只能配置一种字段非空的完整 basic、API-key 或 bearer 策略。`auth` 内只接受 `username`、`password`、`apiKey` 和 `bearer`；服务会拒绝所有未知字段，包括与有效策略并存的未知字段。服务还会在构造 client 前拒绝 malformed URL、URL query 或 fragment、包含 credential 的 URL、没有显式 opt-in 的 plaintext HTTP、格式错误或与 HTTP 同时使用的 CA 指纹、不完整 basic authentication、冲突的 authentication strategy，以及超过 Node timer limit 的 ping timeout。

Client 以 replacement mode 启用自身 metadata redaction。该包不记录配置、request body、response hit 或 connection error，因此包自身的 diagnostics 不会复制 credential 与受保护搜索内容。

## 操作生命周期

启动过程调用一次 `ping()`，禁用 retry，并把 `pingTimeoutMs` 应用于该 request。在 ping 返回 `true` 且插件 activation 完成前，Consumer 调用 `operation(callback)` 会被拒绝。已接纳 operation 使用共享官方 client 的借用视图调用 callback。该 TypeScript 视图包含官方 request method、overload 与 helper，但不能直接访问 `close()`、`child()`、transport internal 和 client metadata。Callback 可以返回已物化的响应数据或 promise，但不能保留 client；它必须等待依赖 client 的 request，并在其结果结算前完整消费或关闭依赖 client 的 stream 与 async iterator。类型限制不会把可信 Host callback 变成运行时沙箱。调用 `dispose()` 后，插件 fiber 进入 unloading 状态时会立即停止接纳新 operation，包括启动 ping 仍在等待时。清理过程会等待每个已接纳 callback，并且只在它们结算后调用 `client.close()`。启动 ping 抛出错误或返回 `false` 时，client 会在插件 activation 拒绝前关闭。

Client 向可信 Host Consumer 直接公开 Elasticsearch API。官方逐请求选项可以覆盖已配置的重试与请求超时默认值。该基础设施层不构造 query 或选择 index，因此每个 Consumer 仍负责这些请求级选择，并在执行前注入权威 tenant filter。

## 模型体验

### Elasticsearch 连接

#### 模型看到的内容

无。只有可信 Host 插件可以使用 `ctx.elasticsearch`；该包不注册工具、提示词、消息或会话事件。

#### Token 影响

每次请求都不会直接增加 token。

#### KV Cache 影响

与模型请求相互独立：Elasticsearch client 活动不会改变请求前缀。

## 已知限制与暂缓事项

- **仅提供连接 API**：尚未实现错误分类、健康状态报告、telemetry、具名 binding、cancellation policy 和 shutdown deadline。
- **仅支持系统信任**：custom CA file、managed-cloud discovery、node discovery、proxy 配置和 client-certificate authentication 仍暂缓实现；`caFingerprint` 是唯一额外 TLS trust input。
- **借用而非隔离**：官方 `meta: true` response 与 typed transport error 可能携带 connection metadata，可信代码也可以 cast 或保留运行时 client；Consumer 必须把这些值当作只读 diagnostic，绝不能用它们控制共享 transport。
- **静态 bootstrap authentication**：credential 在服务生命周期内固定；rotation 需要重新加载插件。
- **没有搜索领域**：index template、mapping、tenant query 构造、outbox delivery、bulk indexing、tombstone、projection lag 和 rebuild 工具属于后续 Consumer 包。
