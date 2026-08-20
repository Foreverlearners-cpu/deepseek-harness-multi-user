# identity/ — 身份与授权基础设施

[English](README.md) | 中文

跨产品领域共享的身份与授权契约。身份认证与授权是两个独立的服务：经过验证的调用建立请求由谁发起，而 Provider 决定该调用可以执行什么操作。

| 包 | 职责 | ctx key |
|---|---|---|
| [`authentication/`](authentication/README.md) | 签发由 Host 验证且不可变的 `AuthenticatedCall` 值 | `ctx.authentication` |
| [`authentication-local/`](authentication-local/README.md) | 显式的本地 profile 身份认证 Provider | `ctx.authentication` |
| [`authorization/`](authorization/README.md) | 默认拒绝的操作授权与实时权限目录 | `ctx.authorization` |
| [`authorization-static/`](authorization-static/README.md) | 显式的 `deny-all` 或 `trusted-local` 引导策略 | `ctx.authorization` |
| [`anonymous-user-id/`](anonymous-user-id/README.md) | 为遥测、反馈和 DeepSeek 请求持久化一个限定于 Harness home 的匿名关联 id | — |

身份认证与授权包构成受保护 Remote 方法、插件发现、可见内容、legacy API 路由以及未来资源投影的执行基础。Connection 的 legacy 路由适配器为 unary 方法、`/api/respond`、session 导出和两条事件流分配稳定的 `api:*` 权限；它会在解析 payload 或打开 source 前完成认证，在消费 allow 前检查新鲜度，并认证 WebSocket upgrade。UI 可见性只是便利层；Host Gateway 与领域方法才是安全边界。

路由授权只是操作门禁，不是资源过滤。路由决策成功并不意味着可以访问所有 session、插件、workspace 或内容行。领域代码仍必须在返回数据前执行 tenant、membership、所有权、资源级 obligation 以及输出投影检查。
