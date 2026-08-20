# Agent Note: Unified authorization for plugins, disclosure, and execution

Status: implemented

[English](2026-08-19-unified-authorization-for-plugins-disclosure-and-execution.md) | 中文

## Problem

现有 Host/Origin 检查建立的是传输信任，权限 preset 和 approval service 约束的是执行。它们都不能为业务操作建立调用方身份，也没有为 Remote 方法和 plugin projection 提供统一的权限约定。隐藏菜单项不能保护直接 RPC；在过滤之前发送完整 projection，本身就已经造成披露。

首个落地切片需要建立这个边界，同时不提前引入角色管理 UI、数据库 schema 或所有领域的迁移。现有 local profile 也需要一种显式的本地组合方式，但不能把 sandbox 或 approval policy 当成账号授权。

## Decision

仓库现在提供分离的 authentication 和 authorization Service Definition。受保护的 Host 边界显式携带不可变的 `AuthenticatedCall`；authorization 再针对已注册的 `PermissionCode` 执行第二次判定。调用不会从 Session id 推导，不接受 RPC JSON 中的身份，也不会保存为可变的 current-user 状态。

### Authentication contract

`@deepseek-ai/dsh-authentication` 拥有签发边界。`AuthenticationProvider` 校验受信 carrier evidence，并签发冻结的 call，其中包含 request id、carrier channel、principal、认证方式、tenant/platform scope、取消信号和可选过期时间。进程私有 `WeakSet` 是 `isAuthenticatedCall` 的权威来源，因此结构复制或 JSON round trip 不能伪造 call。Provider 失败使用稳定的 `unauthenticated` 或 `authentication-unavailable` 公共类别。

已经交付的 `@deepseek-ai/dsh-authentication-local` Provider 要求显式配置 local principal、tenant 和 membership。它不是从 loopback 或 anonymous id 推断出的 fallback。Host Connection HTTP adapter 在仍持有原始 `Request` 时完成认证；身份单独传给 handler，永远不进入 RPC wire payload。缺少 authentication 时请求失败，Connection 不会悄悄把未认证请求变成可信 call。

### Authorization contract

`@deepseek-ai/dsh-authorization` 拥有判定生命周期和分布式 permission catalog。领域注册带 owner、description 和 disclosure class 的不可变定义。注册属于 effect 生命周期，拒绝重复的活跃 code，并改变不透明的 policy version。中心 package 只校验稳定的 `domain:action` 语法，不维护巨型领域 enum。

Authorization request 包含 `AuthenticatedCall`、带 brand 的 permission，以及可选的领域 resource/environment 数据。`decide()` 和 `require()` 会拒绝伪造 call、过期 call、未知 permission、Provider 异常以及判定期间观察到的策略变化。`require()` 抛出 `AuthorizationDeniedError`；decision event 只包含安全 reason 和可用的请求关联信息，不包含 credential 或 role 细节。策略或 catalog 变化会发出 `authorization/invalidated`，调用方可以用 `isCurrent()` 拒绝过期判定。

对于长时间运行的操作，`openLease(request, decision)` 会先执行同样的当前决策检查，再返回 `AuthorizationLease`。已认证调用被取消、凭证过期、任何策略或权限目录失效、以及 Authorization Provider 释放都会中止它的 signal。`release()` 会将租约移出 Provider 的观察范围，但不会中止已经完成的操作。租约是可撤销的生命周期，不是持久 capability，也不是策略状态副本。

静态 Provider package `@deepseek-ai/dsh-authorization-static` 只有两个显式模式：`deny-all` 和 `trusted-local`。后者只允许已认证的 `local` principal 执行已注册 action。它是 bootstrap/local 测试实现，不是 role 或 membership 存储。Authorization 与 sandbox、approval 和 permission preset 保持独立。

### Enforcement and generated contracts

每个 Typert `@Remote(options)` 和 `@RemoteScope(key, options)` marker 都要求 options 对象显式选择一种 access 分支：

```ts ignore-check
@Remote({ access: 'authenticated' })
@Remote({ exportName: 'list', permission: 'plugin:metadata-read' })
```

authenticated 分支必须声明 `access: 'authenticated'`，只接受有效的 Host-issued call，不携带 authorization metadata，也不会把 call 注入业务方法。permission 分支由 `permission` 选择；其 direct 或 scoped Host 方法必须把非可选的 `call: AuthenticatedCall` 声明为首参，wire arguments 和生成的 Client 签名都会省略它。裸 decorator 和字符串 alias 均不合法。

每次 Gateway 调用都会先验证 call 由当前 Authentication Provider 签发且未过期。对于 permission descriptor，授权会在具名 Remote 参数精确校验、业务 lookup provider 解析以及 RemoteScope Context identity、Context 或 scoped receiver 解析之前完成；方法即将调用前还会再次校验 decision。`access` 是必填的闭合判别字段。生成、Loader 和 registry 会拒绝缺失或未知的 access 以及所有不一致的 access/authorization 组合。strict descriptor 与 live marker 必须在 access、permission、endpoint alias 及 direct/scoped invocation 上一致，绝不回退到 authenticated 或 SRC 执行。

这建立了可复用的操作边界，但不声称一次 Gateway 检查替代 resource-owner 或 projection 检查。Client Context binder 不是授权，因为 raw RPC 可以直接提供 scoped identity；领域仍要使用注入的 call 执行 owner、tenant、resource 和 projection 检查。实现没有加入全局可变 principal 或隐式 authorization context。

### 已交付的垂直切片：plugin inventory

`@deepseek-ai/dsh-host-plugin-inventory` 拥有两个 permission definition：

| Permission | Disclosure | 返回 projection |
| --- | --- | --- |
| `plugin:discover` | discovery | 仅非 group Loader entry id |
| `plugin:metadata-read` | metadata | entry id、package/module name、enabled 状态和 Fiber phase |

Gateway descriptor 和领域方法都会调用 `ctx.authorization.require()`。方法每次请求直接读取当前 Loader 状态，不创建第二份生命周期 cache。即使 UI 隐藏了入口，未授权调用方也不能通过 direct Remote 获取这些 projection。

base bundle 显式挂载 local authentication 和 `trusted-local` authorization。现有 `permission-presets` row 仍负责 sandbox/approval 选择，不承担账号 grant。

### 本切片已交付的失败与披露语义

公共 RPC 映射区分 `unauthenticated` 和 `permission-denied`，但不返回内部策略 reason。Authorization failure 不披露 role graph、credential 内容或 Provider diagnostics。Legacy API route map 已为 Session、Tool、Settings、event、prompt、export 和 bundle surface 提供 operation-level permission gate；但还没有通用 redaction/resource-filtering engine，也不表示每个返回 projection 都已经按 tenant 或 resource 隔离。

### Legacy API 载体校验

由 `client/connection` 挂载时，legacy API Proxy 现在也使用同一套身份与权限 contract。它的 route map 是稳定且由类型锁定的 policy surface：

| 路由族 | Permission code |
| --- | --- |
| Session 列表／搜索／模型 | `api:session-list` |
| Session 历史／附件 | `api:session-history` |
| Session 创建／写入／取消 | `api:session-write` |
| Session prompt | `api:session-prompt` |
| Subagent 列表／历史／prompt／写入 | `api:subagent-list`、`api:subagent-history`、`api:subagent-prompt`、`api:subagent-write` |
| Host 读取／写入／原生操作 | `api:host-read`、`api:host-write`、`api:host-native` |
| Workspace 读取／写入 | `api:workspace-read`、`api:workspace-write` |
| Skill 与 agent-preset inventory／使用 | `api:skill-list`、`api:agent-preset-list`、`api:agent-preset-metadata-read`、`api:agent-preset-use`、`api:agent-preset-write`、`api:agent-preset-native` |
| Goal | `api:goal-write` |
| Settings 与 credentials | `api:settings-read`、`api:settings-write`、`api:settings-native`、`api:credentials-read`、`api:credentials-write` |
| LLM 目录／发现 | `api:llm-read`、`api:llm-discover` |
| 下行流、导出与响应 | `api:events-mux`、`api:events-host`、`api:session-export`、`api:respond` |

对网络请求，Connection adapter 在仍拥有原始 `Request` 时先认证，再进行 JSON、query 或领域解析。Unary POST、`POST /api/respond`、`GET|HEAD /api/session.export` 以及进程内 SSE 的 `GET /api/events.mux`／`GET /api/events.host` 都会校验对应 route。解析 body 前的拒绝使用保留的 `security-denied` rpcId，Client 只在 `unauthenticated` 与 `permission-denied` 时接受；`/api/respond` 的响应约定是 receipt 而非 RPC envelope，因此使用 HTTP 401/403。WebSocket upgrade 先通过 Host/Origin 信任栅栏，再在打开下行 source 前认证和授权对应流。因此拒绝请求不会得到 payload 或 session id oracle，意外的 Gateway/SSE/WebSocket 错误也只暴露 `handler failure`。`toFetchHandler(api)` 仍可在不传 security options 时用于纯进程内协议测试；生产 Connection mount 始终提供安全 adapter。

Adapter 会在消费路由前立即重新校验不透明 authorization decision。Gateway 保护的 Remote 也会在 receiver lookup 前以及业务调用前再次检查 freshness。这样可覆盖过期和 policy version 失效与 lookup/dispatch 之间的竞态。最终流检查之后，SSE 与 WebSocket 路径会在创建 source 前打开租约。SSE 合并 request 与租约 signal，在撤销时干净关闭而不发出虚假的 `handler failure`，并在 source 完成或消费方取消时释放。WebSocket 通过中止 source、并以 policy code 1008 和通用原因关闭已接受 socket 来消费同一租约 signal；由下行拥有的关闭路径和已处理的 negotiation failure 会释放租约，acceptor 则保持可用，供新的已认证连接接入。由此无需逐帧重新判定，即可覆盖流中途的调用取消、凭证过期、策略／目录失效和 Provider 释放。

在 JavaScript 内，租约取消必然是协作式的。Provider 可以中止 signal，carrier 也可以停止交付，但它无法抢占同步代码或忽略 `AbortSignal` 的异步领域操作。未来每个非 carrier 的长时间消费方都必须把 signal 传给实际工作，在 abort 后抑制 effect 或最终结果，并在清理阶段释放。

本地 bootstrap 组合受到明确限制。`authentication-local` 标记 `localOnly`；Connection 拒绝它与非空 `trustedHosts` 的组合；即使其他 Provider 信任网络 authority，Host 原生操作／配置／plugin 创作仍只允许 loopback。真实 Node 请求声明回环 Host 时，其 TCP 对端也必须是回环地址（`127/8`、`::1` 或 IPv4-mapped loopback），从而关闭全接口监听上的客户端可控 `Host: localhost` 伪造。远程或多主体部署必须挂载支持网络的 Authentication Provider 并配置显式 grant；Host/Origin 信任绝不能替代身份。

## Package topology

| Package | 已交付职责 |
| --- | --- |
| `identity/authentication` | 带 brand 的 principal/scope id、verified call contract、issuer check、Provider base 和公共 authentication error |
| `identity/authentication-local` | 显式的 local synthetic identity Provider |
| `identity/authorization` | Permission catalog、decision/require API、可撤销 authorization lease、default-deny 归一化、policy version、invalidation 与 denial record |
| `identity/authorization-static` | 显式 `deny-all` 和 `trusted-local` Provider |
| `client/connection` | 认证 Host HTTP 与 WebSocket request，执行 legacy route permission，打开并消费流租约，并把 call 脱离 wire 传给 handler |
| `api/gateway` | 执行 Remote descriptor、注入 Host-only call、映射 authorization failure |
| `typert/protocol`、`generator`、`loader`、`registry` | 要求并校验 Remote access 判别字段；从 Client wire contract 隐藏 permission 方法的 call 参数 |
| `host/plugin-inventory` | 拥有 plugin discovery/metadata permission 和过滤后的 Loader projection |
| `bundle/base` | 显式挂载 local authentication 与 authorization Provider |

## Alternatives considered

**把前端隐藏作为安全边界。** 拒绝，因为 direct endpoint 或猜测出的 Remote 可以绕过它；未过滤响应一到 Client 就已经披露。UI 状态只能是 presentation hint。

**把 permission preset、sandbox policy 或 approval 当成账号授权。** 拒绝，因为这些机制约束执行或记录当前人工同意；它们不能认证 principal，也不能授予产品 action。

**从 loopback、anonymous id、Session id 或 RPC payload 推导身份。** 拒绝，因为业务输入不能建立自己的 actor 或 tenant。Carrier-owned evidence 必须由 Authentication Provider 校验。

**把 current principal 放进可变 Context 或 ambient async state。** 拒绝，因为脱离调用的工作和并发请求可能观察到错误调用方。受保护方法显式接收 call。

**先做 MySQL role 和管理 UI。** 本切片拒绝，因为在执行点被证明之前持久化会提前固定策略和披露语义。后续 Provider 可以实现同一 contract。

**只在 transport 或 Gateway 授权。** 作为完整模型拒绝，因为 resource lookup、filtering、serialization、event 和其他领域所有者仍需要自己的 scope 与 disclosure 检查。当前 Gateway 检查是第一层 enforcement，不是所有领域都已受保护的声明。

## Consequences

permission 方法的显式 call 参数和闭合的 Remote access descriptor 使身份在 package 边界可见，并阻止 Client wire contract 携带可伪造身份。私有 issuer check、default-deny 归一化、policy-version invalidation、可撤销的操作生命周期和 typed public error 为后续 Provider 提供稳定基础。权限由拥有返回数据的领域负责，plugin inventory 证明了这一点，而不是由中心 package 维护任意 endpoint 名称列表。

代价是 Connection、Gateway 和生成的 Typert artifact 之间出现兼容性维护面。每个 Remote 都要求显式 access 声明和有效身份；受 permission 保护的方法还必须声明并执行权限，测试必须覆盖有效签发 call 与 forged 或 denied call。静态 local Provider 不提供用户模型、资源共享或持久化。authenticated Remote 和资源所有领域在仅身份校验不足时仍需迁移动作权限；仅添加 permission marker 也不会自动提供 tenant 或 resource filtering。

## Testing and verification

已实现测试覆盖 authentication 签发、冻结、结构伪造、JSON round trip、过期值、local 配置校验、permission code/catalog 校验、default denial、未知 permission、Provider failure、stale decision、policy invalidation、静态 Provider 模式和 Service Definition 生命周期 invariant。租约测试覆盖策略／目录失效、凭证过期、调用取消、release 与 Authorization Provider 释放。API Proxy 与 Connection carrier 测试覆盖 SSE 撤销清理、过期 lease-open 拒绝、WebSocket policy close、source 取消、单次 release、accept 竞态和 acceptor 持续可用。Gateway 与 Connection 测试还覆盖认证顺序、伪造 call、显式 Remote access、不一致 descriptor、受保护 Remote 及公共 RPC error mapping。Plugin inventory 测试覆盖 discovery/metadata 分离 projection 及领域直接拒绝。

后续范围明确包括：OIDC/token adapter、role/grant 持久化、tenant/resource ABAC 与通用 resource filtering、audit storage、动态执行的 capability token、Client authorization snapshot、其他长时间领域操作采用租约、authenticated Remote 的动作权限迁移，以及其他披露所有者的迁移。Node bridge 还会在 Fetch 层凭证认证前最多缓冲 `maxRequestBodyBytes`，因此凭证级资源 DoS 防护仍需要流式 Request 或 bridge 认证预检。plugin inventory 目前只有窄范围的过滤 projection，仓库还没有全局 redaction/resource-filtering engine。这些工作必须复用本 note 的 contract，不能悄悄扩大 `trusted-local` 或 permission preset 的含义。
