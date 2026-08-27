# Agent Note: 授权套件组合

Status: proposed

[English](2026-08-27-dsh-authority-starter.md) | 中文

## 问题

租户、团队、authority、RBAC、ACL、租户守卫、MySQL Provider 和账号 authorizer 插件是分开的包。部署需要一个按顺序的 Fiber 来挂载 MySQL 树和账号接线，而不能把该组合变成 RBAC 引擎、默认全允许策略、跨团队并集开关或第二套 JWT 密钥环。

## 提案

增加 `@deepseek-ai/dsh-authority-starter`，作为只负责组合的 Function Plugin，对照 `dsh-auth-starter`。默认入口注入 `mysql`、`auth` 和 `accountAdministration`，然后挂载 `dsh-tenant-mysql`、`dsh-team-mysql`、`dsh-authority`、`dsh-auth-rbac`、`dsh-auth-rbac-mysql`、`dsh-authority-acl`、`dsh-authority-acl-mysql`、`dsh-tenant-authority` 和 `dsh-account-authority`。它不创建 MySQL 连接池，也不创建 JWT 材料。

`./minimal` 入口等待目录、路线和 `authorityProvidersReady` 标记，然后只挂载 `dsh-tenant-authority` 和 `dsh-account-authority`。卸载 starter Fiber 会移除它挂上的子插件。

本包不插入角色或授权。Effective 仍是 `dsh-authority` 中的同一团队取交。

## 备选方案

**把挂载列表放进 `dsh-auth-starter`。** 拒绝，因为认证组合必须保持无策略，并且不能拥有租户、团队或授权插件。

**源为空时默认允许。** 拒绝，因为缺失策略就是拒绝。该套件故障关闭。

**增加一个合并全部团队的配置开关。** 拒绝，因为跨团队混合是拒绝。没有并集开关。

**内置 JWT 密钥以便单独启动。** 拒绝，因为签名材料属于 `dsh-auth-starter`。本包注入 `auth`，不发明密钥。

**再次挂载 `dsh-mysql`。** 拒绝，因为 `dsh-auth-starter` 已经拥有连接池。默认入口注入 `mysql`。

## 验收标准

- 默认入口按依赖顺序挂载 MySQL 授权树和 account-authority。
- `./minimal` 在挂载 Consumer 之前等待就绪标记。
- 缺失的注入服务或已经自有的服务会拒绝启动。
- 没有授权时，decide 和管理员授权保持故障关闭。
- 仅用于测试的 `cordis.yml` 通过官方 Loader 启动。
- 卸载 starter Fiber 会注销 Consumer，并保留注入的存储。

## 风险

- 自定义 Provider 组合若在源登记之前发布就绪标记，Consumer 会对着空目录启动。该组合自行保证该标记。
- 两个 starter 共享一个 MySQL 连接池时必须约定 schema 初始化顺序；每个 MySQL Provider 仍在 init 时验证自己的 schema。

## 验证

聚焦测试覆盖挂载顺序、缺失注入、已激活服务、不完整的子注册、内存 decide 与管理故障关闭、Fiber 卸载，以及通过 Loader 启动的 `cordis.yml`。真实 MySQL 验证继续由 `DSH_MYSQL_TEST_URL` 控制。
