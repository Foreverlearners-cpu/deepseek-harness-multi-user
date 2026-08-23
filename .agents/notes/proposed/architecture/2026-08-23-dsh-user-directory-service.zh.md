# Agent Note: dsh-user 用户目录服务

Status: proposed

[English](2026-08-23-dsh-user-directory-service.md) | 中文

## 问题

认证提供方、租户成员关系服务、会话资源所有者、管理工具和审计消费方需要一个稳定的人类账号标识，以及一个权威的账号生命周期状态来源。邮箱地址、用户名、显示名称、外部 identity、匿名遥测 id、credential 和 session id 各自具有不同的所有权和变化规则，因此都不能替代该标识。

如果一个包同时包含用户记录、密码哈希、Token session、MySQL 查询或进程全局当前用户，账号生命周期就会与 credential 机制、存储后端和请求载体耦合。给既有 Session、Agent 或 RPC payload 类型增加 `userId`，也会让无关包依赖账号 identity，并可能允许调用方提交用于限定自身数据范围的事实。

仓库需要先提供一个与提供方无关的用户目录服务，再增加 MySQL 提供方或具体登录机制。该服务必须定义账号 identity、生命周期、扩展数据、并发、失败和提供方义务，同时不创建数据库 schema，也不声称用户已经通过认证或获得授权。

## 提案

增加 `@deepseek-ai/dsh-user`，作为人类用户记录的 Service Definition。它负责带品牌类型的 `UserId`、不可变记录字段、生命周期操作、与提供方无关的失败、有界 live event 和共享提供方一致性测试套件。部署只挂载一个 Service Provider，例如后续的 `dsh-user-mysql`，向 `ctx.users` 提供实现。

`dsh-user` 不提供生产回退，也不依赖 MySQL、Redis、JWT、HTTP、Session、tenant、authorization 或密码包。它可以依赖 Cordis、仓库的带品牌 id 工具和与提供方无关的 JSON value 工具。仅挂载 `dsh-user` 不会创建用户、认证请求或改变任何既有产品路由。

该目录只表示人类账号。Service account 保持为另一种 principal，因为二者的所有权、credential、审批行为和生命周期不同。稳定的内部 `UserId` 与[多用户参考](../../../../docs/multi-user/identity-and-access.md)中的 identity 模型一致：登录标识或个人资料变化永远不会改变该 id。

## 用户记录

拟议的公共记录包含以下字段：

| 字段 | 含义 |
| --- | --- |
| `userId` | 由提供方生成、永不改变且永不分配给另一账号的带品牌 identity。 |
| `displayName` | 可选的面向用户资料标签；它不是登录标识或授权事实。 |
| `status` | 封闭的生命周期值：`active`、`disabled` 或 `deleted`。 |
| `createdAt` | 由提供方选择的非负 Unix epoch 毫秒创建时间。 |
| `updatedAt` | 最近一次已提交变更的非负 Unix epoch 毫秒时间。 |
| `revision` | 每次提交变更都会递增的单调乐观并发值。 |
| `extensions` | 用于带命名空间、非敏感、非权威附加数据的有界 JSON 对象。 |

提供方生成 `UserId`；创建请求不能选择它。该 id 遵守仓库的带品牌 id 规则，且不得与 `AnonymousUserId`、邮箱地址、用户名或上游 OIDC subject 混用。导入账号需要独立的可信导入消费方，而不是允许公共创建操作接受任意 id。

`displayName` 可以不存在，也可以改变。用户名、邮箱地址、电话号码、OIDC issuer-subject 组合、密码 verifier、API key、角色、租户成员关系、偏好设置和 credential 都不是用户记录字段。拥有这些能力的服务可以把它们映射到 `UserId`，而无需改变目录记录。

## 目录操作

Service Definition 暴露 `create`、`get`、`requireActive`、`update`、`disable`、`enable`、`delete` 和 `list`。每个提供方都必须保持以下语义：

- 创建操作校验资料输入、生成新的 `UserId`、以 `active` 状态开始、初始化 revision，并返回已提交记录。
- 获取操作返回一条记录或显式缺失结果，且不改变生命周期状态。
- 要求 active 只为 `active` 返回当前记录；缺失、已禁用和已删除记录产生不同的内部失败代码。
- 资料更新只改变 `displayName` 和 `extensions`，要求预期 revision，并返回新的已提交 revision。
- 禁用只接受 `active`；启用只接受 `disabled`；两者都要求预期 revision。
- 软删除接受 `active` 或 `disabled`，产生终态 `deleted`，且永不移除或重新分配该 `UserId`。
- 列表查询使用有界 limit 和不透明 cursor，并可按 status 过滤；它永不暴露 credential 或提供方诊断。
- 变更可携带可信的 `actorUserId`、原因和关联元数据，供审计消费方使用。这些元数据不证明授权；调用目录前，业务服务检查用户自助修改字段策略或管理员 RBAC。

传输消费方决定哪些内部失败需要折叠成相同公共响应，以免暴露账号探测信息。`dsh-user` 不定义 HTTP 状态码、RPC 错误或管理权限。

## 生命周期与并发

允许的 status 转换为 `active -> disabled`、`disabled -> active`、`active -> deleted` 和 `disabled -> deleted`。`deleted` 是终态。重复转换不会静默成功：提供方报告稳定的状态冲突失败，调用方必须在自己的请求边界主动实现幂等。

每次变更都会比较 `expectedRevision` 与当前记录，并原子提交新数据和递增后的 revision。陈旧 revision 产生 `revision-conflict`，且不会部分改变资料、status、时间戳、extensions 或 event。提供方使用自身可信时钟确定时间；调用方不能写入 `createdAt`、`updatedAt` 或 `revision`。

该包为无效输入、缺失、非 active 状态、无效转换、revision 冲突、提供方不可用和意外提供方失败定义稳定失败。存储特有错误代码、SQL 文本、连接信息和记录存在性诊断永远不会越过服务 API。

## Extensions 约定

`extensions` 是 JSON 对象，而不是 JSON 编码字符串。空值为 `{}`。数组、标量、非 JSON 值、循环对象、带 prototype 的对象和超过导出字节限制的值会在持久化前被拒绝。固定的 L1 限制保证提供方行为可互换；如果后续提案没有先改变共享约定，单个提供方不得接受更大的记录。

键使用包或组织命名空间，例如 `dsh-user/locale` 或 `example/register-source`。提供方在读取和无关更新中原样保留未知键。更新只能通过显式操作替换或修补 extensions；读取后再写入记录时，不得丢弃其他消费方拥有的附加数据。

Extensions 永远不包含 credential、密码材料、Token、签名密钥、角色、租户成员关系、停用状态、登录标识、授权决策，或用于唯一性和索引查询的字段。一项值一旦与安全相关、受约束、经常查询或拥有独立所有者，就必须移入类型化字段或其他服务，而不能继续留在 extensions 中。

## Event 与消费方

变更提交后，服务发出等价于用户创建、资料更新和 status 变化的有界 live event。Event 包含 `userId`、已提交 revision、status、event time，以及可用时由调用方提供的操作者、原因和关联元数据。它们不包含 `displayName`、`extensions`、登录标识、credential、传输 evidence 或提供方诊断。

这些 event 是用于审计、缓存失效和投影的进程内集成事实。它们不是 Session event，不进入模型可见回放，也不替代持久化提供方拥有的 durable transactional outbox。无法原子发布外部 event 的提供方在自身事务中记录 outbox，并由独立消费方投递。

`dsh-auth` 只在 credential 验证识别出 `UserId` 后消费该目录；签发或接受账号 credential 前，它要求用户处于 `active`。Authenticated call 仍由 `dsh-auth` 拥有，并按多用户架构显式传递；`dsh-user` 不暴露全局当前用户。租户成员关系、authorization、session 所有权和安全审计消费方使用 `UserId`，但保留各自状态和决策。

## 提供方所有权

`dsh-user` 不拥有表、migration、文件、缓存、环境变量或网络客户端。后续 `dsh-user-mysql` 提供方将拥有物理 `dsh_users` 与 schema 状态表、索引、事务、migration 版本和 MySQL 错误分类。其 schema 提案必须实现此记录和生命周期约定，而不能把 credential 所有权加入目录。

密码或本地登录提供方拥有登录标识和密码 verifier 表。JWT 提供方拥有 refresh-token family 与认证 session。审计提供方拥有仅追加安全记录。既有 conversation persistence owner 保留 session 与用户关系。这种所有权防止 `dsh-user-mysql` 变成通用认证数据库。

共享一致性测试套件针对每个提供方实现运行。它覆盖 id 品牌与唯一性、生命周期转换、终态删除、乐观并发、extension 校验与保留、cursor 稳定性、event 时机与脱敏、失败规范化和提供方 dispose。提供方特有测试另外覆盖其持久性与 schema 行为。

## 备选方案

**让 `dsh-auth` 拥有用户 CRUD。** 否决，因为 authenticated-call provenance 与 credential 生命周期会独立于账号资料和生命周期变化。保持目录独立，也允许管理、导入、tenant 和审计消费方在不解析认证 evidence 的情况下使用用户。

**把用户名、密码哈希和 refresh token 放入用户记录。** 否决，因为登录标识可以有多个且可变，而 credential 具有安全特有的轮换、脱敏、泄露与存储规则。它们的 schema 和提供方必须能够在不改变用户目录的情况下演进。

**把 `UserId` 定义为 `string` 别名。** 否决，因为匿名关联 id、service account、tenant、session 和上游 subject 也都是字符串。带品牌 id 可以防止在类型化同进程边界意外替换。

**把 extensions 存成 JSON 字符串。** 否决，因为每个提供方都需要第二层解析，并且可能持久化无效 JSON。服务接受 JSON 对象，存储提供方在可用时使用原生结构化表示。

**给 Session、Agent 和 RPC payload 类型增加 `userId`。** 否决，因为无关核心包会产生 identity 依赖，并且 wire 调用方可以提交所有权声明。资源消费方显式接收 authenticated context，并自行验证已存储的所有权。

**暴露异步局部或进程全局当前用户。** 否决，因为并发请求、后台工作、嵌套调用和提供方回调可能观察到错误 identity。目录接受显式 id；认证 context 仍由传输与认证组合拥有。

**在 `dsh-user` 中包含租户成员关系和角色。** 否决，因为一个用户可能属于多个 tenant，并且成员关系可以独立于账号状态变化。`dsh-tenant` 和 `dsh-authority` 拥有这些记录和决策。

## 验收标准

- 该包定义带品牌 `UserId`、用户记录、status 生命周期、extension JSON 规则、与提供方无关的操作、稳定失败类别、有界 event 和提供方一致性测试套件。
- 该包不导入 credential、认证实现、authorization、tenant、Session、transport、数据库、缓存或搜索包，也不打开外部资源。
- 用户创建在挂载的提供方内部生成 id；资料与 status 变更必须使用乐观并发；已删除 id 是终态且永不复用。
- Extensions 只接受有界 JSON 对象，保留未知带命名空间键，并且不能携带 secret 或权威 identity、生命周期、tenant 或 permission 字段。
- 提供方 event 仅在提交后发生，并排除 extensions、credential、登录标识和诊断；它们永不进入 Session event log。
- 聚焦测试覆盖每种生命周期转换与拒绝、陈旧并发变更、extension 校验与保留、cursor 分页、event 脱敏和提供方 dispose。
- 仅增加 `dsh-user` 时，既有 Session、Agent、AgentLoop、API Proxy、RPC payload、persistence 和已交付 bundle 行为保持不变。
- MySQL schema、登录标识、密码验证、JWT session、租户成员关系、authorization 和产品路由集成保留为具有独立所有者的后续变更。

## 风险

- 如果目录 API 只围绕首个 MySQL 提供方设计，可能泄漏 SQL 分页、时间戳或事务假设。不透明 cursor、提供方拥有的时钟和共享一致性测试套件必须保持 L1 行为与提供方无关。
- 不同的内部非 active 状态失败有助于管理，但如果直接映射为公共登录响应，可能泄漏账号是否存在。认证与传输消费方必须在需要抵抗枚举时折叠这些失败。
- 如果消费方把需要查询或与安全相关的数据放入 extensions，通用扩展可能变成未经评审的 schema。固定限制、命名空间规则、secret 禁令和类型化字段提升规则需要通过评审执行。
- 软删除会保留引用和可审计性，但本身无法满足未来物理擦除策略。擦除与保留需要独立的跨领域工作流，协调 credential、tenant、conversation、attachment 和 audit owner。
- Service Definition 与每个提供方拆分会增加包和组合数量。这种拆分刻意保证存储与 credential 选择不会修改账号消费方，但 starter 包必须让有效组合保持简单。
