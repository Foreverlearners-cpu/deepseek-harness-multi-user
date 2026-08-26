# @deepseek-ai/dsh-authority

[English](README.md) | 中文

Host 授权决策运行时。该服务登记 Action，接受来自 `dsh-auth` 的可信身份，通过领域 resolver 解析资源的租户和团队，向角色路线和对象路线询问该团队上的 Use 或 Delegate 集合，然后取交集。它不保存角色、授权或成员关系，也不读取 MySQL。

该包是 Service Definition 和决策引擎。部署时在 `ctx.auth` 之后把它挂载为 `ctx.authority`。后续的 `dsh-auth-rbac` 和 `dsh-authority-acl` 注册两条路线。

## 公共 API

| API | 用途 |
|---|---|
| `ctx.authority.registerAction(definition)` | 登记一个 Action 及其可作用的资源类；返回卸载函数 |
| `ctx.authority.registerRoute(route, provider)` | 注册唯一的 `role` 或 `object` Provider；返回卸载函数 |
| `ctx.authority.registerResolver(type, resolver)` | 为一种资源类注册唯一 resolver；返回卸载函数 |
| `ctx.authority.decide(request)` | 返回允许或拒绝分类，不对策略失败抛错 |
| `ctx.authority.require(request)` | 允许时返回可信资源，否则抛出对应拒绝分类 |

`AuthorityRequest` 包含当前的 `AuthenticatedCall`、已登记 Action，以及不可信的 `{ type, id }` 资源指针。客户端不能提供决策所用的租户或团队。可选 `purpose` 为 `use` 或 `delegate`，默认 `use`。

## 同一团队交差

resolver 返回可信资源后，两条路线的 Provider 都收到该资源的 `tenantId` 和 `teamId` 作为 `T`。每个 Provider 返回该团队上的 Use 或 Delegate Action 集合。只有请求的 Action 同时落在两个集合中，运行时才允许该请求：

```text
Effective(T) = RoleSet(user, T) ∩ ObjectSet(resource, T)
```

运行时不会先合并不同团队的集合再取交。研发组角色不能和运营组对象授权组合。这条合并规则是安全不变量，不是 `Config` 字段。

Use 与 Delegate 是两套集合。Use 决策只向两个 Provider 询问 `set: 'use'`。Delegate 集合不会进入 Use 判断。

## 默认拒绝

在以下情况运行时拒绝：调用不是当前的、主体不是用户、Action 未知或作用在错误的资源类、资源无法解析、任一路线 Provider 或 resolver 缺失、任一集合不含该 Action，或者 Provider 返回无效数据或抛错。卸载路线 Provider 后，该路线回到故障关闭。

`decide()` 把这些情况映射为拒绝分类。它只对 `invalid-input` 抛错。`require()` 抛出带拒绝分类的 `AuthorityError`。

## 实现路线 Provider

路线 Provider 实现 `evaluate(query)`，并为给定的用户、租户、团队、Action、可信资源和 `set` 返回 `{ actions }`。它不决定 ALLOW 或 DENY，也不得在一次结果里混合多个团队。通过 `ctx.effect()` 注册 Provider，让卸载函数跟随插件 fiber。

资源 resolver 实现 `resolve(ref)`，并返回 `type`、`id`、`tenantId`、`teamId` 和 `revision`；指针未知时返回 `undefined`。返回的 type 和 id 必须与请求指针一致。

`tests/contract.ts` 中的共享套件是规范决策契约。该套件中的夹具 Provider 仅用于测试。

## 管理员操作

调用方先认证。典型 Use 检查按以下顺序进行：

```text
transport credential
  -> dsh-auth mints AuthenticatedCall
  -> domain resolver records tenant and team
  -> ctx.authority.require({ call, action, resource })
  -> later RBAC and ACL Providers supply the two per-team sets
```

后续存储包上的 operation context 不是授权证明。

## 失败语义

| Code | 含义 |
|---|---|
| `invalid-input` | purpose、路线、资源指针或注册值格式无效 |
| `conflict` | Action、路线或 resolver 已经注册 |
| `unauthenticated` | 该调用不是由当前 `ctx.auth` 运行时签发的 |
| `unknown-action` | Action 未登记，或不作用于该资源类 |
| `unresolved-resource` | resolver 存在但没有返回可信资源 |
| `missing-provider` | resolver 或任一路线 Provider 未注册 |
| `insufficient-permission` | 同一团队交集不含该 Action，或主体不是用户 |
| `provider-unavailable` | resolver 或路线 Provider 抛错或返回无效结果 |

传输适配器决定哪些内部分类应折叠成同一种公开响应。

## 模型体验

### 授权决策

#### 模型看到什么

什么也看不到。`ctx.authority.decide` 的结果、Action 目录和可信资源事实只存在于 Host；该包不注册可能向模型暴露这些数据的 prompt section、工具或 Session event。

#### Token 影响

为零。授权决策不会增加、删除或改写模型输入 Token。

#### KV Cache 影响

相互独立。授权决策不会改变模型可见的请求前缀，因此不会使原本可复用的 Provider cache entry 失效。

## 已知限制与延期工作

- **没有角色或授权存储** - `dsh-auth-rbac` 和 `dsh-authority-acl` 拥有这些记录以及它们报告的按团队集合。
- **没有租户目录或团队目录查询** - 该服务接受 resolver 给出的品牌化 id，不调用 `ctx.tenants` 或 `ctx.teams`。
- **没有跨租户规则** - 后续的 `dsh-tenant-authority` Consumer 可以在操作者与资源租户不同时拒绝。
- **没有授权主体遍历** - 决策把已解析资源的团队当作 `T`；遍历其他获得授权的团队推迟到 ACL 需要时再做。
- **没有持久化审计投递** - 决策是进程内返回值；持久化审计流需要后续 outbox。
