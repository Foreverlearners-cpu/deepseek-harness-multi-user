# @deepseek-ai/dsh-auth-rbac

[English](README.md) | 中文

按团队绑定的角色目录，以及 authority 的角色路线 Provider。该服务从 `RbacPolicySource` 读取 `principal_roles = (user, tenant, team, role)`，只合并该用户在查询团队上的 RoleUse 或 RoleDelegate Action，并把结果注册到 `ctx.authority`。它不保存对象授权，不计算 Effective，也不读取 MySQL。

该包是 Service Definition、内存策略源，以及角色路线 Consumer。部署时在 `ctx.authority` 之后把它挂载为 `ctx.authRbac`。[`dsh-auth-rbac-mysql`](../auth-rbac-mysql/README.md) 实现 `RbacPolicySource`。

## 公共 API

| API | 用途 |
|---|---|
| `ctx.authRbac.registerSource(source)` | 注册唯一的策略源；返回卸载函数 |
| `ctx.authRbac.evaluate(query)` | 只返回查询团队上的 RoleUse(T) 或 RoleDelegate(T) |
| `MemoryRbacPolicySource` | 进程内角色定义和主体-角色绑定 |

同一用户可以在不同团队持有不同角色。`evaluate` 要求绑定同时匹配 `userId`、`tenantId` 和 `teamId`。它不会合并其他团队的角色。

Use 与 Delegate 保持独立。Use 求值只合并 `use` Action。Delegate Action 不会进入 Use 结果。

## 同一团队角色集合

`dsh-authority` 解析出资源团队 `T` 后，该 Provider 返回：

```text
RoleUse(T) = ⋃ use(role) for each role bound to (user, tenant, T)
RoleDelegate(T) = ⋃ delegate(role) for each role bound to (user, tenant, T)
```

研发组 `runner` 的 `{plugin:read, plugin:execute}` 不会把 `plugin:execute` 加进运营组 `viewer` 的 `{plugin:read}`。本包不把这些集合与对象授权取交。Effective 由 `dsh-authority` 拥有。

## 管理员操作

先挂载 `ctx.auth` 和 `ctx.authority`。注册策略源，再让 authority 询问角色路线：

```text
RbacPolicySource rows
  -> ctx.authRbac.evaluate({ user, tenant, team T, set })
  -> ctx.authority.registerRoute('role', …)
  -> ctx.authority.decide / require
```

卸载 `authRbac` fiber 会注销角色路线，并让 authority 在该路线上回到故障关闭。更新内存源后，下一次 `evaluate` 就能看到，无需重新挂载。

## 失败语义

| Code | 含义 |
|---|---|
| `invalid-input` | 查询、角色 id 或源注册值格式无效 |
| `conflict` | 已经注册了策略源 |
| `provider-unavailable` | 源缺失、抛错、返回无效数据，或绑定了未定义角色 |

传输适配器决定哪些内部分类应折叠成同一种公开响应。

## 模型体验

### 角色求值

#### 模型看到什么

什么也看不到。`ctx.authRbac.evaluate` 的结果、角色绑定和角色目录只存在于 Host；该包不注册可能向模型暴露这些数据的 prompt section、工具或 Session event。

#### Token 影响

为零。角色求值不会增加、删除或改写模型输入 Token。

#### KV Cache 影响

相互独立。角色求值不会改变模型可见的请求前缀，因此不会使原本可复用的 Provider cache entry 失效。

## 已知限制与延期工作

- **MySQL 持久化是独立的包** - [`dsh-auth-rbac-mysql`](../auth-rbac-mysql/README.md) 拥有 `principal_roles`、角色-Action 授权、revision 和撤销。
- **没有对象授权** - 资源 ACL 行属于 `dsh-authority-acl`。
- **没有 Effective 计算** - 同一团队交差仍由 `dsh-authority` 负责。
- **没有租户目录或团队目录查询** - 该服务接受 authority 查询里的品牌化 id，不调用 `ctx.tenants` 或 `ctx.teams`。
- **没有持久化审计投递** - 求值是进程内返回值。
