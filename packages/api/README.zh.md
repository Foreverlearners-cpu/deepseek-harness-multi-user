# api/：Remote API 层

[English](README.md) | 中文

面向应用的 Remote 技术栈。`remotes` 负责 BFF 策略和选定的业务 API，`gateway` 则实现 Host 与 Client 环境共用的 Typert 一元 RPC endpoint。

| 包 | 职责 | ctx key |
|---|---|---|
| [`remotes/`](remotes/README.md) | Host Agent/Session lookup 策略与 Client Remote contribution 装配 | 无服务；配置 `ctx.typert` 并消费 `ctx.remote` |
| [`gateway/`](gateway/README.md) | Host Typert 分发器与 Client Remote endpoint | `ctx.typertGateway` / `ctx.remote` |

运行时依赖方向为 `remotes → gateway → connection → webserver`：BFF 消费共享的 `TypertClientRemote` 约定，Gateway 把传输交给 Connection，Connection 再挂载到 HTTP server。Cordis 服务注入与 Client 模块元数据在不让 Remotes Client 入口导入具体 Gateway 实现的前提下维持该顺序。

两条路径共享同一道 Host 安全边界。Connection 在分发前认证原始 request；受保护 Remote descriptor 使用 Gateway 权限，legacy API Proxy fallback 则使用自身的路径权限目录，其中包括 `respond`、session export 和事件下行。浏览器信任／回环栅栏是独立的可达性检查，不是身份 grant。资源可见性和 projection 过滤仍由领域负责；路径栅栏不声称提供通用内容授权。

## 已知限制与延期工作

- Connection 与 WebServer 仍位于 [`client/connection`](../client/connection/README.md) 和 [`host/webserver`](../host/webserver/README.md)；后续可以只移动包，将它们放到 `api/connection` 和 `api/webserver` 下，而无需改变服务约定。
- 旧 API Proxy 仍位于 [`host/apiproxy`](../host/apiproxy/README.md)，作为尚未迁移到 Remote 的方法的回退路径。生产载体会在解析 payload 或执行业务前应用认证和稳定的 `api:*` 路径权限，包括 `/api/respond`、`/api/session.export`、`/api/events.mux` 与 `/api/events.host`。它使用由 `api-remotes` 持有的 Host resolver，使已迁移与旧方法共用同一套 Agent/Session 身份策略。
