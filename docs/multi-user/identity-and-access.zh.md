# 多用户身份与访问控制

[English](identity-and-access.md) | 中文

本文定义提案中的 identity、认证、授权和管理模型。它基于[多用户总览](README.md)中的部署架构，不描述已经交付的 API。

## Identity 模型

控制平面拥有四种带品牌类型的内部 identity：

- `UserId` 标识一个人类账号；邮箱地址、显示名称或上游 identity 发生变化时，该 id 不变。
- `TenantId` 标识一个管理和数据隔离单元。新用户获得个人租户；组织使用额外租户，而不是改变用户 identity。
- `MembershipId` 把一个 principal 与一个租户连接起来，并带有生命周期状态和授权分配。人类成员关系携带角色；service-account 成员关系携带有界动作授权，并且不能持有租户 owner 权限。成员关系被禁用或删除后，即使 principal 仍有效，后续授权也会失效。
- `ServiceAccountId` 标识非人类自动化主体。它的凭据、授权、有效期和撤销状态独立于人类登录 session，并且只能通过有效成员关系访问租户资源。

已认证 principal 是一个用户或 service account 加认证事实。只有控制平面解析出有效成员关系后，一次调用才成为租户级调用。选中的 `TenantId` 是可信上下文，不是普通端点输入。

外部 OIDC 的 `issuer + subject` 组合映射到 `UserId`。邮箱属于个人资料，可以辅助邀请流程，但既不是唯一 identity，也不是授权证据。控制平面不会在认证记录中存储模型提供方 credential。

## 认证

浏览器部署应使用 Authorization Code with PKCE，把登录委托给 OpenID Connect 提供方。Host 接收短期、Secure、HttpOnly、SameSite cookie；浏览器 JavaScript 永远不会收到 refresh credential。除了现有 Host 与 Origin 检查，使用 cookie 认证的状态变更调用还需要 CSRF 防护。生产远程访问必须在反向代理或应用边缘终止 TLS。

SDK 和自动化客户端使用短期 OAuth access token 或限定范围的 service-account token。如果支持长期 personal token，则只展示一次，只存储强单向校验值，并且带显式租户/动作 scope、有效期和独立撤销能力。通过远程传输提供服务的 ACP 或 JSON-RPC 遵守相同 principal 约定；仅使用 stdio 的本地自动化可以使用显式 local principal。

本地 `web` 和 `headless` profile 构造绑定到一个个人租户的 `LocalPrincipal`。这只是一种仅供本地 profile 使用的组合选择。服务端 profile 在没有挂载认证提供方时启动失败，并且永远不会把 loopback、`trustedHosts`、OS 用户名或 Harness-home 匿名 id 转换成远程 principal。

认证会校验 issuer、audience、签名、有效期、not-before 时间、token 类型，以及提供方特有的 nonce/state 要求。密钥轮换或身份提供方故障时，新调用按拒绝处理。撤销语义和最大 session 时长属于部署可调参数，不是插件中的硬编码常量。

## 已认证调用上下文

每种传输都必须在 API Proxy 或 Typert 方法解析之前，把已校验凭据和已解析授权 scope 适配成一个显式且不可变的调用上下文：

```text
AuthenticatedCall = {
  requestId,
  principal,
  authenticationMethod,
  signal,
  scope:
    | { kind: "tenant", tenantId, membershipId }
    | { kind: "platform", operatorGrantId }
}
```

执行受保护操作的 handler 和服务 API 显式接收该上下文。租户产品 API 只接受 tenant variant；platform variant 只由控制平面管理 API 接受，并且不能作为租户权限向下转发。端点 payload 包含资源 id 和业务输入，而不包含具有权威性的 `userId` 或 `tenantId`。这个显式参数让授权在包边界可见，并避免依赖可变进程全局值或隐式异步局部值。

HTTP 为每个请求创建一个上下文。WebSocket 在升级前完成认证；连接在自身生命周期内固定 principal 和当前租户，成员关系撤销后，事件流必须在有界时间内关闭或重新授权。重连需要重新认证。进程内传输也使用同一上下文类型，不能因为没有跨越网络就绕过策略。

控制平面与租户运行时之间的内部调用使用双向认证通道，或者使用不允许不可信插件输入构造的同进程能力。签名转发断言具有短有效期，audience 只允许一个运行时，并包含 request id、principal id、tenant id 和已授权动作；运行时仍然校验资源所有权。

## 授权

授权由两个所有者协作完成：

- 策略服务根据成员关系、角色、资源分类和部署策略，决定已认证 actor 能否执行某个动作。
- 资源服务只在已认证租户内加载或修改数据，并校验资源特有的所有权。它不把上游传来的布尔值当作证明，也不向远程调用方提供无 scope 的回退方法。

首个版本为人类使用精简角色基线：租户 `owner`、租户 `admin` 和租户 `member`，以及独立的平台 `operator` 角色。Service account 直接获得有界动作授权，不能成为租户 owner 或平台 operator。平台 operator 管理部署健康、停用、配额和路由；它们不会自动获得租户 transcript 或 secret 访问权。租户 owner 管理成员关系和租户策略。租户 admin 管理策略允许的租户资源。Member 管理自己的 session，并使用已授权的租户 workspace。

动作是领域特有且稳定的，例如 `session:create`、`session:read`、`session:steer`、`session:approve`、`session:export`、`workspace:manage`、`settings:user-write`、`settings:tenant-write`、`credential:use`、`credential:manage` 和 `membership:manage`。角色映射到动作；端点名称不能直接充当授权模型。

资源所有者必须先按 scope 查找，再让数据离开自身。Session 持久化按 `(tenantId, sessionId)` 查询，workspace 按 `(tenantId, workspaceId)` 查询，attachment 解析需要一个已授权 session 引用。调用方提交另一个租户的有效 id 时，对外收到的 not-found 响应与不存在的 id 相同。审计记录可以保留被拒目标的 hash 和拒绝原因，但不能向调用方披露。

List、search、count、export、fork、resume 和事件订阅同样属于授权操作。如果服务只过滤 `get()`，却保留无 scope 的 `list()` 或全 session 事件流，系统仍然不安全。冷 session 恢复要在 preparation 前重复授权；如果读取期间成员关系可能变化，则在发布前再次授权。

## Session 所有权与批准

Session 具有不可变的 `tenantId` 和 `ownerPrincipal` 元数据。`ownerPrincipal` 是可判别的 `SessionOwner`：它是 `UserId` 或 `ServiceAccountId`，而不是无类型 id。已认证创建者不能直接提交这两个值；session factory 从租户调用上下文写入它们。Fork 留在同一租户内并保留所有者，除非以后引入显式共享或转移操作。跨租户复制属于 export/import 工作流，它创建新 id、校验 attachment，并写入独立审计轨迹。

首个版本中只有 session owner 可以 steering 或取消。人类所有的 session 只允许该用户回答问题或交互式批准工具调用。Service account 所有的 session 使用预授权策略，不能冒充人类 approver；后续委托设计必须指定显式人类 approver。租户管理权限不会静默授予批准权，因为一次批准可能扩大文件系统或进程访问权限。未来的协作 session 设计必须分别定义 editor 和 approver 授权，给每条持久化人类输入标注 actor，并先解决并发轮次所有权，再启用共享修改。

Session 读取默认私有。租户 owner 和平台 operator 可以通过显式管理动作执行保留策略、暂停执行或删除，而不接收 transcript 正文。如果产品需要紧急内容访问，则必须具备独立授权、原因、短有效期、显著审计事件和用户可见策略；它不由 `admin` 标签隐含授予。

## 管理

控制平面管理 API 拥有用户状态、租户生命周期、成员邀请、角色变更、service account、token 撤销、配额、保留策略和运行时分配。这些方法与租户产品 API 分离，并且每次调用都重新授权。管理页面使用专用投影，永远不复用无限制的 `settings.describe`、`credentials.describe` 或全局 session 列表。

Bootstrap 通过带外部署动作创建第一个平台 operator。普通产品流量不能把用户提升为平台 operator。首个版本不提供 impersonation；若以后加入，则必须具有独立的 impersonated-principal 字段、不可变的原 actor、有界有效期、可见指示、受限动作和完整审计。

每项特权修改都使用乐观并发控制或事务前置条件，避免两个管理员从陈旧页面互相覆盖成员关系、角色、配额或策略。停用会立即撤销新调用，阻止新的运行时工作，并根据有界取消或转移策略处理已经运行的 session。

## 审计要求

认证和授权为登录成功/失败、token 创建/撤销、租户选择、成员关系和角色变更、受保护动作拒绝、credential 管理、session export/delete、批准决定、策略变更和 operator 操作生成安全审计记录。[数据与运行时隔离参考](data-and-runtime-isolation.md)定义审计记录和保留规则。

返回给用户的诊断应指出失败动作和安全修复方式，同时不披露其他租户的资源、角色图、credential 状态或内部策略。运行日志使用 request id 和内部不透明 id 关联；认证 token、cookie 值、credential 值、消息正文和工具输出必须排除。
