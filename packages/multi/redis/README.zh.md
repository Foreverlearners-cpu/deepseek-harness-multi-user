# @deepseek-ai/dsh-redis

[English](README.md) | 中文

供多用户领域插件使用的仅限 Host 的 Redis 连接服务。该包公开 `ctx.redis.withClient(callback)`，拥有一个独立部署模式的 `@redis/client` 连接，在启动期间校验 `connect()` 与 `PING`，客户端未 ready 时拒绝回调，并在关闭前等待已接纳回调完成。Cache、rate limit、lease、idempotency、invalidation 和 Pub/Sub 行为保留在遵守 [dsh-redis 基础设施规则](../../../docs/infrastructure/dsh-redis.md)的独立领域消费方中。

## 配置

| 配置键 | 必需 | 含义 |
|---|---|---|
| `url` | 是 | 独立部署模式的 `redis:` 或 `rediss:` URL；配置 schema 把完整值标记为 secret |
| `connectTimeoutMs` | 否 | 初始连接与 `PING` 的总超时时间，也用于该次 socket 连接尝试；默认为 `10000`，且不得超过 `2147483647` |

Scheme 无效、缺少 host、timeout 无效、连接超时、认证失败或 `PING` 失败时，服务会拒绝插件启动。包自身编写的诊断永远不插入 URL 或 credential；底层 Node Redis 错误会原样传播，并可能标识 network endpoint。在每个不可用期间，该包最多记录一条通用 warning；收到 `ready` 事件后，下一次不可用期间可以再次记录。

## 客户端生命周期

`withClient(callback)` 把一条共享的多路复用客户端传给回调，并不租用独占连接。回调必须等待自身启动的每个命令结算，并且不能保留、关闭或复制客户端，不能发起 subscription，也不能以其他方式改变客户端连接状态。阻塞命令、Pub/Sub 和 `WATCH` 范围内的 transaction 需要独立拥有的客户端，不能通过该方法使用。

系统禁用离线命令队列与自动重连。客户端未 ready 时发起的调用会失败而不是等待；发生意外断线后，服务会保持不可用，直到重新挂载插件。资源释放会停止接纳，等待每个已接纳回调，在连接错误处理仍生效时调用 `client.close()`，然后移除包拥有的 `error` 与 `ready` listener。启动超时使用 `client.destroy()`，因此连接工作不能在启动失败后继续存活。

## 模型体验

### Redis 连接

#### 模型看到的内容

无。只有可信 Host 插件可以使用 `ctx.redis`；该包不注册工具、提示词、消息或会话事件。

#### Token 影响

每次请求都不会直接增加 token。

#### KV Cache 影响

与模型请求相互独立：Redis 连接活动不会改变请求前缀。

## 已知限制与暂缓事项

- **一条独立部署命令客户端**：具名 binding、pool、replica、Sentinel、Cluster、阻塞命令、Pub/Sub 和专用 transaction client 均暂缓实现。
- **无自动重连**：意外断线后需要重新挂载插件；未来的重连策略必须拥有可取消的 retry 状态，并在资源释放期间等待其结束。
- **仅提供连接 API**：尚未实现领域 cache operation、limiter、lease、outbox 消费、health reporting、metric 和 Redis error classification。
- **回调等待没有时限**：资源释放会无限等待已接纳回调；消费方必须等待自身启动的每个命令与回调结算。
