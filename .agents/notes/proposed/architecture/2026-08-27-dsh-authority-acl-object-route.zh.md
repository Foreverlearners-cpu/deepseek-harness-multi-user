# Agent Note: dsh-authority-acl object route

Status: proposed

[English](2026-08-27-dsh-authority-acl-object-route.md) | 中文

## Problem

授权需要知道：某一资源允许调用方在该资源所属团队上使用或转授哪些 Action。角色绑定不点名资源。`dsh-authority` 对两条路线取交，不得保存授权行。

把团队授权复制到每个成员行会让存储膨胀，并使加人和踢人改写 ACL。让 ACL 计算 ALLOW 或 DENY，会把合并规则移出 `dsh-authority`，并诱使跨团队并集。在这里读取 `principal_roles` 会把两条路线混在一起。

在 MySQL 之前，仓库需要一个与 Provider 无关的对象授权目录和对象路线 Provider。该包必须拥有资源-Action 授权、ObjectUse / ObjectDelegate 聚合，以及在 `ctx.authority` 上的注册。它不得计算 Effective。

## Proposal

新增 `@deepseek-ai/dsh-authority-acl`，作为对象授权目录和 authority 的 `object` 路线。部署时在 `ctx.authority` 和 `ctx.teams` 之后挂载恰好一个实例作为 `ctx.authorityAcl`。该包注入 `authority` 以调用 `registerRoute('object', …)`，并注入 `teams` 以解析实时成员关系。它不调用 `decide` 或 `require`，也不读取 `principal_roles`。

授权主体是 `user`、`role`、`team`、`tenant` 和 `everyone`。团队授权存成 `g:team-rd`，并且保持一行。加人和踢人不会复制或删除该行。`AclPolicySource` 返回某一资源上的授权。本包在进程内合并这些集合：

```text
ObjectUse(T) = ⋃ use(grant) for each grant on the resource whose subject matches T
ObjectDelegate(T) = ⋃ delegate(grant) for each grant on the resource whose subject matches T
```

团队主体仅在点名查询团队 `T`、且 `ctx.teams.requireActiveMembership` 报告该对仍有效时匹配。研发组的 execute 授权不会进入运营组结果。踢出之后，同一用户不再命中 `g:team-rd`。角色主体匹配询问已注册的事实源；本包不拥有那张表。

`MemoryAclPolicySource` 是进程内源。后续的 `dsh-authority-acl-mysql` 实现同一个读取接口。缺失源、无效源数据和意外的团队查询失败都是 `provider-unavailable`。卸载插件 fiber 会注销对象路线。

## Decision inputs

| Value | Owner |
| --- | --- |
| `AuthorityRouteQuery` | `dsh-authority` 在解析资源团队之后给出。 |
| 某一资源上的授权行 | `AclPolicySource.listGrants`。 |
| 实时团队成员关系 | `ctx.teams.requireActiveMembership`。 |
| `(user, tenant, T)` 上的角色 | `AclRoleFactSource.listRolesOnTeam`。 |
| Effective | `dsh-authority`；本包不与角色 Action 取交。 |

对象路线不会把团队成员展开成每人一行授权，也不决定 ALLOW 或 DENY。

## Alternatives considered

**把团队授权复制到每个 user 行。** 否决，因为加人和踢人会改写 ACL，表还会随成员增长。授权保持 `g:team-rd`；成员关系从团队服务读取。

**让 ACL 计算 ALLOW 或 DENY。** 否决，因为合并规则属于 `dsh-authority`。本包只报告一个团队上的对象集合。

**合并用户所属的全部团队。** 否决，因为研发组的 execute 授权会在查询团队为运营组时出现。同一团队聚合才是产品规则。

**在这里读取 principal_roles 或计算 Effective。** 否决，因为角色路线是独立事实。混用两条路线会让 ACL 擅自决定交差。

**让本包读取 MySQL。** 否决，因为 Service Definition 必须与 Provider 无关。存储属于后续的 `dsh-authority-acl-mysql`。

## Acceptance criteria

- 该包定义 `registerSource`、`registerRoleFacts`、`evaluate`、`AclPolicySource`、品牌化主体引用、内存源，以及夹具契约套件。
- 该包不导入授权存储、Session、传输、数据库或缓存包，也不打开外部资源。
- 资源把 `plugin:execute` 授给 `g:team-rd` 时，查询团队为运营组不会加入该 Action。
- 用户被踢出研发组后，在该团队上求值不再命中 `g:team-rd`，授权行保持不变。
- Use 求值不读取 Delegate 集合。Delegate 求值不读取 Use 集合。
- 实时更新源或成员关系后，下一次 `evaluate` 可见。卸载插件 fiber 会注销 authority 对象路线。
- 只添加 `dsh-authority-acl` 时，现有 Session、Agent、认证、租户目录、团队目录、authority 和 RBAC 行为保持不变。
- MySQL Provider 仍是独立的后续包。

## Risks

- 只把查询团队当作 `T`，还不能兑现主体不是资源所属团队的团队授权。后续变更必须保持同一团队聚合，不得引入跨团队并集。
- 意外的团队目录失败会使整次求值失败。传输 Consumer 不得把该分类映射成可枚举授权主体的公开信号。
- 注入 `ctx.authority` 和 `ctx.teams` 会把加载顺序耦合到决策运行时和团队目录。这是注册对象路线、以及实时解析 `g:team-*` 主体所必需的。
