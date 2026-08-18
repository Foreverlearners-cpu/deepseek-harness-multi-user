# Agent Note: 多用户控制平面与数据平面

Status: proposed

[English](2026-08-18-multi-user-control-and-data-planes.md) | 中文

## 问题

已交付的 Web 组合是本地单用户产品。其 Host/Origin 检查可以防止浏览器 rebinding，但明确不负责调用方认证。Session、workspace、settings、credential、事件流和 live-agent 服务都假定只有一个 Harness home 和一个可信 operator。本地文件系统策略允许读取，而 subprocess、terminal、LSP server、code worker 和 workflow worker 使用 Host OS 用户权限执行。

只在 HTTP route 增加登录，会让传输层以下的授权仍未定义。知道 `SessionId` 的调用方仍可能访问 persistence、resume、fork、search、event delivery、attachments、pending approvals 或较低层 Remote 服务，除非每个资源所有者都收到已认证上下文。只给持久化存储增加租户过滤，会留下全局 live map 和全 session 事件流。在一个进程中处处增加过滤，仍会让互不信任的模型代码处于同一个 Host 账号下，而当前本地提供方不是安全边界。

产品需要一项支持多个用户的基础设计，同时不能削弱本地 profile、混淆 replay log 与 audit ledger，也不能强迫首个版本实现协作 session。

## 提案

把多用户部署拆成控制平面、租户级 Harness 运行时和 session 执行环境。详细参考见 [docs/multi-user](../../../../docs/multi-user/README.md)。

控制平面拥有认证、内部用户与租户 identity、成员关系与角色、service account、策略决策、管理、quota、runtime routing 和仅追加安全审计服务。浏览器认证委托给 OIDC；自动化使用有 scope 的短期 token。本地 profile 构造显式 local principal 和个人租户。服务端 profile 在没有挂载认证提供方时启动失败，并且不存在 loopback 或 trusted-host 认证旁路。

每项受保护传输调用都在 API Proxy 或 Typert 分发前转换成不可变 `AuthenticatedCall`。它携带 request id、principal、authentication method、cancellation signal，以及可判别的 tenant 或 platform scope。Tenant scope 包含 active tenant 与 membership；platform scope 只由控制平面管理方法接受。受保护服务方法显式接收该上下文。请求 payload 不能建立自身 actor 或 tenant，进程内传输也使用相同调用路径。

策略与资源所有权都不可缺少。策略服务决定 session read、steer、approve、export、workspace manage、credential use/manage 和 membership manage 等动作。资源所有者执行租户级查找，并在内容、存在性、数量或事件离开服务前验证 session/principal 所有权。跨租户有效 id 与不存在 id 对外返回相同 not-found 结果。

Session header 增加由 session factory 写入的不可变 tenant 与可判别 owner-principal identity。Session 可以由人类用户或 service account 所有。Persistence、query、workspace、settings、credentials、attachment references、projections、search、caches、event subscriptions、approvals、jobs、terminals 和 live-agent registries 全部变为租户级。Session id 仍是不透明抗冲突标识符，但任何组件都不能把不可猜测性当作授权。现有无所有权持久格式直接拒绝；独立一次性 importer 写入新的租户所有 store。

MySQL 通过提议的 `dsh-mysql` 基础设施服务成为服务端关系数据权威存储。`dsh-mysql` 拥有具名 pool、transaction、migration coordination、health 和 classified failure；identity、会话持久化、settings、audit 和其他领域消费方拥有自身表与查询。Redis 承载可丢弃 cache 与协调状态，Elasticsearch 承载可重建 search projection。Transactional MySQL outbox 驱动两者，因此任何一个系统都不会成为 authorization 或 replay authority。

Session 事件日志仍是模型可见行为的 replay 真源。安全审计记录使用独立存储，包含 actor、tenant、action、resource identity、decision、outcome、request id、time 和有界 metadata，不含 authentication token、credential value 或 message/tool body。只有当共享 session 行为需要重建某个人类编写事实时，人类 actor 标注才进入 session 日志。

首个版本中的 session 只归其 owner principal 私有。租户角色管理 membership、workspace policy、retention、suspension 和其他显式管理动作；它们不隐含 transcript 读取或 execution approval。Service-account 所有的 session 不能使用 service identity 充当人类批准响应。协作 read/write/approve grant 和并发 turn ownership 延后设计。

一个租户运行时拥有一个插件组合和租户级提供方。首个服务端部署使用每个租户一个进程或容器；只有每个内存 registry、cache、listener 和 provider client 都完成分区后，才允许一个运行池托管多个运行时实例。该运行时边界限制应用过滤遗漏的影响，但不能替代资源授权。

每个模型控制 session 从容器或微虚机提供方获取隔离 execution lease。Filesystem、subprocess、shell、PTY、LSP、code、workflow、hooks、jobs 和 subagent execution 全部路由到同一个 lease。本地提供方和 worker-thread/`node:vm` 引擎继续供可信本地 profile 使用，并被服务端组合不变量拒绝。执行环境接收已授权 workspace mount 和短期 task credential，永远不接收 Host root 或控制平面 secret。

## 备选方案

**给每个 RPC payload 增加 `userId` 或 `tenantId`。** 否决，因为这会让调用方自行声明为其授权的事实。可信租户身份来自认证与成员关系，并且必须到达 wire DTO 之外的资源所有者。

**只在 Connection 认证，业务服务保持不变。** 否决，因为 API Proxy、Typert Remote 方法、persistence preparation、事件流和进程内调用方都有独立的受保护资源访问路径。只有传输检查无法约束这些路径。

**在一个共享 Cordis context 中运行所有租户，并使用过滤后的 store。** 首个实现否决，因为 live map、reconnect baseline、event queue、cache、temporary file 和 provider service 同样需要分区，而本地执行仍共享 Host 权限。相同约定得到证明后，后续运行池可以托管独立租户运行时实例。

**每个用户运行一个完整 Harness 进程，然后停止扩展。** 这对私有用户是安全的，但会让 organization policy、tenant credentials、shared workspaces、administration 和 aggregate quota 变成外部收集的一组无关 home。每租户一个运行时保留清晰管理单元，同时 session 仍保持用户私有。

**把 session 事件日志当作安全审计日志。** 否决，因为 session 日志用于重建模型可见行为，并且会被 fork/replay 复制。Authentication failure、role change、secret administration 和 operator action 具有不同读者、retention 和 redaction 规则，不能进入模型 history。

**让每个领域插件打开自己的 MySQL pool。** 否决，因为 identity、session、settings 和 audit 实现中的 connection lifecycle、bootstrap secret、timeout、migration locking、failure classification、observability 和 shutdown 会产生差异。一个仅供 Host 使用的基础设施服务拥有这些机制，领域 service 继续保留数据所有权。

**只通过现有 KV storage backend 暴露 MySQL。** 否决，因为 KV form 明确缺少跨表事务、二级索引和多段 key。它可以通过可选 adapter 继续使用，但认证与会话持久化通过 `dsh-mysql` 上的专用领域消费方实现。

**在 Harness 内构建密码认证。** 否决，因为维护良好的 OIDC 提供方拥有密码存储、MFA、恢复、federation 和 compromise response。Harness 消费已校验 identity，并拥有产品授权。

**把 `workspace-write`、worker thread 或 E2B 名称视为足够租户隔离。** 否决，因为本地文件策略允许读取，worker thread 与 `node:vm` 共享进程权限，而当前 E2B 包记录了 control-channel 和 same-UID 限制。服务端组合要求提供方保证满足执行威胁模型。

## 验收标准

- 服务端 HTTP、WebSocket、SDK、ACP、进程内和 Typert 路径产生相同已认证调用上下文，并拒绝缺失、过期、已撤销或错误 audience 的凭据。
- 每项持久和实时资源都有唯一 tenant owner；session 工作具有唯一 owner principal；所有 list、search、count、resume、fork、export、stream、attachment、approval 和 mutation 路径都在披露前强制执行这些所有权。
- 有效跨租户 id 不返回资源数据，并且不会触发 scoped index 以外的 persistence read、event enqueue、vault resolution、agent resume 或 execution allocation。
- Tenant A 与 tenant B 可以并发运行，且不会接收对方的事件、pending interaction、workspace change、cache entry、temporary artifact、telemetry content 或 execution effect。
- 服务端模型执行不能读取 Host 配置、控制平面 credentials、其他租户存储或其他 session execution state，并且 teardown 在有界时间达到完全停稳。
- Session replay 保持无损，模型可见输入仍被记录；authentication 与 security-audit 数据不进入模型 history。
- 本地 Web、headless 和 automation profile 通过显式 local principal 继续工作，无需挂载服务端专属控制平面依赖。
- Keyless assembled test 使用至少两个租户中的真实有效 id，并覆盖 HTTP、events、persistence、cold resume、fork、search、attachments、approvals、execution、revocation 和 administration。

## 风险

- 控制平面/数据平面拆分会引入 routing、lifecycle、versioning 和 operational failure mode。水平扩展前，需要为 signed forwarding assertion、runtime health、retry 和 request/audit idempotency 定义显式约定。
- 每租户一个 runtime 可能消耗大量内存和启动时间。Pooling 属于后续优化，但过早 pooling 的压力可能在分区得到证明前重新引入共享状态泄露。
- 给许多服务方法增加授权上下文，可能诱发包装层或重复检查。每项资源必须保留唯一有 scope owner API，由 adapter 投影到它，而不是创建不受保护的 sibling。
- MySQL、Redis、Elasticsearch、vault 和 container provider 会增加生产依赖与跨系统恢复成本。在本地 profile 中保留 SQLite、file credentials 和 local execution，可以避免这些成本泄漏到受信任单用户使用场景。
- 管理支持请求可能推动隐式 transcript 访问。角色模型必须把 operational control 与 tenant content access 分离，任何未来 break-glass path 都要显式且可审计。
- Import 横跨 session logs、workspace accounts、settings、credentials、attachments 和 derived indexes。部分或隐式 migration 可能把数据分配给错误租户，因此 import 写入独立目标，并在 routing 变更前完成校验。
