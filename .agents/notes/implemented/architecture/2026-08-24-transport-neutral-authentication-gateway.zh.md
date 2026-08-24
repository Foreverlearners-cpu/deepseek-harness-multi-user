# Agent Note: 传输无关的认证 Gateway

Status: implemented

[English](2026-08-24-transport-neutral-authentication-gateway.md) | 中文

## Problem

认证 Provider 与账号编排有意不感知 HTTP 或 WebSocket 载体规则。如果适配器直接使用它们，就会重复实现凭证提取、冲突处理、CSRF 策略、错误脱敏与 Call 当前性检查，导致不同传输的安全行为逐渐分歧。

## Decision

`dsh-auth-gateway` 提供 Host-only 服务，接收结构化传输字段而不是框架 Request 对象。它保留重复 Header、Cookie、Query 与 Subprotocol 条目，直到拒绝歧义凭证，然后只把唯一且有长度限制的 Evidence 值和原始请求生命周期传给 `ctx.auth` 或 `ctx.accounts`。

HTTP 业务认证只接受唯一的 Authorization Bearer。密码只存在于有长度限制的登录与注册 Body 字段中。浏览器 Refresh 使用精确 `__Host-` Secure Cookie、无 Domain 与 `Path=/`，并要求配置中的 Origin 完全匹配，同时要求可读 CSRF Cookie 与 Header 相同。WebSocket 只在握手阶段认证；Authorization 是默认方式，Query 与 Subprotocol 载体分别要求显式选项，并返回强制适配器脱敏指令。URL 类载体中的 Refresh 与 Password 会被拒绝。

Gateway 返回固定错误码与建议 HTTP 状态，不携带 Cause。Refresh 信息只通过 HttpOnly Cookie 指令返回，`AuthenticatedCall` 保持在 Host 内。受保护 Handler 使用 `guard()`，它在身份使用前立即调用 `ctx.auth.assertCurrent()`。第二层检查覆盖 Host 来源、当前 Provider 注册、取消与过期，不会重复 JWT 签名验证。Access 与 Refresh JWT 分别由各自流程独立验签。

服务只委托 `ctx.accounts` 的公开方法。管理员账号方法保持在 Gateway 之外，并要求独立授权的管理适配器。

## Alternatives considered

**把插件直接绑定到现有 Web Server。** 这会使认证策略依赖单一 Router，并迫使 WebSocket 或 SDK 适配器导入该 Server 或重新实现策略。结构化适配器输入可以保留唯一的策略实现，同时不发明新的 Server 抽象。

**把传输载体放入 `dsh-auth`。** 认证服务面向所有 Host Channel，按 Evidence 类型选择 Provider 并签发当前 Call。HTTP Cookie、Origin、CSRF、Query String 与 WebSocket Subprotocol 属于 Consumer 策略，放入认证服务会使 Provider 契约传输特化。

**在响应 Body 中返回 Refresh Token。** 这会简化非浏览器客户端，但会把长期 Bearer 暴露给 JavaScript 与通用响应处理。浏览器 Refresh 保留在 HttpOnly Cookie 中；未来的非浏览器 Consumer 可以通过自己的可信 Channel 调用凭证生命周期。

**入口验证后在整个请求中信任 Call。** Provider 替换、取消或过期可能发生在 Middleware 与业务使用之间。第二次当前性检查成本很低，并能在权限使用点保留进程内来源保证。

## Consequences

HTTP 与 WebSocket 框架需要小型适配器，保留重复安全字段，并使用框架维护的 API 解析 Cookie。Gateway 可以独立测试，也不限制 Router 选择。

安全默认值会拒绝 Refresh，直到配置精确 Origin；WebSocket Query 或 Subprotocol Access Token 也会被拒绝，除非显式启用。部署必须配置 Origin、保留 `__Host-` Cookie 属性、正确序列化 Cookie 指令，并应用返回的 WebSocket 脱敏指令。

本包不提供速率限制、锁定、找回或长连接 WebSocket 断连策略。这些控制保持独立可组合，而不是成为凭证解析中的隐藏行为。
