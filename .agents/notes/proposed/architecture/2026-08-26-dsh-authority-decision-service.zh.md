# Agent Note: dsh-authority decision service

Status: proposed

[English](2026-08-26-dsh-authority-decision-service.md) | 中文

## Problem

角色资格和对象授权是独立事实。调用者在一个团队里能执行插件，不能因此获得只授给另一个团队的资源的 execute。认证回答调用者是谁。租户和团队目录回答成员关系。现有包都没有在一个故障关闭的决策点上交叉这些事实。

把授权放进 `dsh-auth`，会让身份携带权限。把交集算在 RBAC 或 ACL 里，会让一条路线擅自决定合并规则。让中心读取 MySQL，会把决策 API 绑到第一个存储 Provider。

在 RBAC、ACL 或租户边界 Consumer 之前，仓库需要一个与 Provider 无关的授权运行时。该服务必须拥有 Action 目录、资源 resolver 注册表、路线 Provider 注册表、默认拒绝和同一团队交差。它不得保存角色或授权。

## Proposal

新增 `@deepseek-ai/dsh-authority`，作为 Service Definition 和决策引擎。部署时在 `ctx.auth` 之后挂载恰好一个实例作为 `ctx.authority`。该包只为调用 `assertCurrent` 注入 `auth`。它导入品牌化 `UserId`、`TenantId` 和 `TeamId` 校验器，不调用 `ctx.users`、`ctx.tenants` 或 `ctx.teams`。

`AuthorityRequest` 是当前的 `AuthenticatedCall`、已登记 Action，以及不可信的 `{ type, id }` 指针。领域插件注册 `ResourceResolver`，返回 type、id、租户、团队和 revision。客户端提供的租户或团队字段会被忽略。

每条路线的 Provider 接收已经解析的 `(user, tenant, team T, action, resource, set)`，并返回该团队上的 Use 或 Delegate Action 集合。本包只做交差：

```text
Effective(T) = RoleSet(user, T) ∩ ObjectSet(resource, T)
```

`T` 是可信资源上的团队。运行时不会合并不同团队的集合。Use 决策向两条路线都请求 `set: 'use'`；Delegate 集合不会进入 Use 判断。这条合并规则不是 `Config` 字段。

`decide()` 返回允许或拒绝分类。`require()` 抛出拒绝分类。缺失 Provider、未知 Action、resolver 失败、无效 Provider 结果和意外抛错都是拒绝。

## Decision inputs

| Value | Owner |
| --- | --- |
| `AuthenticatedCall` | `dsh-auth`；本包重新校验来源，并要求用户主体。 |
| `ActionCode` | 由领域或策略插件登记的 Action 目录。 |
| `ResourceRef` | 调用方只提供 type 和 id。 |
| `TrustedResourceRef` | 资源 resolver；包含租户、团队和 revision。 |
| `T` 上的角色集合 | 后续 `dsh-auth-rbac` 路线 Provider。 |
| `T` 上的对象集合 | 后续 `dsh-authority-acl` 路线 Provider。 |

中心不会把团队成员展开成每人一行授权，也不决定一条路线如何构造自己的集合。

## Alternatives considered

**把授权放进 `dsh-auth` 或 `AuthenticatedCall`。** 否决，因为认证回答的是调用者是谁。把角色、团队或授权放在调用上会把身份与授权混在一起，并强迫每个已认证请求选择一个权限范围。

**先合并用户所属的全部团队，再与全部对象授权的并集取交。** 否决，因为研发组 runner 会继承只授给运营组的资源上的 execute。同一团队交差才是产品规则。

**让 RBAC 或 ACL 计算最终的 ALLOW/DENY。** 否决，因为每条路线都会拥有合并规则，并可能静默改掉它。两条路线只报告一个团队上的集合；由本包取交。

**让中心读取 MySQL、Redis 或成员表。** 否决，因为 Service Definition 必须与 Provider 无关。存储属于后续路线 Provider。成员关系仍由 `dsh-tenant` 和 `dsh-team` 负责。

**把合并规则做成 `Config` 字段。** 否决，因为部署不能把运行时改成跨团队并集。交差是安全不变量。

## Acceptance criteria

- 该包定义 `decide`/`require`、Action 目录、返回 disposer 的路线 Provider 和资源 resolver 注册表、稳定拒绝分类，以及夹具 Provider 契约套件。
- 该包除 `dsh-auth` 外不导入认证实现，不导入授权存储、Session、传输、数据库或缓存包，也不打开外部资源。
- 同一团队交差是唯一合并方式：研发组角色加运营组对象授权为拒绝；两条路线在同一团队都有成员为允许。
- 只有一条路线的集合包含该 Action 时为拒绝。缺失 Provider、未知 Action、resolver 失败和已卸载 Provider 为拒绝。
- Use 决策不读取 Delegate 集合。Delegate 决策不读取 Use 集合。
- 聚焦测试覆盖六个必需夹具用例、当前调用拒绝、忽略客户端声称的团队、畸形 Provider 结果，以及 Provider 卸载。
- 只添加 `dsh-authority` 时，现有 Session、Agent、认证、租户目录和团队目录行为保持不变。
- RBAC、ACL、租户边界和 MySQL Provider 仍是独立的后续包。

## Risks

- 只把已解析资源的团队当作 `T`，还不能兑现主体不是资源所属团队的授权。后续 ACL 变更必须保持同一团队交差，不得引入跨团队并集。
- 不同的拒绝分类可以帮助管理，但直接映射到公开响应时可能泄漏 Action 或资源是否存在。传输 Consumer 必须在需要抵抗枚举的地方折叠它们。
- 注入 `ctx.auth` 会把加载顺序耦合到认证。这是拒绝伪造调用所必需的；缺少 auth 服务会在插件加载时失败。
