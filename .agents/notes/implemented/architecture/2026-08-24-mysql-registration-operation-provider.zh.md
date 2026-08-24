# Agent Note: MySQL 注册操作 Provider

Status: implemented

[English](2026-08-24-mysql-registration-operation-provider.md) | 中文

## Problem

账号注册横跨用户目录和 credential 服务，因此进程崩溃可能丢失哪些 effect 已提交，而 transport 重试可能创建第二个账号。提供方无关的账号包需要持久幂等，同时不能让一个数据库 Provider 持有用户、credential 或 token 数据。

## Decision

`@deepseek-ai/dsh-account-mysql` 只实现 `RegistrationOperationProvider`，按唯一 `requestId` 保存一条操作。该行包含单调 revision、封闭的注册 stage、稳定用户关系、可选的非秘密 recovery state，以及不可变的已完成 `UserRecord`。它不包含 identifier、密码、verifier、token、token digest，也不会在接口要求的完成结果以外复制权威 profile。

`begin` 在一个事务中插入或锁定已有 request 行。`advance` 锁行、比较 revision 和 stage、检查前进转换与稳定用户关系，然后写入下一 revision。`complete` 只接受 `password-set`，只保存一次结果，并让操作进入终态。使用数据库行前会严格解码，storage diagnostics 会替换为固定账号错误分类。

Schema 初始化使用 database 范围的 advisory lock 串行化。Schema version 记录与自有表必须同时以版本 `1` 存在，或同时不存在；Provider 会拒绝不兼容、不完整和未记录版本的状态，而不会猜测其来源。

提供方无关的方法只接收 `requestId`，因此幂等通过该键识别一笔逻辑注册，而不使用 secret 或 profile 输入的 fingerprint。调用方为新操作分配新键。已完成重试始终返回第一次保存的结果，不受后来 request 字段影响；这样既不保留 secret 比较材料，也维持 `dsh-account` 的既有行为。

## Alternatives considered

**保存注册输入或 fingerprint。** 共享接口不提供输入 fingerprint，而从密码派生 fingerprint 会把 secret 派生的持久状态带入操作表。修改账号接口也会违背忽略替代重试字段的完成重试行为。

**在本包保存用户和 credential 副本。** 副本会产生相互竞争的权威来源，并把本 Provider 绑定到 `dsh-user` 与 `dsh-user-credential` 背后的存储选择。注册操作只记录 saga 进度和接口要求的最终结果。

**对所有账号 effect 使用一个事务。** 账号服务可能使用不同 Provider 或系统，因此不存在共享事务。持久 stage 与显式补偿保留 Provider 独立性，并让部分进度可恢复。

## Consequences

多个 Host 进程可以安全重试或竞争同一个注册键，过期 worker 无法继续推进或替换结果。运维人员得到明确的 schema 所有权和 fail-fast 兼容检查。代价是每个 stage 多一张表和一次事务，而且 transport 仍负责不把同一 `requestId` 分配给不同的逻辑注册。事件仍在数据库提交后发生，没有 transactional outbox。
