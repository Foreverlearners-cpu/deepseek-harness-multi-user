# @deepseek-ai/dsh-authorization

[English](README.md) | 中文

默认拒绝的操作授权 Service Definition 与实时权限目录。该服务只接受私有签发的 [`AuthenticatedCall`](../authentication/README.md)，解析已注册的产品操作，把策略评估委托给具体的 `AuthorizationProvider`，并将结果规范化为不可变决策。它是插件发现、元数据披露、内容投影和执行等操作的执行契约。

## API

- `permissionCode(value)` 校验并 branding 一个 `domain:action` 代码；`PermissionDefinition` 另外声明 owner、管理描述、披露级别和可选的资源类型。
- `AuthorizationProvider.permissions` 提供面向领域定义的 `register()`、`get()` 和 `list()`。注册关系绑定到当前 Cordis fiber，并返回 disposer。
- `decide({ call, permission, resource, environment })` 返回不可变的 allow 或 deny 决策；`require()` 返回 allow 决策，否则抛出 `AuthorizationDeniedError`。
- `policyVersion` 与 `isCurrent()` 提供不透明的策略新鲜度信息；Provider 实现可以通过受保护的策略生命周期使进行中的或此前观察到的策略失效。
- `openLease(request, decision)` 将一个当前有效的 allow 转换成长时间操作使用的 `AuthorizationLease`。调用取消、凭证过期、策略或权限目录变化、以及 Provider 释放都会撤销它的 `signal`；操作结束时消费方必须调用 `release()`。
- `authorization/decision` 与 `authorization/invalidated` 事件携带安全的审计元数据和版本变化，不包含资源内容或角色策略内部信息。

## 授权契约

身份认证与授权刻意分开。调用证明 Host 已建立 principal 与 scope；授权 Provider 决定该 principal 是否可以执行一个已注册操作。领域包拥有自己的权限定义，Provider 拥有评估这些定义的策略。权限代码不是角色、UI 标志或凭证。

基础服务会在咨询 Provider 前拒绝结构伪造的调用和已过期凭证。它默认拒绝未知权限，将 Provider 失败收敛为拒绝，冻结有界 obligations，并在评估过程中策略或权限定义发生变化时拒绝结果。成功决策携带所使用的策略版本，因此调用方可以在自己的边界要求新鲜度。

`assertCurrent(request, decision)` 是异步 handler 的消费边界。当 allow 跨过 `await` 后仍要使用时，调用方应在 lookup、创建 source 和执行业务前立即调用它；如果调用已过期、签发者已被释放或不属于当前 Provider、权限已注销或替换，或者策略版本已失效，它都会拒绝。Connection 将这一模式应用于 unary fallback 路由、`/api/respond` 和 session 导出，并在为 SSE 与 WebSocket 事件流打开租约前执行同样的最终检查。

`AuthorizationLease` 将这次检查延伸到整个操作生命周期，而不会把 allow 决策当作持久 capability。`openLease()` 会在决策已经过期时直接失败，随后通过一个 `AbortSignal` 追踪调用取消、凭证过期、策略／目录失效和 Provider 释放。`release()` 会解除这些观察，但不会中止一个已经完成的操作。对于进程内工作，撤销是协作式的：Provider 可以中止 signal，却无法抢占同步 JavaScript，也无法停止忽略该 signal 的异步实现。长时间运行的消费方必须把 signal 传入实际工作，在 abort 后停止产生 effect 或返回结果，并在清理阶段释放租约。

路由权限刻意保持粗粒度。它回答调用方是否可以进入某个操作，不负责选择行或脱敏字段。即使路由门禁成功，领域 handler 仍必须执行资源级检查和投影。

## 失败语义

- 无效的权限代码或定义会抛出 `TypeError`；活动 owner 重复时会拒绝注册，且不替换已有定义。
- 缺少签发者证据或已认证调用过期时产生 `UNAUTHENTICATED`；不会咨询 Provider。
- 未注册权限、Provider 拒绝、Provider 失败、不支持的 principal 或过期策略会产生 `FORBIDDEN`，并携带类型化的内部拒绝原因。
- `AuthorizationDeniedError` 暴露权限、安全原因、策略版本、可选请求 id 和 carrier 可安全返回的公共错误，但不会暴露资源或角色详情。

## 组合

本包是抽象 Service Definition。具体 Provider 必须显式挂载；领域包必须在自己的组合 fiber 中注册权限。Gateway 与领域方法都应执行相关权限；隐藏菜单或省略投影不是安全边界。与仓库不变式服务组合时，`./invariant` 入口会检查本包拥有的失效关系。

## 模型体验

无，因为权限代码、principal、resource、environment 字段和决策始终留在 Host 授权路径中，不注册任何模型上下文。

#### KV Cache 影响

无；授权决策不会组装或使模型请求前缀失效。

## 已知限制与暂缓工作

- **没有策略数据库或角色引擎** —— 抽象 Provider 不实现 OIDC claims、角色 membership、tenant grant、operator grant 或远程策略后端。
- **每个 context 使用内存目录** —— 权限定义与策略版本存在于活动 Host context 中，并随其所属 fiber 移除。
- **不会自动过滤资源** —— 领域必须为内容级披露定义资源类型、obligation、投影和决策后的过滤。
- **路由门禁不替代资源策略** —— 稳定的 `api:*` 或 Remote 权限只允许进入操作，不代表可以不受限制地访问该操作返回的所有资源。
- **没有 carrier 适配器** —— 将 `UNAUTHENTICATED` 与 `FORBIDDEN` 映射为 HTTP 或 RPC 响应属于 Gateway 或传输边界。
- **租约撤销是协作式的** —— `AuthorizationLease.signal` 无法强行停止同步代码或忽略 `AbortSignal` 的 API；每个长时间操作的 owner 都必须消费该 signal，并定义如何丢弃已中止的结果。
