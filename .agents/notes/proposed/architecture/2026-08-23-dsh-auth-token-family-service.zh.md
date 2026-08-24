# Agent Note：dsh-auth-token family 服务

Status: proposed

[English](2026-08-23-dsh-auth-token-family-service.md) | 中文

## 问题

JWT 和其他 bearer-token Provider 需要 refresh-token 轮换、泄露检测、principal 范围撤销和安全检查。让每种 Token 格式分别实现该状态机会重复并发与脱敏规则；把它放入 `dsh-auth` 则会把进程内 evidence 验证与持久 Token 状态耦合。

Refresh secret 是 bearer Credential。持久化明文或非原子的消费替换操作可能暴露整个 family，或让两个并发轮换同时成功。共享服务必须定义 Provider 的提交义务，但不拥有 JWT 编码、HTTP 传输或数据库。

## 提案

新增 `@deepseek-ai/dsh-auth-token`，作为 `ctx.authTokens` 上的 Host-only Service Definition。它拥有高熵不透明 refresh-secret 生成、SHA-256 digest 派生、family 记录、校验、稳定失败、提交后脱敏事件和共享 Provider 套件。它复用 `dsh-auth` 的 `AuthenticatedPrincipal`、`AuthenticationRequestId`、`CredentialId`、`TokenFamilyId` 和 `UserId`，不重复声明身份类型。

公开操作为 `issueFamily`、`rotate`、`inspect` 和 `revoke`。JWT Provider 独立拥有 access-token 签名与验证，并可通过 `dsh-auth` 的 Credential 生命周期能力公开这些操作。后续 MySQL Provider 拥有 schema、事务、锁、索引、migration 和事务 outbox。

JWT 组合具有明确的失败边界。`issueFamilyWithPreparation` 和 `rotateWithPreparation` 允许 JWT Provider 在持久化 Provider 构造并锁定候选记录之后、修改持久状态之前，通过 Host-only callback 签名 artifact。Callback 失败时不会留下已签发 family，或会让当前 refresh Credential 保持 active。本包自身不执行 JWT 签名。

## Secret 处理

基类使用至少 32 个随机字节生成每个 refresh secret。明文只作为短期输入或返回值存在。Provider hook 只接收固定 SHA-256 digest；持久记录、检查、事件、错误和诊断都无法表示明文。SHA-256 适用于这里，因为 Token 至少有 256 bit 均匀熵，并非用户选择的密码。Provider 建立 digest 唯一索引，也不记录 digest。

Refresh-token 输入在散列或执行 Provider 工作前限制为最多 4 KiB UTF-8 数据。

## 状态、revision 与过期

`TokenFamilyRecord` 具有 `active` 或 `revoked` 状态、绝对过期时间和单调 revision。Revision 从 1 开始，每次轮换或首次撤销提交后增加一次。重复撤销保持幂等。Revision 用于排序审计与缓存变化；公开撤销不要求 expected revision，因为紧急失效必须能跨越并发轮换。

`RefreshCredentialRecord` 具有 `active`、`rotated` 或 `revoked` 状态，以及签发、过期、轮换、替代和撤销事实。Family 过期时间在签发时确定。每个替代项都从 Provider 事务内读取的 family 记录继承完全相同的过期时间；不透明 refresh 值既不披露持久 family 状态，也不允许调用方选择该状态。

## 原子轮换与复用

Provider 在一个事务中锁定 digest，检查 family 与 Credential 的过期时间和状态，构造已消费记录与替代记录，并调用 Host preparation callback。只有 callback 成功后，它才能消费 active Credential、插入 active 替代项、增加 family revision 并提交。基类在 preparation 前校验候选项，并要求返回 commit 与已准备候选项完全相同。

匹配 rotated digest 就是复用。Provider 在同一事务中撤销 active family 与所有 active Credential，记录 `refresh-token-reuse`，增加 revision，并返回 reuse commit。基类发出 `reuse-detected`，然后抛出 `refresh-token-reused`。已撤销 family 失败时不再改变 revision。

未知、过期、复用和已撤销状态有不同内部错误 code。传输 Consumer 可以在公开区别会帮助探测时折叠它们。

## 检查、撤销与事件

检查以 refresh Credential、family 或 principal 为目标，并从结果中移除 digest。返回记录必须能证明绑定到该目标。以 Credential 为目标的撤销会撤销其 family，因为保留 sibling refresh Credential 会违反 family 泄露语义；其 commit 还包含匹配的 Credential，作为 Credential 与 family 关系的证明。Principal 撤销在一个 Provider 事务中修改所有 active family。

`auth-token/changed` 只在签发、轮换、显式撤销或复用撤销提交后发出。它携带稳定 id、principal、revision、status、time 和 reason，不包含 secret、digest、access token、claim 或 Provider 诊断。所有监听器失败（包括 invariant 失败）都会在提交后被记录并隔离；持久审计需要 Provider 拥有的事务 outbox。

## 考虑过的替代方案

**把 refresh 状态存入 `dsh-auth`。** 拒绝，因为 evidence 验证和 `AuthenticatedCall` 来源是进程内机制，而 refresh family 需要持久事务与独立泄露策略。

**让每个 JWT Provider 实现轮换。** 拒绝，因为 Token 编码不会改变一次性 refresh 状态机，重复实现会在复用与脱敏上漂移。

**持久化加密 refresh secret。** 拒绝，因为验证只需要比较，不需要恢复。高熵值的 digest 限制泄露并移除加密密钥生命周期。

**让轮换调用方选择替代项过期时间。** 拒绝，因为不透明 refresh 值不披露 family 过期时间，调用方无法在没有额外查询 key 的情况下选择有效边界。调用方选择的过期时间还可能意外缩短 family，或允许滑动续期。Provider 在持有轮换锁时复制固定的 family 过期时间。

**撤销要求 expected revision。** 拒绝，因为并发轮换不能阻止管理员或泄露处理触发的失效。

## 验收标准

- Provider hook 只接收 refresh digest，不接收明文 secret。
- 轮换保持原子；并发使用只能有一个成功。
- 复用在返回稳定失败前原子撤销 family。
- Provider commit 会校验 family revision 与绝对过期语义。
- 检查和撤销结果绑定到其请求目标。
- 提交后的监听器失败绝不会让生命周期操作失败。
- JWT 组合在 Provider 事务内准备签名；preparation 失败时不提交新状态。
- 检查和事件排除 secret、digest、access token、claim 与诊断。
- 撤销支持 Credential、family 和 principal 目标，并保持幂等。
- 共享套件覆盖签发、轮换、复用、过期、检查、脱敏和撤销。
- 该包不导入 JWT 实现、传输、MySQL、Session、tenant 或 authorization 包。

## 风险

- 抽象 hook 无法证明后端事务隔离；除共享套件外，每个 Provider 还需要真实并发事务测试。
- 进程内事件不能保证持久审计投递；有此要求时持久化 Provider 需要事务 outbox。
- 如果直接映射给恶意客户端，不同内部失败会泄露状态；传输适配器拥有错误折叠策略。
- Digest 安全依赖生成熵；Consumer 不能把密码或低熵值作为 refresh token 提交。
