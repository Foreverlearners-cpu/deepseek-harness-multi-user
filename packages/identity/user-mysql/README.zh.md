# @deepseek-ai/dsh-user-mysql

[English](README.md) | 中文

`@deepseek-ai/dsh-user` 的用户范围 MySQL Provider。它拥有 `dsh_users` 表，将用户生命周期与认证凭据分开，并使用 `@deepseek-ai/dsh-mysql` 统一管理连接和事务。

## 配置

| 配置键 | 必需 | 含义 |
| --- | --- | --- |
| `bootstrapUserId` | 否 | 本地开发启动时可选创建的 active 用户 id。 |
| `bootstrapDisplayName` | 否 | 可选 bootstrap 用户的显示名称。 |

Provider 要求 `ctx.mysql`，并在暴露 `ctx.users` 前创建 schema。Bootstrap 用户只是本地开发便利功能，不是认证机制。

## 生命周期与归属

当前应用范围只使用 `user_id`。新数据库不再创建 `tenant_id` 列。`disable()` 会改变生命周期状态但保留用户行和其数据。本 Provider 不存储密码、token 或外部身份声明。

## 模型体验

### MySQL 用户目录

#### 模型看到的内容

没有直接内容。该 Provider 不增加工具、提示词、消息或 session 事件；它只负责 `ctx.users` 背后的 `dsh_users` 表。

#### Token 影响

每次请求都不会直接增加 token。

#### KV Cache 影响

与模型请求相互独立：用户目录操作不会改变请求前缀。

## 已知限制与暂缓事项

- 认证、外部身份映射、撤销、membership 和授权策略尚未实现。
- Session 持久化当前按一个 Provider 实例绑定一个 `ownerUserId`；请求级认证和租户范围隔离暂缓。
- 检测到仍含 `tenant_id` 的旧 schema 时会在启动时拒绝；这个未发布版本需要重建数据库，或先执行显式的 user-id-only migration。
