# @deepseek-ai/dsh-authentication-local

[English](README.md) | 中文

用于引导流程与同进程组合的显式本地 profile `AuthenticationProvider`。`LocalAuthenticationProvider` 按共享的 [`authentication`](../authentication/README.md) 服务契约，把配置中的 principal、tenant 和 membership id 转换为不可变的本地 `AuthenticatedCall`。它没有隐式的默认身份，适用于明确受信任的本地 Host profile，不适用于面向互联网的登录流程。

## API

- `Config` 要求提供字符串字段 `principalId`、`tenantId` 和 `membershipId`；三个字段都会在激活期间由基础身份认证 branding 规则校验。
- `LocalAuthenticationProvider` 实现共享的 `AuthenticationProvider`，并为挂载 context 收到的每个受信任 attempt 返回本地 principal、`local` 方式和 tenant scope。
- 包默认导出为 `LocalAuthenticationProvider`；包根入口同时提供具名导出与 `Config` 类型。
- `./invariant` 入口提供包级伴生注册，供组合仓库不变式服务的 context 使用。

## 身份认证契约

当本地组合需要在远程凭证后端尚未存在时使用稳定身份，该 Provider 很有用。配置的 id 会在 Provider 激活时转换一次；每个调用仍由基础服务签发，保留 attempt 的请求 id、channel 和取消 signal，并通过授权所要求的私有签发者检查。

该 Provider 刻意不会从匿名 user id、hostname、loopback 地址或 RPC payload 推导身份。对于 HTTP attempt，它还会在代码层拒绝所有非回环 authority；这不是仅靠部署约定的栅栏。它的信任边界是显式挂载此 Provider 并提供 carrier attempt 的代码。应让这个组合边界保持本地且可审查。

## 失败语义

- 缺失或非字符串配置字段会在激活期间因 schema 校验失败。
- 空值、格式错误或过长的 id 会在共享 branding 校验中以 `TypeError` 失败，身份认证服务不会被激活。
- Provider 验证不会查询凭证，也不会签发过期时间；每个被接受的 attempt 都会在该调用生命周期内得到配置的身份。
- 下游授权仍会拒绝伪造调用、由其他 Provider 签发的过期调用、未知权限以及拒绝该操作的策略。

## 组合

只在显式的本地 profile 中挂载此 Provider，例如受信任的桌面或测试 Host。组合还必须挂载授权 Provider；本包本身不会授予任何产品操作。远程部署应替换为可以验证凭证并执行 tenant 或 operator 策略的 Provider。包级不变式伴生插件从 `./invariant` 导出。

## 模型体验

无，因为配置的本地 id 与 tenant scope 始终是 Host 侧授权元数据，绝不会进入模型请求。

#### KV Cache 影响

无；本地身份认证不会改变模型请求前缀。

## 已知限制与暂缓工作

- **不验证凭证** —— 配置的身份不是 OIDC subject、session、API key 或操作系统账户证明。
- **没有过期或撤销** —— 调用默认没有过期时间，修改配置需要替换 Provider 组合。
- **只适用于本地信任边界** —— 非回环 HTTP attempt 会被拒绝，Connection 也会拒绝把此 Provider 与声明的 `trustedHosts` 组合。网络部署仍需要能验证凭证的 Provider；回环可达性不是用户身份。
- **每个 Provider 只有一个配置身份** —— 按用户登录、选择 membership、使用 operator grant 或动态切换 tenant 需要其他 Provider。
