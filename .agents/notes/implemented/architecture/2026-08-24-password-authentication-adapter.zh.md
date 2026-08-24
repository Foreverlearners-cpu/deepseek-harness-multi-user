# Agent Note: Password authentication adapter

Status: implemented

[English](2026-08-24-password-authentication-adapter.md) | 中文

## Problem

认证 runtime 选择 Provider 并生成可信 call，而用户 Credential 服务拥有标识归一化和密码验证。人类登录需要组合这两个服务，同时不能把密码存储移入认证层、让传输层了解 Credential Provider API，或通过不同失败和执行路径暴露账号是否存在。

## Decision

`@deepseek-ai/dsh-auth-password` 是单一职责的认证 Provider 插件。它用 `password` 扩展 `AuthenticationEvidenceMap`，其中包含一个可扩展登录标识和候选密码，并注册 `password` 认证 method。受信任的传输层 Consumer 创建该 evidence；插件不解析协议请求。

Provider 通过 `ctx.userCredentials` 解析标识，随后准确调用一次 `verifyPassword()`。解析失败时省略 `userId`，让 Credential Provider 执行 dummy verifier，而不是由认证适配器提前返回。只有解析和密码都匹配时才产生已验证用户身份事实。`ctx.auth` 仍是唯一生成和验证 `AuthenticatedCall` 来源的组件。

## Failure semantics

Credential 拒绝、未知标识和格式错误的登录值都转换成同一个固定的 `unauthenticated` 错误。Credential Provider 的存储或哈希故障转换成一个固定的 `authentication-unavailable` 错误。适配器不会给任何一种错误附带 cause、标识、密码、SQL、hash 或 verifier 诊断。

认证 runtime 拥有脱敏的 `auth/result` 事件。密码适配器不发出额外事件，也不返回 `credentialId`，因为候选密码既不是持久公开的 Credential 标识，也不是 lifecycle 状态。

## Provider selection and lifetime

插件使用认证 registry 现有的精确 key 规则。Evidence kind `password` 直接选择本 Provider；不会运行 Provider chain 或 fallback。重复 evidence kind 或重复 method 会在注册时失败。Registry disposer 属于插件 fiber，因此卸载会移除 route，并使通过它生成的 call 失效。

## Alternatives considered

**给 `dsh-auth` 添加密码方法。** 否决，因为认证基础层将依赖人类账号存储和一种 Credential family。API key、JWT、本地身份和未来 evidence 不需要登录标识查询。

**在 gateway 解析标识。** 否决，因为每个传输层都必须重复防枚举行为，并正确调用 dummy verifier。Gateway 拥有 carrier 提取、歧义拒绝、速率限制和协议映射；Provider 拥有 evidence 验证。

**未知标识时立即返回。** 否决，因为这会跳过密码 verifier 工作并形成账号枚举信号。Credential Provider 拥有工作量相当的真实与 dummy 操作，而本适配器保证两条路径都会调用它。

**在密码验证中签发 JWT。** 否决，因为 evidence 验证与 Credential lifecycle 具有不同的失败和存储语义。密码认证身份建立后，再由 Token Provider 签发 Credential。

## Consequences

每个传输层都进入相同的密码验证流程，并且只收到认证 runtime 的稳定类别。密码只作为 Credential Provider 的瞬时输入，绝不会成为 authenticated-call 字段、审计记录或 Token 实现状态。

具体 Credential Provider 仍负责强密码哈希和工作量相当的 dummy 操作，Gateway 仍负责速率限制和歧义 carrier。账号 active 状态策略、授权、Token 签发、注册、找回、MFA 和锁定保持在这个窄职责插件之外。
