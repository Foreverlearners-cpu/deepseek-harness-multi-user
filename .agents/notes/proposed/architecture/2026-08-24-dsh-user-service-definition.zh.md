# Agent Note：dsh-user 服务定义

Status: proposed

[English](2026-08-24-dsh-user-service-definition.md) | 中文

## 问题

解耦 MySQL 多用户交付方案要把耦合候选实现拆成可独立评审的插件。在任何 Provider 持久化用户拥有的会话、文件或会话内容之前，产品需要一套稳定的用户身份词汇。候选提交把用户契约留在同时补丁 core 包的组合改动里；保持这种形态会让每个 Provider 各自发明用户类型，并重新引入 core 补丁。

## 提案

在 `packages/identity/user` 新增 `@deepseek-ai/dsh-user` 作为用户身份 Service Definition。该包定义 `ctx.users` 的创建、读取、require-active、禁用和列举操作，以及稳定的 `UserId` brand、用户状态生命周期和用户记录结构。`@deepseek-ai/dsh-user-mysql` 等 Provider 拥有持久化存储；认证凭据和外部身份映射保持为 `dsh-auth` 的独立能力。

### 租户所有权

所有权存放在 Provider 存储中，而不是 core session 或 agent 类型中。Provider 在自己的 schema 里维护 `sessionId → userId` 映射，并在每次存储操作中应用已配置或已认证的主体。core session、agent 和 agent-loop 包不做修改。

### 运行时范围

第一版 Provider 按租户运行时绑定：一个 DSH Host 部署对应一个已配置用户。共享进程服务互不信任的用户前，必须先有请求级身份机制；在该机制出现之前，并发多用户服务不属于本方案，而不是通过全局可变状态或 core 补丁模拟。

## 依赖

该包只依赖 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-brand` 和 `@deepseek-ai/dsh-invariants`。不引入外部依赖，也不注册打包运行时行为。

## 下游使用

`plugin/user-mysql` 实现该 Service Definition。会话与会话内容持久化 Provider 仅在需要身份感知所有权时依赖已合并的用户约定。消费方使用 `ctx.users`，不探测 Provider 专用服务。

## 考虑过的替代方案

**在 core session 和 agent 类型中新增用户身份字段。** 不采用：可选持久化会把身份模型施加到每个 DSH 部署，并使 core 包依赖可选插件约定。所有权保留在 Provider 存储中。

**让每个 Provider 各自定义用户词汇。** 不采用：结构相似的本地类型不会形成有归属的能力契约，并可能在运行时漂移；Provider 需要一个已合并的公共约定来构建。

## 验收标准

- core session、agent 和 agent-loop 公共类型不携带本包的用户身份字段。
- Provider 实现服务词汇时不修改上游包。
- 用户记录与所有权检查由 Provider 测试覆盖，包括跨用户拒绝。

## 风险

租户所有权的强度取决于提供给 Provider 的身份来源。一个 DSH Host 部署对应一个已配置用户的做法对单用户部署是安全的，但不声称请求级隔离；共享进程服务互不信任的用户，需要先实现暂缓的请求级身份机制。
