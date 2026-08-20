# @deepseek-ai/dsh-authorization-static

[English](README.md) | 中文

用于引导流程和本地 profile 的显式内存授权 Provider。`StaticAuthorizationProvider` 按共享的 [`authorization`](../authorization/README.md) 契约实现恰好两种组合模式：`deny-all` 拒绝所有已注册操作，`trusted-local` 只允许已认证的 `local` principal 执行已注册操作。

## API

- `Config` 要求显式提供 `deny-all` 或 `trusted-local` 的 `mode`；没有宽松的默认值。
- `StaticAuthorizationProvider` 是默认导出，并继承 `AuthorizationProvider` 的共享权限目录、调用真实性检查、策略版本和拒绝事件。
- `deny-all` 下每个已注册权限都会以 `provider-denied` 被拒绝；`trusted-local` 下非本地 principal 会以 `principal-unsupported` 被拒绝。
- `./invariant` 入口提供包级伴生注册，供组合仓库不变式服务的 context 使用。

## 授权契约

该模式是用于本地引导边界的刻意小型策略。它不会替代身份认证：调用方仍需要私有签发的 `AuthenticatedCall`，领域仍需要注册要保护的权限。共享基础服务继续拒绝伪造调用、已过期调用、未知权限、Provider 失败和过期策略决策。

`trusted-local` 匹配的是 principal kind，而不是 hostname、loopback 地址、匿名 id 或客户端提供的 label。因此它保持显式且可测试，而挂载它的组合负责决定本地 principal 是否是可接受的信任根。

## 失败语义

- 不支持或缺失的 mode 会在配置校验和 Provider 激活时以 `TypeError` 失败。
- `deny-all` 对每个已注册操作都返回 `FORBIDDEN`，包括本地 principal 请求的操作。
- `trusted-local` 只允许 principal kind 为 `local` 且有效、未过期的调用；其他 principal kind 返回 `principal-unsupported` 与 `FORBIDDEN`。
- 共享授权失败保持正常的 `UNAUTHENTICATED` 或 `FORBIDDEN` 类别和类型化拒绝原因。

## 组合

只在显式引导策略足够的场景挂载此 Provider，例如本地桌面 profile、隔离测试或刻意的 deny-all 部署。受信任本地 profile 通常会与 [`authentication-local`](../authentication-local/README.md) 组合，但两项服务仍相互独立。本包不提供角色编辑器、授权存储或运行时策略管理界面。

## 模型体验

无，因为静态 Provider 只评估 Host 授权请求，不注册任何模型上下文。

#### KV Cache 影响

无；更改静态模式不会组装模型请求前缀。

## 已知限制与暂缓工作

- **没有动态授权** —— Provider 无法表达用户、服务账号、tenant membership、operator grant 或资源级条件。
- **不是远程部署策略** —— `trusted-local` 不能替代 OIDC、API key、session 或服务间身份认证。
- **模式在组合时确定** —— 修改 mode 需要替换或重新加载 Provider；现有决策不是管理策略存储。
- **仍需注册操作** —— Provider 不会创建权限定义；未知操作仍由共享基础服务拒绝。
