# Agent Note: Host 账号编排

Status: implemented

[English](2026-08-24-account-orchestration.md) | 中文

## Problem

用户记录、登录标识、密码验证、认证 Provider 和 JWT 生命周期操作由不同插件负责。若传输层直接调用它们，就必须重复实现写入顺序、active 用户检查、秘密处理、管理员 actor 验证和部分失败语义。

## Decision

`@deepseek-ai/dsh-account` 是协调这些服务的 Host-only Consumer。它不负责持久化、密码哈希、JOSE、HTTP 解析或授权策略。

注册依次写入用户、标识和密码。标识写入失败时禁用用户；密码写入失败时先移除标识，再禁用用户。由于 Provider 不共享事务，稳定的 `AccountError.recovery` 会报告不含秘密的已提交状态，以及补偿是否完成。

密码登录使用已注册的密码 Authentication Provider，通过 `assertCurrent()` 验证签发的 Call，确认用户仍为 active，然后使用 JWT 凭据生命周期能力。刷新和撤销仍由 JWT Provider 完成。修改密码、重置密码和禁用账号都会撤销目标用户的全部 Token Family。

管理员入口要求准确且当前有效的用户 Call，区分 actor 与目标身份，并把 actor 写入委托修改上下文和账号事件。账号服务在不依赖 `dsh-authority` 时无法证明 RBAC 授权，因此可信 Consumer 必须先授权 actor，再调用管理员方法。

事件只包含操作类型、请求 ID、目标用户 ID、可选 actor 用户 ID 和时间。请求、标识、密码、Refresh Secret 和 Provider Cause 都不会进入事件。

## Alternatives considered

**把编排放进 HTTP Gateway。** 这会把账号语义绑定到单一传输，并允许其他 Host Consumer 绕过相同的生命周期规则。

**让用户和凭据存储共享一个事务。** Provider-neutral 服务需要独立演进，也可能采用不同存储系统。要求共享事务会合并原本独立的能力边界。

**在账号服务中实现 RBAC。** 这会在 `dsh-authority` 尚未成为依赖时虚构授权策略，并把有效认证 Call 错当成管理员权限证明。

## Consequences

可信 Consumer 获得统一稳定的账号 API 和脱敏错误分类。跨服务失败可被观察和恢复，且不会暴露秘密；但注册补偿属于尽力执行，Provider 持续失败时仍可能需要运维介入。由于通用认证 Call 不公开 JWT Family ID，自助登出会撤销用户的全部会话。
