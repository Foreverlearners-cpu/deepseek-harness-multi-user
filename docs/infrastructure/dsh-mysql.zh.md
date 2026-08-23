# dsh-mysql 基础设施提案

[English](dsh-mysql.md) | 中文

本文定义规划中的完整 Host 能力 `@deepseek-ai/dsh-mysql`。已经交付的仅连接阶段见 [`dsh-mysql` 包 README](../../packages/multi/mysql/README.md)。该服务是 identity、tenancy、会话持久化、settings、audit 和其他关系数据领域的基础设施依赖；它不是模型工具或会话专用存储。

## 范围

`dsh-mysql` 拥有 MySQL 连接、连接池生命周期、事务执行、schema migration 协调、健康状态、错误分类和数据库可观测性。领域插件拥有自身表、查询、授权、retention 和数据解释规则。调用方不能仅凭一个 database binding 名称获得会话或 identity 访问权。

首个包可以同时包含 MySQL Service Definition 与 Service Provider。只有第二种实现证明存在不会掩盖方言、migration 或失败差异的公共 API 后，才提取提供方无关的关系数据库包。消费方只在可信 Host 组合内部依赖 `dsh-mysql`。维护者文档包含从 Typert 派生的 API，而面向模型的 Cordis 目录、API Proxy、工具、动态包和执行环境都不公开该服务。

该插件不贡献提示词、工具 schema、消息或模型可见数据。会话恢复仍由 `SessionPersistence` 实现负责，因此模型可见输入继续来自会话事件日志，而不是数据库服务。

## 包位置

下列包名描述提案中的所有权划分。每个领域消费方保留现有公开能力，只把 `dsh-mysql` 当作内部驱动。

| 提议包 | 角色 | 拥有的数据或 API |
|---|---|---|
| `@deepseek-ai/dsh-mysql` | MySQL Service Definition 与 Service Provider | 具名 bindings、连接池、连接、事务、migration catalog、健康状态和错误 |
| `@deepseek-ai/dsh-session-persistence-mysql` | 消费方与 `SessionPersistence` 提供方 | 会话 header、仅追加事件记录、恢复、revision 和列表 |
| `@deepseek-ai/dsh-auth-mysql` | 消费方与 identity/tenancy 提供方 | Principals、外部 identity、tenants、memberships、roles、service accounts 和 token metadata |
| Settings、workspace、audit 和 jobs 的领域 MySQL 插件 | 领域服务背后的消费方 | 领域表、有 scope 查询、retention 和 outbox 记录 |
| `@deepseek-ai/dsh-storage-mysql` | 可选 `StorageBackend.kv` 消费方 | 供不需要关系查询或跨表事务的领域使用现有简单 KV 形式 |

现有 [`dsh-storage` 后端](../../packages/storage/storage/README.md)暴露不透明 KV unit，而 [`storage-domain`](../../packages/storage/storage-domain/README.md)明确没有跨表事务、二级索引或多段 key。`dsh-storage-mysql` 可以实现该窄接口，但认证与会话持久化不能被迫通过它。现有 [`SessionPersistence` 服务](../../packages/session/session-persistence/README.md)继续拥有会话约定。

## 服务模型

提议服务是具名 database binding 的注册表。一个 binding 拥有一个连接池和一个数据库目标；控制平面与租户运行时组合可以使用不同 binding、credential 或 MySQL 部署，而无需修改领域代码。

```text
ctx.mysql
  binding(bindingId) -> MysqlBinding

MysqlBinding
  connection(options, callback)
  transaction(options, callback)
  migrate(owner, manifest, mode)
  health(signal)
```

`connection` 与 `transaction` 只在 callback 执行期间租用 driver connection。Callback 结束后不能保留该 connection、statement 或 transaction-scoped value。Binding 在 dispose 期间停止新租用，在配置的 shutdown 时限内等待已接纳 callback，销毁状态不确定的 connection，并在 dispose 完成前关闭连接池。

每个领域插件通过已校验 Cordis 插件配置选择 binding。Binding 缺失、binding 名称重复、server capability 不受支持、pool 限制无效或数据库不可用时，插件启动失败。Binding 在包边界保持显式；进程全局默认值不能静默把一个领域重定向到其他数据库。

## 配置与 bootstrap

所有随部署变化的值都属于已校验配置，而不是插件常量。

| 配置区域 | 必需行为 |
|---|---|
| Endpoint 与 database | 根据 host 或 socket、port 和 database name 解析唯一明确的数据库目标；校验预期服务端能力，并拒绝有歧义或不完整的目标 |
| Bootstrap identity | 解析部署提供的 user 与 secret，并且不能读取存储在同一 MySQL 部署内的租户 credentials |
| TLS | 服务端 profile 校验 server identity；plaintext 或跳过校验只允许显式 trusted-local profile 使用 |
| Pool | 配置最小/最大连接数、acquisition timeout、idle lifetime 和 shutdown bound |
| Execution | 配置 query timeout、支持的 transaction isolation level、UTC session time zone、`utf8mb4` 和必需 strict SQL behavior |
| Migration | 选择 `validate` 或 `apply`、migration-lock timeout，以及与 runtime credential 不同时使用的 migration-capable binding |

MySQL password 是 bootstrap secret。服务端部署在 MySQL-backed credential storage 存在前，通过 orchestrator 或维护良好的 secret service 注入它；租户 credential 记录不能用来 bootstrap 自身数据库。Diagnostics 和已解析配置永远不暴露 password、包含 secret 的 connection URI、TLS private key 或 query parameter。

生产 runtime credential 只获得必需 DML 权限。专用 migration 组合使用 DDL 权限，并在 schema 校验后移除。本地 profile 只有在配置显式接受较弱运维隔离时，才可以合并这两种角色。

## 事务与失败语义

- Transaction callback 在 commit 或 rollback 完成前使用同一个 connection。嵌套调用只能加入显式传入的 transaction，否则拒绝；不能静默打开独立 transaction。
- Transaction 成功返回表示系统已收到 `COMMIT` 确认。Commit 期间连接丢失时，系统以独立 commit-unknown 错误拒绝，使领域通过持久 idempotency key 对账，而不是盲目重复操作。
- Cancellation 在等待 pool lease 和 driver 可安全取消的执行期间生效。如果无法确定 query 是否完成，服务先销毁 connection，再决定是否返回连接池。
- 服务对 duplicate-key、foreign-key、deadlock、lock-timeout、acquisition-timeout、cancellation、unavailable、schema 和 commit-unknown 失败分类，并且不包含 SQL parameter 或受保护记录内容。
- `dsh-mysql` 不自动重新运行任意 transaction callback。只有数据库工作和每项外部副作用都具备幂等性时，领域才能重试已分类的瞬时失败。
- 跨系统工作不在数据库 transaction 内执行。领域在同一个 transaction 中提交修改与 outbox 记录；独立 dispatcher 在 commit 后交付 Redis invalidation 和 Elasticsearch document。
- Authorization、revocation、会话恢复和其他要求新鲜度的读取使用 primary。领域只能为显式允许陈旧的 projection 选择 replica。

Statement 使用 parameter binding 处理值，并通过经过审阅的静态构造处理 identifier。请求 payload 永远不能成为 SQL fragment、table name、sort expression 或 migration identifier。

## Schema 所有权与 migration

`dsh-mysql` 只拥有自身 binding metadata 与 migration catalog。每个领域拥有唯一 migration namespace、自身 table definition、index、constraint、seed record 和数据转换。Request handler 永远不创建或修改 schema object。

- Migration id 在一个 owner namespace 内单调递增，已应用 id 保持不可变 checksum。
- 一个 migration runner 在校验和应用 manifest 时持有 database-scoped lock。其他实例在配置时限内等待，否则启动失败。
- `validate` 拒绝缺失、待应用、失败、checksum 不匹配或未知未来 migration。`apply` 只能通过显式 migration-capable 组合运行。
- 系统不能把 MySQL DDL 当作可多语句 rollback 的 transaction。每项 migration 都要定义 restart behavior，并留下必须在 runtime readiness 前完成对账的失败记录。
- 领域在注册可读写自身表的 service 前完成 migration 校验。
- 生产 backup 与 restore 保留 migration catalog 和 outbox。系统在流量恢复前完成 restore 校验，同时从 MySQL 重建 Redis 与 Elasticsearch projection。

仓库 pre-release 策略允许拒绝没有所有权信息的本地格式，而不是隐式 import。独立 importer 写入选定 MySQL 目标，通过普通领域 service 校验 counts 与 content references，并保持 source 不变。

## 租户隔离

MySQL 不提供 PostgreSQL 风格的 row-level security，因此应用所有权检查和关系 constraint 是必需项。每张租户所有表都携带 `tenant_id`；primary key、unique constraint、foreign key、list index 和 retention index 都在 resource id 前包含 tenant。平台全局表具有显式分类，租户产品 repository 无法访问它们。

领域方法接收从 `AuthenticatedCall` 派生的可信 `TenantScope`。它们通过 tenant/resource 复合 key 查询，再披露存在性、内容、counts 或时序敏感工作。`dsh-mysql` 不从 ambient process state 推断 tenant，也永远不把请求提交的 tenant 当作授权。

控制平面和租户运行时进程使用独立最小权限 database identity。共享 MySQL 部署属于运维 topology，不是安全例外：有效跨租户 id 不能触发无 scope 查询。需要更强数据库边界的部署可以给一个 tenant 或 tenant group 分配独立 database 与 binding，同时保留相同领域 service。

MySQL network、credential 和 client library 留在模型控制的动态 Host 包、容器与 microVM 之外。这些环境调用已授权 tool 和 provider adapter；它们永远不接收 `ctx.mysql`、database socket 或 database credential。

## 领域消费方

### 会话持久化

`dsh-session-persistence-mysql` 实现现有仅追加、连续 sequence、lazy materialization、inspection、recovery 和 revision 要求。它在 session row 中存储不可变 tenant 与 owner metadata，并在 `(tenant_id, session_id, seq)` 下存储 event row。一次 append batch 在必要时 materialize session，并在一个 transaction 中插入全部 events。

Agent loop 继续依赖 `ctx.sessionPersistence`，而不是 `ctx.mysql`。Session query 和 Elasticsearch indexing 使用 persistence/query capability 或持久 outbox，因此更换 SQL driver 不会产生绕过会话授权的新路径。

### Identity 与管理

Identity 消费方拥有 users、external identity mappings、tenants、memberships、roles、service accounts、token verifiers、revocation state、quotas 和 administrative revisions。Authentication secret 与 model-provider credential 仍是独立关注点。安全敏感修改使用 optimistic 或 transactional precondition，并在同一个 MySQL transaction 中写入 audit/outbox fact。

Redis 可以加速 revocation 或 rate-limit 检查，但 cache miss 或 Redis restart 永远不能把未校验 principal 转换成已授权 principal。MySQL 继续作为 membership 和 grant state 的持久真源。

### 通用领域存储

Settings、workspaces、durable jobs、audit 和其他关系数据领域使用具有窄 service API 的专用消费方。可选 `dsh-storage-mysql` 把现有 KV form 映射到 MySQL 以存储简单记录；它不向 `storage-domain` 暴露 join、arbitrary SQL 或 transaction，关系数据消费方也不通过该 KV adapter 路由。

## Redis 与 Elasticsearch

MySQL、Redis 与 Elasticsearch 具有不同恢复和一致性规则。

| 系统 | 角色 | 失败规则 |
|---|---|---|
| MySQL | 权威关系数据状态与 transactional outbox | MySQL 无法确定结果时，必需持久修改失败 |
| Redis | Cache、rate limits、runtime leases、短期 idempotency hints 和 pub/sub | 丢失可能导致降级或按拒绝处理，但不能删除权威状态或授予访问权 |
| Elasticsearch | Tenant-scoped search 与 analytical projections | Indexing 最终一致，按 source identity/revision 幂等，并且可从 MySQL 重建 |

Outbox dispatcher 执行至少一次交付。Redis 与 Elasticsearch 消费方按 stable event id 和 source revision 去重，应用 deletion tombstone，并暴露 lag。Search authorization 在 Elasticsearch 执行 query 前提供 tenant filter；禁止对跨租户 hits 做事后过滤。

Attachments、spill 文件、workspace 内容和大型 binary output 继续存储在 object store 或租户 volume。MySQL 保存它们的已授权所有权 reference 和 lifecycle metadata；本插件不是 binary object store。

## 生命周期、安全与可观测性

- Readiness 要求成功获取 pool connection、执行轻量 primary query、校验必需 server settings，并确认 migration state 为当前版本。Liveness 不依赖成功数据库 round trip。
- Metrics 包含 pool capacity/use/waiters、acquisition 与具名 operation latency、transaction outcomes、classified failures、migration state 和 outbox lag。Label 排除 SQL text、parameter、message content、secret value 和无界 resource id。
- Logs 关联 request、binding、operation name 和 classified failure。它们不记录 connection URI、SQL parameter、event payload、authentication token 或 credential value。
- Shutdown 停止接纳工作、在有界时间达到完全停稳、记录超过时限的 callback、销毁不确定 connection，并关闭所有 pool。优雅进程退出不能让 migration 或已确认 write 留在未知 local state。
- Backup、point-in-time recovery、replication、capacity 和 retention objective 属于部署配置。Restore 会使 Redis state 失效，并在这些 projection 报告 readiness 前重建 Elasticsearch。

## 必需验证

- 共享约定测试套件使用真实 MySQL server，覆盖 pool admission、transaction、cancellation、classified errors、commit uncertainty 和完全停稳的 dispose。
- Migration test 使用并发 application instance，证明 lock exclusion、checksum drift rejection、partial DDL 后的 restart behavior 和 DML-only runtime credentials。
- 领域 integration test 使用两个租户中的有效 resource id，证明每条 read、list、append、update、delete 和 foreign-key 路径保持 tenant-scoped。
- Session test 针对 MySQL 运行现有 persistence contract，包括 crash recovery、append atomicity、revision stability、fork seed 和 cold resume。
- Outbox test 在 commit 与 delivery 之间中断 dispatch，证明 Redis/Elasticsearch 最终收敛，并且不会产生重复 authority 或丢失 deletion。
- Assembled server test 证明 remote 和 model-controlled path（包括进程内动态 Host 包）都无法取得 MySQL service 或 database credential；经过配置的可信 Host 消费方仍可访问。

## 待决定问题

- 维护良好的异步 MySQL driver，以及 query builder 能否在不掩盖 MySQL 行为的前提下删除足够多自有 SQL。
- 首个 server profile 使用共享部署、独立 control/session databases，还是 dedicated tenant databases。
- Migration 通过专用 command、deployment job 或受限 startup composition 执行。
- Outbox polling 与 binlog-based change capture 的选择，包括 ordering 和 retention。
- 每种 deployment profile 的准确 pool、timeout、retry、backup 和 recovery defaults。

[MySQL 连接服务 Agent Note](../../.agents/notes/implemented/architecture/2026-08-18-mysql-connection-service.md)记录了已经实现的第一阶段生命周期决策。
