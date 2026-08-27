# Agent Note: dsh-tenant-authority cross-tenant guard

Status: proposed

[English](2026-08-27-dsh-tenant-authority-cross-tenant-guard.md) | 中文

## Problem

授权必须拒绝出示另一租户有效资源 id 的调用方，且不能告诉对方该资源存在。角色和对象路线在资源解析之后才报告 Action 集合。如果那些路线用 `insufficient-permission` 拒绝，调用方就能把活着的外租户 id 和不存在的 id 区分开。

把租户相等规则写进 ACL 行，会让授权作者忘掉它。把租户放进 `AuthenticatedCall`，会把身份和所选 scope 混在一起。改 `dsh-authority` 去加第三条路线或新的拒绝码，会把产品隔离规则搬进交差引擎。

仓库需要一个 decide 入口：比较可信的操作者 scope 和解析后的资源租户，在不一致时隐藏存在性，并把 Effective 留在 `dsh-authority`。

## Proposal

新增 `@deepseek-ai/dsh-tenant-authority`，作为跨租户守卫。部署时在 `ctx.auth`、`ctx.authority` 和 `ctx.tenants` 之后挂载恰好一个实例作为 `ctx.tenantAuthority`。产品调用方使用该服务的 `decide` / `require`。该包注入这三个服务。它不计算 Effective，也不读取角色或授权行。

请求携带可信的 `scope`。租户 scope 点名所选租户。运行时要求该租户上有有效成员，解析资源，并且仅当资源租户等于所选租户时才继续调用 `ctx.authority.decide`。来自另一租户的有效 id、缺失 id、非成员和平台 scope 都返回 `unresolved-resource`。

平台 scope 不是租户成员。本包绝不会把运营授权当成访问租户资源的资格。

`dsh-authority` 没有第三条路线。本包把领域 resolver 注册到 authority，一次注册同时服务守卫和交差引擎。直接调用 `ctx.authority.decide` 的组合不会得到 not-found 规则；README 写明必须挂上本插件。

## Decision inputs

| Value | Owner |
| --- | --- |
| 可信的操作者 scope | 传输 / 控制平面，不是资源指针。 |
| 有效成员 | `ctx.tenants.requireActiveMembership`。 |
| 资源租户 | 通过本服务注册的领域 resolver。 |
| Effective | 租户检查通过后由 `dsh-authority` 计算。 |

外租户有效 id 的公开拒绝与缺失 id 的公开拒绝相同。产品要求见[身份与访问](../../../docs/multi-user/identity-and-access.md) 的 not-found 规则。

## Alternatives considered

**对外租户有效 id 返回 `insufficient-permission`。** 否决，因为该码证明 resolver 找到了资源。公开分类必须与 not-found 相同。

**把租户相等编码成一条 ACL 授权。** 否决，因为漏写一行就会把隔离规则推给每个资源作者。检查属于一个 Consumer。

**把 `tenantId` 放进 `AuthenticatedCall`。** 否决，因为认证只回答调用方是谁。所选租户是授权 scope。

**给 `dsh-authority` 加第三条路线或新的拒绝码。** 否决，因为交差引擎不得拥有租户隔离。本包是 decide 入口；authority 仍在缺失角色或对象 Provider 时故障关闭。

**把平台 scope 当成租户通配符。** 否决，因为平台运营不会自动获得租户正文或资源访问。

## Acceptance criteria

- 该包定义 `registerResolver`、`match`、`decide`、`require`、品牌化 scope，以及夹具契约套件。
- 该包不导入授权存储、Session、传输、数据库或缓存包，也不打开外部资源。
- 同一租户成员加上交差后的路线返回允许。
- 另一租户的有效资源 id 返回 `unresolved-resource`，与缺失 id 的码相同。
- 平台 scope 返回 `unresolved-resource`，不会把成员关系当成授权。
- 只添加 `dsh-tenant-authority` 时，现有 Session、Agent、认证、租户目录、团队目录、authority、RBAC 和 ACL 行为保持不变。

## Risks

- 仍调用 `ctx.authority.decide` 的调用方会绕过 not-found 规则。后续 starter 组合必须挂上本插件，并对产品方法隐藏原始 decide 入口。
- 成员目录中断会使整次求值失败。传输 Consumer 不得把该分类映射成可枚举租户的公开信号。
- 在 `authority.decide` 之前解析会让 authority 再解析一次。接受这次重复查找，是为了在不改 authority 内核的情况下隐藏存在性。
