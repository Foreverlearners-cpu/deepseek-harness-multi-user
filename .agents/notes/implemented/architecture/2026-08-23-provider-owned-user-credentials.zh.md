# Agent Note: Provider-owned user credentials

Status: implemented

[English](2026-08-23-provider-owned-user-credentials.md) | 中文

## Problem

人类用户需要可变登录标识和密码验证，但稳定用户目录不能因此拥有密码 hash、查询索引或认证策略。标识归一化会随 kind 和部署变化，而密码 verifier 绝不能离开负责哈希和存储它的组件。登录响应也不能泄露账号是否存在或是否启用密码登录。

[用户目录决定](../../proposed/architecture/2026-08-23-dsh-user-directory-service.md)明确把这些记录交给独立所有者。该分离需要一个与 Provider 无关的 API，使认证与管理 Consumer 不依赖 MySQL schema 或某一种哈希实现。

## Decision

`@deepseek-ai/dsh-user-credential` 定义 Host-only `ctx.userCredentials` 服务。它把可扩展登录标识 kind 映射到 `dsh-user` 拥有的 `UserId`，并拥有密码设置、修改、验证和禁用操作。它仅在类型层依赖 `dsh-user`，不打开存储或网络资源。

一个已挂载 Provider 拥有受支持的标识 kind、kind-specific 归一化、规范化 `(kind, value)` pair 的全局唯一性、密码哈希及参数、verifier 与 dummy hash 存储、事务和持久化元数据。密码进入 protected Provider 操作；hash、salt、pepper 和 verifier 版本没有公开表示，绝不出现在服务结果或事件中。

## Aggregate concurrency

一个用户拥有一个 Credential 聚合，其中包含标识元数据和密码启用状态。Revision 0 时聚合不存在；第一次标识或密码修改提交 revision 1。标识和密码修改共享同一个单调 revision，并原子返回准确的修改前后元数据。

共享 revision 有意串行化同时发生的密码重置和标识管理。基类校验 Provider 提交证明，并把无关元数据变化拒绝为 `provider-unavailable`，因此错误 Provider 不能发布部分或错误分类的修改。

## Enumeration resistance

标识 `resolve()` 只向受信任的认证与管理 Consumer 返回 `UserId | undefined`。传输层不能把它暴露为账号发现端点。登录组合在同一种通用公开失败、速率限制和审计策略之后解析标识并验证 Credential。

`verifyPassword()` 只返回 boolean。标识解析失败时，认证 Consumer 省略 `userId`，Provider 仍执行可比的 dummy verifier 工作。未知用户、未启用密码的用户和错误密码也都返回 `false`。Provider 错误按 operation-specific code allowlist 使用固定 message 且不带 Provider cause 地重建；false Credential 结果绝不携带更具体原因。

## Metadata and events

受信任的元数据读取返回规范化标识 kind 与 value、创建时间、聚合 revision、更新时间和密码启用/修改时间状态。它们绝不返回密码材料。结果有界、分离且不可变。

每次提交修改后发出 `user-credential/changed`，只包含修改类别、`UserId`、revision、Provider 时间，以及可选操作者、原因和关联元数据。标识 kind 与 value、密码、verifier 元数据和 Provider 诊断均被排除。外部持久投递仍由持久化 Provider 的事务 outbox 负责。

## Provider verification

该包不导出具体 Provider，但 `./testing` 入口提供每个 Provider 都能复用的框架无关 contract suite。Harness 提供 fresh service 和显式密码验证工作探针。套件覆盖归一化与全局唯一性、标识生命周期、密码设置/修改/验证/禁用、false 结果防枚举、并发 compare-and-swap、提交后事件时机、事件脱敏和分离元数据。Provider-specific 套件还要证明真实 hash 验证、dummy verification 行为、唯一索引、事务、持久性和 migration 行为。

## Alternatives considered

**把标识和密码 hash 存入 `dsh-user`。** 否决，因为资料生命周期、索引登录查询、verifier 轮换和 Secret 存储具有不同安全规则与 Provider 演进节奏。放在一起会迫使每个用户目录 Provider 实现认证存储。

**在 Service Definition 中放置统一 normalizer registry。** 否决，因为支持的 kind 与规范化规则必须和 Provider 唯一索引原子一致。独立挂载的 normalizer 可能偏离已存储的查询语义。

**为每个标识和密码使用独立 revision。** 否决，因为管理界面通常从一个 snapshot 替换多个登录方式。一个聚合 revision 能检测所有中间 Credential 变化，防止过期全表单写入撤销密码重置或标识恢复。

**返回详细密码失败。** 否决，因为区分账号不存在、密码禁用和密码错误会形成枚举通道。详细恢复与管理状态来自已授权的元数据操作，而不是登录 verifier。

**让 Service Definition 哈希密码。** 否决，因为算法选择、pepper 访问、native library 生命周期、rehash 策略和 dummy verification 属于持久 verifier 存储。让 hash 穿过服务 API 会扩大携带 Secret 的接口和日志范围。

## Consequences

认证和管理 Consumer 可以跨存储与哈希实现使用同一 API，而且密码 verifier 无法通过类型逃逸。乐观并发和脱敏事件提供确定的集成点，而不会把 Credential 拉入用户资料或 Session replay。

当前 Provider 是安全关键组件，必须正确实现归一化、原子唯一性、密码哈希、固定工作量 dummy verification 和持久事务。Service Definition 能校验元数据证明，但不能测量时间相等性或证明哈希强度；每个生产 Provider 必须提供这些测试和部署说明。共享 revision 也会让无关 Credential 修改有意冲突，调用方需要重新读取并重试，而不是隐式合并。
