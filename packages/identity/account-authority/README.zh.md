# @deepseek-ai/dsh-account-authority

[English](README.md) | 中文

账号管理 authorizer，把 `ctx.accountAdministration` 接到 `ctx.authority.require`。该服务断言当前 Call，把 `disable` 映射为 `account:disable`，并把其余管理员操作映射到对应目录项，再把账号资源解析为该用户唯一的有效团队。它不保存授权，不计算 Effective，也不改动账号生命周期流程。

该包是 Consumer。部署时在 `ctx.auth`、`ctx.authority`、`ctx.accountAdministration`、`ctx.tenants` 和 `ctx.teams` 之后把它挂载为 `ctx.accountAuthority`。没有本插件时，账号管理员方法仍以 `forbidden` 故障关闭。

## 公共 API

| API | 用途 |
|---|---|
| `ctx.accountAuthority.authorize(request)` | 断言操作者，然后要求映射后的账号 Action |

`create` 用操作者用户 id 作为账号资源。其余操作要求 `target`。resolver 仅在用户恰好有一个有效 `(tenant, team)` 对时返回团队。零个或两个及以上对按未解析资源拒绝。本包不向 `AccountAdminAuthorizationRequest` 增加团队字段。

## 管理员操作

在 authority 上挂载角色与对象路线，然后把本插件注册为唯一的 `AccountAdminAuthorizer`：

```text
accountAdministration.authorizers.authorize
  -> ctx.auth.assertCurrent
  -> ctx.authority.require(account:*)
  -> unique-team resolve
  -> RoleUse(T) ∩ ObjectUse(T)
```

卸载 `accountAuthority` fiber 会注销 authorizer、`account` resolver 和 `account:*` Action。

## 失败语义

authorizer 抛错会变成账号 `forbidden`。`ctx.authority.require` 的拒绝分类留在该映射内。缺失 authorizer 仍是账号 `forbidden`。

## 模型体验

### 账号管理授权

#### 模型可见内容

无。`ctx.accountAuthority.authorize` 结果、成员查找和 Effective 决策仅限 Host；本包不注册任何可能向模型暴露它们的提示词段落、工具或会话事件。

#### Token 影响

无。账号管理授权不会增加、删除或改写模型输入 token。

#### KV Cache 影响

独立。账号管理授权不会改动模型可见的请求前缀，因此不会使原本可复用的提供方缓存条目失效。

## 已知限制与延期工作

- **授权策略留在账号包外** - 本包只接线 `ctx.authority.require`。角色目录和对象授权仍由各自所有者负责。
- **仅唯一团队** - 属于两个团队的用户在账号请求增加团队字段之前不能被管理。
- **账号 revision 为 1** - 本包不为账号行做版本。
- **必须是唯一 authorizer** - 第二个 `AccountAdminAuthorizer` 会冲突。
