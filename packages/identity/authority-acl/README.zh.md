# @deepseek-ai/dsh-authority-acl

[English](README.md) | 中文

对象授权目录，以及 authority 的对象路线 Provider。该服务从 `AclPolicySource` 读取授权行，合并匹配查询团队和实时主体事实的 ObjectUse 或 ObjectDelegate Action，并把结果注册到 `ctx.authority`。它不保存 `principal_roles`，不计算 Effective，也不读取 MySQL。

该包是 Service Definition、内存策略源，以及对象路线 Consumer。部署时在 `ctx.authority` 和 `ctx.teams` 之后把它挂载为 `ctx.authorityAcl`。后续的 `dsh-authority-acl-mysql` 实现 `AclPolicySource`。

## 公共 API

| API | 用途 |
|---|---|
| `ctx.authorityAcl.registerSource(source)` | 注册唯一的授权源；返回卸载函数 |
| `ctx.authorityAcl.registerRoleFacts(source)` | 注册唯一的角色事实源，用于匹配角色主体 |
| `ctx.authorityAcl.evaluate(query)` | 只返回查询团队上的 ObjectUse(T) 或 ObjectDelegate(T) |
| `MemoryAclPolicySource` | 进程内对象授权 |
| `aclSubjectRef(subject)` | 把主体编码为 `g:team-rd`、`u:user-red`、`r:runner`、`t:tenant-1` 或 `everyone` |

主体是 `user`、`role`、`team`、`tenant` 和 `everyone`。团队授权存成 `g:team-rd`。加人、踢人不会复制或删除该行。成员关系在求值时从 `ctx.teams` 读取。

Use 与 Delegate 保持独立。Use 求值只合并 `use` Action。Delegate Action 不会进入 Use 结果。

## 同一团队对象集合

`dsh-authority` 解析出资源团队 `T` 后，该 Provider 返回：

```text
ObjectUse(T) = ⋃ use(grant) for each grant on the resource whose subject matches T
ObjectDelegate(T) = ⋃ delegate(grant) for each grant on the resource whose subject matches T
```

团队主体仅在授权点名 `T`、且 `ctx.teams` 报告成员仍有效时匹配。研发组的 execute 授权不会进入运营组结果。本包不把这些集合与角色 Action 取交。Effective 由 `dsh-authority` 拥有。

## 管理员操作

先挂载 `ctx.auth`、`ctx.authority` 和 `ctx.teams`。注册策略源，再让 authority 询问对象路线：

```text
AclPolicySource rows
  -> ctx.authorityAcl.evaluate({ user, tenant, team T, resource, set })
  -> ctx.authority.registerRoute('object', …)
  -> ctx.authority.decide / require
```

卸载 `authorityAcl` fiber 会注销对象路线，并让 authority 在该路线上回到故障关闭。更新内存源或踢出成员后，下一次 `evaluate` 就能看到，无需重新挂载。

## 失败语义

| Code | 含义 |
|---|---|
| `invalid-input` | 查询、主体或源注册值格式无效 |
| `conflict` | 已经注册了策略源或角色事实源 |
| `provider-unavailable` | 源缺失、抛错、返回无效数据，或团队查询意外失败 |

传输适配器决定哪些内部分类应折叠成同一种公开响应。

## 模型体验

### 对象授权求值

#### 模型看到什么

什么也看不到。`ctx.authorityAcl.evaluate` 的结果、授权行和成员查询只存在于 Host；该包不注册可能向模型暴露这些数据的 prompt section、工具或 Session event。

#### Token 影响

为零。对象授权求值不会增加、删除或改写模型输入 Token。

#### KV Cache 影响

相互独立。对象授权求值不会改变模型可见的请求前缀，因此不会使原本可复用的 Provider cache entry 失效。

## 已知限制与延期工作

- **没有生产存储** - `dsh-authority-acl-mysql` 拥有 `resource_action_grants`、revision 和持久化团队主体。
- **没有角色目录** - 角色主体匹配询问已注册的事实源；本包不读取 `principal_roles`。
- **没有 Effective 计算** - 同一团队交差仍由 `dsh-authority` 负责。
- **没有租户目录查询** - 租户主体只匹配查询中的租户 id。
- **没有持久化审计投递** - 求值是进程内返回值。
