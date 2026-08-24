# Agent Note: MySQL 用户 Credential Provider

Status: implemented

[English](2026-08-24-mysql-user-credential-provider.md) | 中文

## Problem

与 Provider 无关的用户 Credential 服务需要持久的多进程标识唯一性、aggregate 乐观 revision、密码 verifier 存储，以及密码验证失败时的相近工作量。把这些选择放进 Service Definition 会让每个部署耦合到 MySQL 和一种密码格式；只委托而没有具体 Provider，则认证无法安全保存登录状态。

## Decision

`@deepseek-ai/dsh-user-credential-mysql` 基于 Host-only `ctx.mysql` 连接服务继承 `UserCredentialService`。它拥有独立的带版本元数据表、aggregate 表和归一化标识表。Schema 初始化持有 database-scoped MySQL advisory lock，并在取得锁后重新检查持久状态。标识表在 `(kind, normalized_value)` 上建立 binary `utf8mb4` 唯一索引；归一化会去除首尾空白并执行 NFKC，只有大小写不敏感的 `email` 和 `username` kind 还会使用与 locale 无关的英语小写规则。

密码 verifier version 1 使用 Node.js scrypt、固定持久参数、新鲜随机 salt 和 timing-safe derived-key 比较。Provider 在使用持久字段前根据该 version 验证每个字段。标识无法解析、aggregate 不存在或密码禁用时使用进程内随机 salt dummy verifier。Secret 和 verifier 字段绝不跨越 Provider API、事件或诊断接口。

标识与密码状态共享一个 aggregate revision。元数据读取从 aggregate 查询到标识查询持续持有 `FOR SHARE`，使两部分表示同一个 revision。修改会锁定 aggregate 行、比较 expected revision、应用子行或 verifier 变化、用相同 revision 条件更新、重新读取元数据并提交。Duplicate-key 竞争根据尝试的插入映射为标识冲突或 revision 冲突。其他存储、加密、异常行和事务失败全部由 Service Definition 重建为不含 cause 的 `provider-unavailable` 错误。

## Alternatives considered

**把密码 hash 存进 `dsh-user-mysql`。** 拒绝，因为资料生命周期和登录 Credential 拥有不同 Consumer、保留规则、修改 revision 和 Provider 选择。

**使用密码 hash npm 依赖。** version 1 拒绝，因为 Node scrypt 在所有受支持 runtime 中可用，不需要 native addon 分发或新增供应链依赖。后续仍可提供 Argon2 Provider 或 verifier version。

**让 scrypt 参数可配置。** 拒绝，因为 verifier 参数是持久安全数据，不是仅部署设置。静默配置变化会使已有行无法验证或允许不安全弱化；格式变化需要新 version 和 migration 决策。

**在 MySQL 中保存一个永久 dummy verifier。** 拒绝，因为它增加共享的类 secret 数据库状态和同步，却不能改善所需的等量派生工作。启动时使用相同 version 参数生成一个进程内随机 salt verifier。

**依靠 MySQL 大小写不敏感 collation 做标识归一化。** 拒绝，因为数据库 collation 行为不是 Provider 的显式 canonical value，并且可能随 collation 或服务器升级变化。Provider 在 binary 比较下保存自己的 canonical Unicode 值。

## Consequences

MySQL 部署无需修改 Service Definition 即可获得持久 Credential 状态、原子 revision 检查和全局唯一的归一化标识。Schema 与 verifier version 不匹配时失败，不猜测兼容性。Scrypt 限制离线猜测，而 endpoint 仍必须提供 rate limit 和通用认证响应。数据库是否存在及调度仍可能产生时序差异，因此相同派生工作不等于网络延迟不可区分。

公开且与测试框架无关的 Provider suite、存储专用事务与异常行测试、逐文件 100% 覆盖率，以及由 `DSH_MYSQL_TEST_URL` 门控的真实 MySQL Unicode 持久化、唯一标识竞争和 revision CAS 竞争测试共同固定该实现。
