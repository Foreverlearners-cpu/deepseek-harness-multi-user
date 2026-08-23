# Agent Note: dsh-auth 身份与凭据生命周期

Status: proposed

[English](2026-08-23-dsh-auth-identity-and-credential-lifecycle.md) | 中文

## 问题

Harness 已有 Host 与 Origin 检查、匿名安装身份、sandbox policy 和用户批准，但这些机制都不能确定请求由哪个 principal 发起。浏览器 payload 可以携带类似用户身份的字段，但 Host 服务无法区分该声明与通过凭据验证的身份。如果 HTTP、WebSocket、SDK、ACP 和进程内入口各自增加认证适配器，它们还会产生不一致的身份、失败类别、过期处理和 secret 脱敏规则。

已提出的多用户架构要求在派生租户与授权前完成认证，但其总体方案没有精确定义认证包的职责。如果基础包同时解析 JWT、选择 tenant membership、判断角色或修改每个 Remote 方法，就会耦合独立演进的机制，并重现认证与授权合并实现造成的大范围改动。

系统需要一个包来定义已认证 principal identity，通过可替换 Provider 验证 carrier 持有的证据，签发客户端数据无法伪造的请求级调用，并定义凭据生命周期语义，同时不拥有具体 Token 格式或产品权限模型。

## 提案

在 `packages/identity/auth` 增加 L1 认证 Service Definition 与协调器 `@deepseek-ai/dsh-auth`。该包提供 `ctx.auth`、effect 持有的认证 Provider 注册表、规范化的 principal 与 credential 标识符、不可变已认证调用、凭据生命周期接口、安全认证事件和稳定失败类别。在具体 Provider 与传输 Consumer 完成组合前，它不挂载到已交付 bundle。

完整认证能力仍按角色拆分。`dsh-auth` 拥有共享规则与协调逻辑；`dsh-auth-jwt`、`dsh-auth-apikey` 等包实现验证和凭据生命周期行为；`dsh-auth-gateway` 在传输入口提取 carrier evidence 并消费已认证调用。本 note 细化[多用户控制平面与数据平面提案](2026-08-18-multi-user-control-and-data-planes.md)中的认证部分：`AuthenticatedCall` 确立 principal，`dsh-tenant-scope` 独立派生 tenant membership 和 platform scope。

### 最小 Service API

请求路径包含两个 Consumer 操作和一个 Provider 扩展操作。`ctx.auth.authenticate(attempt)` 通过选定 Provider 验证不可信 evidence，并签发 `AuthenticatedCall`。`ctx.auth.assertCurrent(call)` 仅在确切对象 provenance、Provider registration、取消和过期状态仍有效时返回同一个 call，否则抛出稳定认证失败。`ctx.auth.providers.register(evidenceKind, provider)` 为一个 evidence kind 安装唯一活动 Provider，并返回 disposer。在真实 Consumer 需要不抛错检查前，暂不增加 boolean `isCurrent()`，因为它会重复 `assertCurrent()` 行为。

凭据签发与调用认证是两件事。JWT 或 API-key Provider 创建原始 credential；`authenticate()` 消费这些 credential，并创建仅供 Host 使用的 call。可选生命周期操作归入 `ctx.auth.credentials`，供登录、刷新、设备检查和退出 Consumer 使用，不进入普通业务请求。Provider capability 包含 `issue`、`refresh`、`inspect` 和 `revoke`；credential kind 只暴露其真正实现的 capability。

### Principal identity

`dsh-auth` 为 user、service account、local principal、credential、token family、认证请求和认证方式定义 branded identifier。已认证 principal 是 `user`、`service-account` 与 `local` 的闭合 union。角色、权限、tenant membership、operator grant、data scope、quota 和对象可见性具有独立 owner 与生命周期，因此不进入 principal。

已验证认证结果包含 principal、认证方式、可选 credential id、认证时间和可选凭据过期时间。Provider 专属 claims 保留在 Provider 内部，除非后续包为具名 Consumer 定义规范化 extension。核心结果不提供任意 claims bag，因为该字段会演变为隐式授权和租户 API。

### Carrier evidence 与 Provider 选择

传输 Consumer 在业务 payload 分发前，使用 Host 持有的事实创建 authentication attempt。Attempt 包含 Host 生成的 request id、carrier channel、类型化 evidence、取消 signal，以及凭据格式需要时的目标 audience。原始 bearer token、API key、cookie 或进程内证明是 evidence，不是 identity。

可扩展的 `AuthenticationEvidenceMap` 把每种 evidence kind 映射到其类型化字段。Provider 通过 `ctx.auth.providers.register()` 为唯一 evidence kind 注册。注册是 Cordis effect，重复活动 owner 直接失败，释放会移除 Provider，并使其签发的请求级调用失效。认证按 evidence kind 精确选择 Provider；它不会依次试探多个 Provider，也不会在失败后退回 anonymous 或 local identity。

传输 Consumer 会拒绝同时提交多项已识别凭据的请求，例如同时提供 bearer token 与 API key，而不是采用隐藏优先级。共享同一种 carrier syntax 的多个信任来源保留在一个 L2 Provider 内。例如，唯一 `bearer` Provider 可以维护已配置 JWT issuer registry：未验证的 `iss` 或 `kid` 只能选择一个候选 verifier，最终接受仍要求该 verifier 校验 signature、issuer、audience、time claim 和 credential status；失败后绝不尝试其他 issuer。唯一 `api-key` Provider 同样可以用非 secret key prefix 选择一个后端存储，再比较已存 verifier。

缺失 evidence、格式错误 evidence 和凭据拒绝产生 `unauthenticated`。已配置 Provider 无法完成验证时产生 `authentication-unavailable`。当组合可以解析缺失 Provider 时，将其视为加载或部署错误；其他情况下请求默认拒绝。公共错误不区分未知账号与无效凭据，也不包含 Provider diagnostics。

### AuthenticatedCall

只有 `dsh-auth` 能在 Provider 返回已验证事实后签发 `AuthenticatedCall`。Call 把 principal 与 Host request id、carrier channel、取消 signal、认证时间、认证方式、可选 credential id、可选过期时间以及完成验证的确切 Provider registration 绑定。Service 复制并冻结 Provider 持有的对象，再通过进程私有 provenance map 记录确切 call 对象。

结构复制、JSON 往返、客户端 payload、其他 `ctx.auth` 实例签发的对象、已释放 Provider registration 签发的调用以及过期调用都不能通过当前调用检查。`assertCurrent()` 是 Consumer 使用的统一操作，在已认证操作消费 call 前立即校验 provenance、Provider registration、取消和过期状态。认证只确立身份；当前有效 call 不授予任何产品权限，也不选择任何租户数据。

Authenticated call 保持在 wire DTO 之外。传输 Consumer 通过 Host 专属 invocation context 传递 call。客户端生成的 `userId`、`principal`、`tenantId` 或 `call` 字段都不能替代它。该包不提供进程全局 `currentUser`；并发操作显式携带 call，避免请求间身份串线。

### 凭据生命周期框架

`dsh-auth` 定义 credential 与 token-family 生命周期约定，但不实现 Token 编码、签名、存储或传输。具体 Provider 拥有签发的 secret value 与持久化。TTL、key rotation、algorithm、issuer、audience 和存储后端属于 Provider 配置，而不是 L1 包中的常量。

公共生命周期按 credential kind 与 capability 区分 access credential、refresh credential、API key 和 local attestation。Provider 可以注册其凭据类型支持的 issue、refresh、inspect 和 revoke 操作；不支持的操作显式失败。`dsh-auth` 规范化生命周期结果与事件，但不强迫 API key 或 local attestation 模拟 refresh token。

刷新约定要求一次性 refresh-token rotation。刷新成功时，以原子方式消费收到的 refresh credential，并在同一 token family 中返回新的 access credential 与 refresh credential。并发使用同一个 refresh credential 时最多允许一次成功。再次使用已消费 refresh credential 会报告 compromise 并撤销整个 token family。Provider 只持久化 refresh secret 的单向 verifier，仅在签发或轮换时返回一次明文 refresh value。

撤销可以针对单个 credential、一个 token family，或某个 principal 的全部 credential。约定需要声明 access-credential 撤销是立即生效还是在过期时间内最终生效；无状态 access token 只有在 Provider 检查 denylist、credential version 或在线 authority 时，才能声明立即撤销。`dsh-auth` 不替 Provider 选择实现。

### Secret 处理与事件

原始 credential 只作为 Provider 与生命周期操作的短期输入。它们永远不进入 `AuthenticatedCall`、错误消息、本包拥有的 Cordis event、日志、模型请求、session event 或 audit metadata。凭据返回值使用显式 secret-bearing result，使 Consumer 可以避开通用序列化和日志 helper。

该包发出有界的 `auth/succeeded`、`auth/failed`、`auth/credential-revoked`、`auth/token-rotated` 和 `auth/token-reuse-detected` 事件。事件可以包含 request id、成功识别后的 principal kind 与 id、method、credential id、token-family id、outcome、安全 reason 和 time。它们不包含原始 credential、Provider claims、密码材料、资源内容、角色或 tenant data。这些 live event 为后续 security-audit Consumer 提供输入，永远不进入 session replay log。

### 包依赖与下游使用

`dsh-auth` 只依赖 Cordis 与仓库 branded-id utility，不依赖 JWT、数据库、HTTP framework、Redis、tenant 或 authorization。仅测试使用的 fixture Provider 验证 registry、provenance、lifecycle 和 failure 行为，但不会成为生产 fallback。

`dsh-auth-jwt` 将使用这些约定实现 access token 与轮换 refresh token。`dsh-auth-apikey` 将实现 API-key 验证和撤销，不提供 refresh 行为。`dsh-tenant-scope` 将使用当前有效 authenticated call 与 membership state 派生 `TenantScope`。`dsh-authority` 将使用当前 call，并在需要时结合 tenant scope 判断产品权限。`dsh-auth-gateway` 将拥有 HTTP、WebSocket、SDK、ACP 和进程内 evidence 提取、公共状态映射和 Host 专属 call 传递。

首个 `dsh-auth` 变更不会修改 Gateway handler、Typert descriptor、Remote decorator、API Proxy route permission、session record、MySQL、Redis、Elasticsearch、Kafka 或已交付 bundle 行为。这些集成需要各自的 Agent Note 和完整 Provider/Consumer 组合。

因此，P0 包的即时改动范围较小，但它本身不构成产品安全声明。它为后续插件提供统一身份表示、确定性 Provider 选择、共享 expiry 与 provenance 检查和公共 secret 处理。代价是更多 package 与显式组合，而真实登录和受保护产品操作要等具体 Provider 与传输 Consumer 安装后才可用。拟议的 [Provider 与 Consumer 组合](2026-08-23-dsh-auth-provider-and-consumer-composition.md)记录该集成路径。

## 备选方案

**把认证与授权合并到一个包。** 否决，因为 credential verification 与产品 policy 具有不同的 Provider、失败状态、存储和变化频率。有效身份不能隐含操作权限。

**把 tenant 与 membership scope 放入 `AuthenticatedCall`。** 否决，因为一个 principal 可能拥有多个 membership，tenant 选择可以随操作变化，并且 membership 可以独立于 credential 有效性变化。该派生由 `dsh-tenant-scope` 拥有。

**允许每个 transport 或 Provider 构造自己的 authenticated-call 对象。** 否决，因为 provenance、immutability、expiry、cancellation、failure mapping 和 secret handling 会产生差异，并且结构对象可能通过意外信任路径传递。

**依次尝试所有已注册 Provider，直到某个接受 credential。** 否决，因为 owner 模糊、耗时差异和 Provider 故障会产生不安全 fallback。Evidence kind 只能精确选择一个 Provider。

**在 `dsh-auth` 中包含 JWT 签名与 refresh 持久化。** 否决，因为 JWT 与 API key 具有不同生命周期能力和依赖。L1 包拥有公共义务；L2 包拥有格式、密码学、持久化和部署配置。

**使用全局 current-user service。** 否决，因为并发请求和嵌套异步工作可能观察到错误身份。Call 保持为显式 Host 专属值。

**由核心包激活宽松 local Provider。** 否决，因为静默 local fallback 会把缺失部署认证变成可信访问。本地开发可以使用独立显式 Provider 或测试 fixture。

## 验收标准

- `@deepseek-ai/dsh-auth` 定义 branded principal、credential、token-family、request 和 method identifier，且不导入 authorization 或 tenant 包。
- Provider 注册由 effect 持有，拒绝重复 evidence-kind owner，精确选择一个 Provider，并在验证无法完成时默认拒绝。
- 只有该 Service 能签发冻结的 authenticated call，并拒绝结构复制、JSON 往返、外部 issuer、已释放 registration、已取消 call 和过期 call。
- 认证与生命周期失败暴露稳定公共类别，不返回 credential value、账号存在性、Provider diagnostics 或任意 claims。
- 凭据生命周期约定覆盖签发、检查、原子刷新轮换、重用检测、单个与 family 撤销和 principal 全量撤销，同时允许 credential kind 声明不支持的操作。
- 脱敏事件包含关联与身份 metadata，但不包含 secret、角色、tenant scope、resource content 或模型可见数据。
- 聚焦单元测试覆盖 identifier validation、registry lifecycle、Provider failure、确切对象 provenance、immutability、expiry、cancellation、rotation race、reuse detection、revocation、event redaction 和 Provider disposal。
- P0 包变更不改变现有 Remote signature、transport behavior、业务插件行为或已交付 bundle composition。

## 风险

- 过宽的通用生命周期 API 可能把 JWT 概念强加给 API key 和 local identity。按 capability 拆分操作并显式返回 unsupported，才能保持 credential kind 的差异。
- 进程私有 provenance 只能保护同进程调用，不能跨越 process boundary。后续 control-plane assertion 需要独立的签名 wire format 与 audience validation，接收 Host 校验后才能签发本地 call。
- Access-token 立即撤销与无状态验证冲突。Provider capability metadata 和文档必须说明真实撤销延迟，不能承诺更强行为。
- 只按 carrier syntax 建立 registry key 时，多个机制都使用 bearer token 会产生歧义。Evidence 提取必须选择已配置 authentication method 或 issuer route，不能依次试探 Provider。
- 延后 tenant scope 与 authorization 可以控制 P0 范围，但也意味着该包本身不能保护产品操作。在具体 Provider 和 transport Consumer 完成组合前，任何部署都不能声称已提供 authenticated access。
