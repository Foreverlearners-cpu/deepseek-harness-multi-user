# Agent Note: Authentication suite composition

Status: implemented

[English](2026-08-24-authentication-suite-composition.md) | 中文

## Problem

认证包分别公开 Service 和 Provider，但部署者必须正确排列十一个插件，也不能在 Service 已出现而必要 Registry Provider 尚未提交时意外启动 Consumer。每个应用重复该顺序还容易在组合包中引入生产 JWT 默认值或策略捷径。

## Decision

`dsh-auth-starter` 是只有组合职责的包，提供两个 Function Plugin 入口。默认入口拥有完整 MySQL 子树；`./minimal` 入口等待外部 User、Credential、Token 和 Account Service 以及 `authProvidersReady` Marker，再挂载 Authentication、Password、JWT、Administrator 和 Gateway Consumer。

自定义 Provider Bundle 只有在持久化账号操作注册完成后才发布 Readiness Marker。两个入口都会预检显式 JWT Keyring 和已存在的自有 Service，按依赖顺序挂载子项，并在启动完成前确认 Password、Bearer 和 Registration Provider。本包不拥有数据、Route、授权策略或凭证算法。

管理员能力存在，但没有 Authorizer。这样后续策略仍可注入，同时保留 `dsh-account` 的默认拒绝行为；Starter 绝不把部署组合当作 RBAC。

## Lifecycle ownership

每个子项都通过 Starter 的 Scoped Context 挂载，因此卸载其 Fiber 会按所有权逆序释放组合。MySQL Service 会停止接收并排空已接收的 Callback。自定义 Provider Fiber 独立拥有 Service、注册和 Readiness Marker；移除该 Fiber 后，Minimal Starter 在下次 Loader Settlement 时会缺少 Inject。

## Alternatives considered

**一个单体 Authentication Service。** 它可以隐藏顺序，却会合并存储、Token、Transport 与 Account 职责，导致 Provider 无法替换，也不能独立测试。

**用 Service 存在表示 Provider Ready。** Cordis 会在构造期间发布 Service，而之后的 Registry Effect 未必已完成。只依赖 `accounts` 会产生 Starter 观察到空 Registration Registry 的竞态，因此采用显式 Marker。

**提供开发签名 Secret 或管理员 Allow 规则。** 任一默认值都可能静默进入生产。强制 Key Material 和空 Administrator Authorizer Registry 会改为明确启动失败或默认拒绝。

## Consequences

完整路径变为一个 Loader Row，并且只有一个 Disposal Owner。自定义存储无需把 MySQL 引入 Minimal Runtime，代价是增加一个 Readiness Marker，且其发布时间属于 Provider Bundle Contract。无 Key 测试通过真实 Loader Tree 覆盖注册幂等、Password 登录、Access 校验、Refresh 轮换与重放吊销、Logout、冲突、缺依赖和卸载；设置 `DSH_MYSQL_TEST_URL` 后，同一公开流程会在真实数据库 Service 上执行。
