# Agent Note: 账号管理授权接线

Status: proposed

[English](2026-08-27-dsh-account-authority.md) | 中文

## 问题

`dsh-account` 要求唯一的 `AccountAdminAuthorizer`，并在该 Provider 缺失或抛错时故障关闭。授权策略必须留在账号生命周期之外。后续组合需要该 authorizer 调用 `ctx.authority.require`，让同一团队的 Effective 决定管理员操作；当成员关系已经给出恰好一个团队时，不要向 `AccountAdminAuthorizationRequest` 增加团队字段。

## 提案

增加 `@deepseek-ai/dsh-account-authority`，作为在 `ctx.accountAdministration` 上注册唯一 authorizer 的 Consumer。`authorize` 调用 `ctx.auth.assertCurrent`，把 `create` / `update` / `disable` / `enable` / `reset-password` / `revoke-sessions` 映射为 `account:*`，并对该 `account` 资源要求该 Action。`create` 使用操作者用户 id。其余操作使用 `target`。

本包同时登记这些 Action，并注册 `account` resolver。resolver 列出有效租户与团队成员，仅在恰好存在一个 `(tenant, team)` 对时返回可信资源。零个或两个及以上对视为未解析。可信 revision 为 1，因为本包不为账号行做版本。

本包不计算 Effective，不保存授权，不读取 MySQL，也不改动 `dsh-account` 流程。跨团队混合仍是拒绝，因为 Effective 仍然只在解析出的资源团队上对 RoleUse 与 ObjectUse 取交。

## 备选方案

**把 authorizer 放进 `dsh-account`。** 拒绝，因为账号编排必须保持无策略。缺失或抛错的 authorizer 已在那里故障关闭。

**现在就向 `AccountAdminAuthorizationRequest` 增加 `teamId`。** 拒绝，因为成员关系可以给出恰好一个团队。以后在管理员必须点名管理团队时，可以再加该字段。

**先合并操作者的全部团队，再取交。** 拒绝，因为跨团队混合是拒绝。resolver 提供目标的唯一团队；Effective 只在该团队上运行。

**从授权写入路径调用 `decide`。** 拒绝，因为本包不写授权。

## 验收标准

- 插件是唯一的 `AccountAdminAuthorizer`，并且先 `assertCurrent` 再调用 `ctx.authority.require`。
- 没有本插件时，管理员操作仍是账号 `forbidden`。
- 同一团队的 RoleUse ∩ ObjectUse 允许映射后的 Action。
- 目标唯一团队不是操作者授权团队时为 `forbidden`。
- 属于两个团队的用户视为未解析，并且不增加账号请求字段。
- 仅用于测试的 `cordis.yml` 通过官方 Loader 启动。

## 风险

- 用户加入第二个团队后，在后续请求字段点名团队之前无法被管理。
- 账号资源 revision 保持为 1，因此按 revision 隔离的对象授权不会跟随成员变更。

## 验证

聚焦测试覆盖缺失接线、同团队允许、跨团队拒绝、多团队未解析、create 使用操作者、成员查找失败和 fiber 卸载。通过 Loader 启动的 `cordis.yml` 覆盖 REAL 组合。
