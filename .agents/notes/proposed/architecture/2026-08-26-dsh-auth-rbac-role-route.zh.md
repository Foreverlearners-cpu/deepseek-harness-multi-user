# Agent Note: dsh-auth-rbac role route

Status: proposed

[English](2026-08-26-dsh-auth-rbac-role-route.md) | 中文

## Problem

授权需要知道：用户在某一个团队上，凭绑定到该团队的角色，可以使用或转授哪些 Action。租户成员关系不命名角色。团队成员关系不命名 Action。`dsh-authority` 对两条路线取交，不得保存角色行。

把角色只绑到租户，会让该租户下每个团队得到同一套 Action。让 RBAC 计算 ALLOW 或 DENY，会把合并规则移出 `dsh-authority`，并诱使跨团队并集。在这里读取对象授权会把两条路线混在一起。

在 MySQL 或 ACL 之前，仓库需要一个与 Provider 无关的角色目录和角色路线 Provider。该包必须拥有按团队绑定的主体-角色、RoleUse / RoleDelegate 聚合，以及在 `ctx.authority` 上的注册。它不得计算 Effective。

## Proposal

新增 `@deepseek-ai/dsh-auth-rbac`，作为角色目录和 authority 的 `role` 路线。部署时在 `ctx.authority` 之后挂载恰好一个实例作为 `ctx.authRbac`。该包只为调用 `registerRoute('role', …)` 注入 `authority`。它不调用 `decide` 或 `require`，也不调用 `ctx.tenants` 或 `ctx.teams`。

`principal_roles` 是 `(user, tenant, team, role)`。同一用户可以在不同团队持有不同角色。`RbacPolicySource` 返回该三元组上的角色 id，以及每个角色的 Use / Delegate 集合。本包在进程内合并这些集合：

```text
RoleUse(T) = ⋃ use(role) for each role bound to (user, tenant, T)
RoleDelegate(T) = ⋃ delegate(role) for each role bound to (user, tenant, T)
```

`T` 是 authority 查询上的团队。运行时不会合并其他团队的角色。Use 求值只读取 `use`。这条规则不是 `Config` 字段。

`MemoryRbacPolicySource` 是进程内源。后续的 `dsh-auth-rbac-mysql` 实现同一个读取接口。缺失源、无效源数据和未定义的已绑定角色都是 `provider-unavailable`。卸载插件 fiber 会注销角色路线。

## Decision inputs

| Value | Owner |
| --- | --- |
| `AuthorityRouteQuery` | `dsh-authority` 在解析资源团队之后给出。 |
| `(user, tenant, T)` 上的角色 id | `RbacPolicySource.listPrincipalRoles`。 |
| Use / Delegate 集合 | `RbacPolicySource.listRoleActions`。 |
| Effective | `dsh-authority`；本包不与对象授权取交。 |

角色路线不会把团队成员展开成每人一行授权，也不决定 ALLOW 或 DENY。

## Alternatives considered

**把角色只绑到租户。** 否决，因为同一用户可以在研发组当 runner、在运营组当 viewer。只绑租户的角色会把 execute 泄漏到运营组。

**让 RBAC 计算 ALLOW 或 DENY。** 否决，因为合并规则属于 `dsh-authority`。本包只报告一个团队上的角色集合。

**合并用户所属的全部团队。** 否决，因为研发组 runner 会把 execute 加进运营组求值。同一团队聚合才是产品规则。

**在这里读取对象授权或计算 Effective。** 否决，因为对象路线是独立事实。混用两条路线会让 RBAC 擅自决定交差。

**让本包读取 MySQL。** 否决，因为 Service Definition 必须与 Provider 无关。存储属于后续的 `dsh-auth-rbac-mysql`。

## Acceptance criteria

- 该包定义 `registerSource`、`evaluate`、`RbacPolicySource`、品牌化 `RoleId`、内存源，以及夹具契约套件。
- 该包不导入授权存储、Session、传输、数据库或缓存包，也不打开外部资源。
- 研发组 `runner={plugin:read, plugin:execute}` 加运营组 `viewer={plugin:read}`，在查询团队为运营组时返回 `{plugin:read}`。
- Use 求值不读取 Delegate 集合。Delegate 求值不读取 Use 集合。
- 实时更新源后，下一次 `evaluate` 可见。卸载插件 fiber 会注销 authority 角色路线。
- 只添加 `dsh-auth-rbac` 时，现有 Session、Agent、认证、租户目录、团队目录和 authority 行为保持不变。
- ACL 和 MySQL Provider 仍是独立的后续包。

## Risks

- 只把查询团队当作 `T`，还不能兑现作用域不是资源所属团队的角色。后续变更必须保持同一团队聚合，不得引入跨团队并集。
- 未定义的已绑定角色会使整次求值失败。传输 Consumer 不得把该分类映射成可枚举角色名的公开信号。
- 注入 `ctx.authority` 会把加载顺序耦合到决策运行时。这是注册角色路线所必需的；缺少 authority 服务会在插件加载时失败。
