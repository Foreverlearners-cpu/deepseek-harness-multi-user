# 多用户交付计划

[English](delivery-plan.md) | 中文

本计划安排多用户提案的工作顺序，使每个阶段建立后续阶段可以依赖的安全性质。它不是兼容性承诺或实现状态页。目标规则见[总览](README.md)、[身份与访问控制](identity-and-access.md)和[数据与运行时隔离](data-and-runtime-isolation.md)。

任何中间阶段都不是可部署的多用户服务。只有阶段 0 至阶段 5 的退出标准同时得到满足后，服务端 profile 才能向互不信任的用户开放；阶段 6 保持可选。

## 阶段 0：冻结威胁模型

在修改服务签名前，先定义受支持的部署模式：

- 本地模式具有一个显式 local principal、一个个人租户、受信任本地文件和本地执行提供方。
- 服务端模式具有已认证远程客户端、互不信任的租户、私有 session、租户运行时和容器级执行环境。
- 平台 operator 是运维管理员，不隐含租户内容或 secret 访问权。
- 协作 session、跨租户共享和自建密码认证不属于首个版本。

记录品牌类型 id、动作名称、公开 not-found 行为、审计要求、principal 撤销时限，以及哪些提供方符合服务端模式要求。增加组合不变量：如果服务端 profile 包含匿名传输、本地 secret 文件提供方、不受限制的 Host 文件系统提供方、本地 subprocess/PTY 提供方或 worker-thread code/workflow 引擎，则拒绝组合；只有部署显式声明受信任单租户模式时才能例外。

## 阶段 1：Identity 与控制平面

先增加提议的 `dsh-mysql` 基础设施服务，再为认证、授权、租户和审计增加完整能力族。认证包含 Service Definition、OIDC/service-token 提供方和传输消费方。授权包含策略服务、角色/成员关系提供方和受保护资源消费方。MySQL-backed 领域消费方拥有 identity、membership、role、token-metadata 和 audit schema；审计包含 append API、持久提供方和管理查询/export 消费方。

修改 Connection handler 和 Typert Host invocation，使其接收 `AuthenticatedCall`。HTTP 在 body 分发前认证，WebSocket 在升级前认证。进程内、测试、ACP 和 SDK 传输都必须提供显式 principal。保留 Host/Origin DNS rebinding 防护作为纵深防御；它既不创建 principal，也不能替代 CSRF 防护。

交付用户状态、租户、成员关系、角色、service account、token 撤销和运行时分配管理 API。只有这些方法能够独立执行策略后，才增加最小管理 UI。首个平台 operator 通过带外方式 bootstrap。

退出标准：没有 principal 时，任何服务端 endpoint 或事件流都不能打开；在两个租户中具有成员关系的用户不能选择未加入的租户；撤销在文档时限内阻止新调用；tenant 产品 Remote 无法访问 admin 方法。

## 阶段 2：租户所有的持久化

给 `SessionHeader`、session factory、持久化接口和两个本地 SQLite schema 增加不可变 tenant 与可判别 `SessionOwner` 元数据。增加基于 `dsh-mysql` 的服务端提供方 `dsh-session-persistence-mysql`。使用抗冲突 id 替代进程局部 session id。每条持久化 read/list/fork/export/repair 路径和 session-query 提供方都必须要求 tenant scope。

创建新的租户感知 schema version，不能在推断所有权后接受旧记录。增加独立 import 命令：它读取一个受信任单用户 store，在完整 dry-run 报告后写入选定个人租户。该命令分配所有权、重写物理位置、校验 attachment 引用，并可重启；服务端启动永远不执行隐式迁移。

按租户隔离 storage-domain unit 和 workspace registry 全局状态。增加 deployment/tenant/user settings 分层和有 scope 的 credential identity。引入由维护良好的 vault 或 secret service 支撑的服务端 credential 提供方。本地文件提供方只在本地组合中可用。

退出标准：使用其他租户有效 id 直接访问 persistence、storage-domain、settings、credentials、workspace、attachments 和 search 时不返回数据；所有写入都包含租户所有权；数据库约束阻止跨租户 event/session 和 workspace/session 引用。

## 阶段 3：API、事件流与实时状态隔离

修改 API Proxy 和业务 Remote 方法，使其在受保护资源所有者处接收访问上下文。所有远程代码可以访问的无 scope `get`、`list`、`describe`、resume、export 和 mutation 路径，都要删除或改成内部接口。授权发生在冷 session preparation 前，并在恢复后的 agent 发布前再次执行。

使用已认证订阅替换全 session mux/Host 事件流。根据已授权资源建立基线，并注册 tenant/session 级 listener。按租户设置 live agent map、prepared cache、resume 去重、retirement chain、pending approvals/questions、jobs、terminals、projection cache、title state 和 search state 的键，或者把它们完全放入一个租户运行时。Redis 可以承载 cache、lease、rate limit 和有 scope pub/sub；Elasticsearch 可以提供 tenant-scoped search，但两者都消费持久 MySQL outbox，并保持为可重建派生状态。

退出标准：不同租户的两个已连接用户不会收到对方的任何 frame、count、依赖时序的 queue 行为、pending interaction、workspace change 或 host event；成员关系删除会关闭或重新授权活跃事件流；重连不能恢复已撤销基线。

## 阶段 4：执行隔离

定义 `ExecutionLease`，并把 filesystem、subprocess、shell、terminal、LSP、code runtime、workflow、hooks、session command job 和每个 subagent 的执行能力调用路由到同一个 session 执行环境。Agent orchestration 可以留在租户运行时，但在服务端模式中没有访问 Host-local 执行提供方的路径。增加生产容器或微虚机提供方，具备有界 provisioning、资源 quota、network policy、短期 credential delivery、完整 process-tree teardown 和可观察完全停稳。

服务端组合永远不把任意 Host 目录或进程全局提供方 credential 挂载到执行环境。Workspace provisioning 产生已授权 volume 或 checkout。Spill、output file、PTY state、worker control file 和临时 upload 位于 lease 或租户/session 所有的对象存储内。

退出标准：模型代码不能读取 Host settings、控制平面 credentials、其他租户 volume、runtime control state 或其他 session 临时产物；取消和 runtime dispose 会撤销 credential，并且不留下可观察进程；quota 耗尽只影响所属 tenant/session。

## 阶段 5：管理与运维

把 quota accounting、retention、deletion、export、tenant suspension、runtime health、backup/restore、audit search/export 和 billing/usage projection 增加为分别授权的控制平面能力。内容删除通过一个持久删除 job 覆盖 session row、events、attachment references、spills、derived indexes、cached projections 和 execution artifacts；审计策略只保留必需删除事实。

使用带 request、tenant、runtime 和 resource id 的结构化运行日志。服务端模式默认禁用内容 telemetry。任何 prompt/tool 内容 export 都必须先有租户策略和用户告知。平台健康页面使用聚合或脱敏事实，不调用租户 transcript API。

退出标准：暂停租户不能启动新工作；重试和并发请求下 quota 仍正确；deletion 与 export 可重启且有 scope；restore 不能把数据放入错误租户；operator 工作流留下完整审计记录且不暴露 secret 值。

## 阶段 6：可选协作

只有私有多用户操作稳定后，才设计 session sharing。分别定义 reader、editor 和 approver 授权；标注每条人类编写的持久输入；串行化或仲裁并发 turn；定义成本和 credentials 所有者；明确撤销、fork、export 和通知行为。

部署不需要完成本阶段也可以称为多用户。推迟它可以避免把基本账号隔离与分布式协作编辑器耦合，也能防止 tenant admin 意外成为 execution approver。

## 验证矩阵

每条受保护验收路径都需要通过真实组装入口提供配对拒绝用例。仅单元测试不能建立多用户隔离。

| 区域 | 正向用例 | 必需负向用例 |
|---|---|---|
| HTTP 与 Typert | User A 在 tenant A 中调用已允许动作 | 缺失/过期 token、伪造 tenant 字段、user B resource id、直接调用较低层 Remote |
| WebSocket | User A 接收已授权基线和后续事件 | Tenant B create/event/workspace/approval 永远不进入 A 的事件流；撤销终止访问 |
| Persistence | A 创建、resume、fork、search、export 和 delete A 的 session | 已知 B id 在每项操作和 repair 路径上的失败都与 unknown id 相同 |
| Workspace/settings | A 读取和修改允许的 A scope | User section 不能覆盖强制 tenant policy；tenant B 变更不向 A 发出 invalidation |
| Credentials | 已授权适配器使用有 scope credential 且不暴露它 | Describe/use/manage 区分有效；模型进程和其他租户不能读取值或 source metadata |
| Attachments/spills | A 的 session 存储、读取、fork、export 和 delete 引用 | Digest、locator、复制事件、path traversal 和 stale signed URL 都不能跨越 tenant/session 所有权 |
| Approval/questions | Session owner 回答一个 pending request | 其他 member、admin、stale tab、replayed rpc id 和 revoked owner 不能回答 |
| Execution | A 只访问自身 workspace 和允许的网络 | Host files、tenant B volume、control files、ambient secrets、escaped child processes 和 quota spillover 被拒绝 |
| Admin/audit | 已授权角色变更 membership 并获取允许的 audit facts | Tenant admin 不能成为 platform operator，也不能通过 management API 读取 transcript/secret |

运行至少包含 tenant A 中 user A 与 B、tenant B 中 user C，以及一个 platform operator 的 keyless e2e 场景。使用其他租户的有效 id，而不是随机不存在 id，确保每项测试证明授权而不仅是 not-found 处理。覆盖本地与远程传输、cold resume、fork、search、stream reconnect、pending interaction、attachment resolution 和 cancellation。

产品可见的认证、拒绝、管理和 session 行为需要依据仓库测试策略通过真实可运行 snapshot 覆盖。安全测试还要检查服务端观察结果，证明禁止的 handler、persistence read、event enqueue、vault resolution 和 execution allocation 从未被触达。

## 数据迁移与回滚

仓库的 pre-release 立场允许拒绝旧持久格式。租户所有权会改变 session header、SQLite key、JSONL root、storage-domain state、settings、credentials 和 attachment reference，因此旧 store 永远不能被当作属于第一个已认证调用方来打开。

Importer 写入新目标，并保持源不变。Manifest 记录 source identity、target tenant、counts、content hashes、assigned ids、omitted records 和 completion。验证阶段通过普通提供方打开目标，并在切换流量前比对每个 imported header/event/reference。只有部署仍处于本地单用户模式时，rollback 才能把路由切回未改源；多用户写入不能回滚进没有所有权信息的 store。

## 实现前必须决定的问题

- 支持的 identity provider、token lifetime、revocation bound 和 CSRF strategy。
- Audit outbox、跨运行时 idempotency、reconciliation 和 failure-reporting 语义。
- Tenant runtime granularity 与 scheduler：推荐首个实现为每个 tenant 一个 process/container。
- MySQL driver 与 topology、Redis 和 Elasticsearch provider、outbox delivery、secret-vault provider、backup objectives、regions 和 retention requirements。
- Session privacy policy、administrative deletion authority，以及是否存在 break-glass content access。
- Execution provider 对 process identity、network egress、secret delivery、teardown、storage cleanup 和 cost quota 的保证。
- User 与 tenant settings 是否在每个 namespace 共用一个 schema，还是需要独立 policy/preference declaration。
