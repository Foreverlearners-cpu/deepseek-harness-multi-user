# Agent Note: Host 账号编排

Status: implemented

[English](2026-08-24-account-orchestration.md) | 中文

## Problem

用户记录、登录标识、密码验证、认证 Provider 和 JWT 生命周期操作由不同插件负责。若传输层直接调用它们，就必须重复实现写入顺序、active 用户检查、秘密处理、管理员 actor 验证和部分失败语义。

## Decision

`@deepseek-ai/dsh-account` 是协调这些服务的 Host-only Consumer。它不负责持久化、密码哈希、JOSE、HTTP 解析或授权策略。

注册要求通过 `ctx.accounts.registrationOperations` 注入唯一的持久化 `RegistrationOperationProvider`。它以 request id 为键，通过 `begin`、比较并交换的 `advance`、`complete` 和用于恢复的 `read`，持久化不含秘密的 `begun`、`user-created`、`identifier-added`、`password-set`、`completed` 或 `failed` 阶段。重试会从持久化进度继续，根据实际已提交状态核对结果不明确的凭据修改，并在完成后返回已保存的同一个 `UserRecord`。注册不会签发 JWT；JWT 由后续单独登录签发，因此 Access 与 Refresh Secret 不会成为幂等记录。

注册依次写入用户、标识和密码。恢复流程会尽可能禁用用户并移除已配置凭据。由于 Provider 不共享事务，稳定的 `AccountError.recovery` 会报告不含秘密的已提交状态，以及补偿是否完成。持久化进度可以跨进程崩溃恢复；缺少注册操作 Provider 时则默认失败，不允许未跟踪的写入。

密码登录会先解析规范化标识并记录凭据 revision，再使用已注册的密码 Authentication Provider。它通过 `assertCurrent()` 验证签发的 Call，要求 principal 与解析出的 active 用户一致，签发 JWT 凭据，然后再次读取凭据状态。若用户、revision、密码启用状态发生变化，或二次读取失败，服务会撤销刚签发的 JWT 并让登录失败。这个栅栏封闭了密码修改与管理员重置密码的竞争窗口。刷新和撤销仍由 JWT Provider 完成。修改密码、重置密码和禁用账号都会撤销目标用户的全部 Token Family。

`ctx.accounts` 上的自助资料修改只能改变 `displayName`；extensions 仍由管理员控制。管理员入口只存在于 `ctx.accountAdministration`，要求准确且当前有效的用户 Call，区分 actor 与目标身份，并把 actor 写入委托修改上下文和账号事件。服务通过 `ctx.accountAdministration.authorizers` 只接受一个 `AccountAdminAuthorizer`。授权器缺失、拒绝或抛错都会默认以 `forbidden` 失败；具体决策由后续的 RBAC 集成等策略插件负责。

事件只包含操作类型、请求 ID、目标用户 ID、可选 actor 用户 ID 和时间。请求、标识、密码、Refresh Secret 和 Provider Cause 都不会进入事件。

## Alternatives considered

**把编排放进 HTTP Gateway。** 这会把账号语义绑定到单一传输，并允许其他 Host Consumer 绕过相同的生命周期规则。

**让用户和凭据存储共享一个事务。** Provider-neutral 服务需要独立演进，也可能采用不同存储系统。要求共享事务会合并原本独立的能力边界。

**让可信调用方预先授权管理员方法。** 这会把有效认证 Call 错当成管理员权限证明，也会让直接 Host 调用方绕过策略。强制授权器既保留依赖边界，也提供统一的默认拒绝决策点。

## Consequences

可信 Consumer 获得统一的自助账号 API、显式保护的管理 API 和脱敏错误分类。跨服务失败可被观察和恢复，且不会暴露秘密；但组合层必须提供持久化注册操作存储和管理员策略。注册补偿属于尽力执行，Provider 持续失败时仍可能需要运维介入。由于通用认证 Call 不公开 JWT Family ID，自助登出会撤销用户的全部会话。
