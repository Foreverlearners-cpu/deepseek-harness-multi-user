# 多用户数据与运行时隔离

[English](data-and-runtime-isolation.md) | 中文

本文定义提案中持久数据、实时状态、事件交付、credentials 和模型控制执行的所有权与隔离规则。Identity 和策略决策来自[身份与访问控制](identity-and-access.md)。

## 所有权模型

每项资源在创建时都有不可变的租户所有者。表示单个 principal 工作的资源还具有可判别的 owner principal。可变授权和生命周期状态属于控制平面表，而不是复制到每条资源记录中。

服务端 profile 中的 `SessionOwner` 是用户或 service account，本地 profile 还允许显式 local principal。Server composition 在 import 或创建记录时拒绝 local owner。

| 资源 | 必需所有权 | 必需变更 |
|---|---|---|
| Session header | `tenantId`、`ownerPrincipal: SessionOwner`、`workspaceId?` | 从已认证上下文写入；永远不信任 create 请求中的这些字段 |
| Session 事件 | Session 外键和可选的人类 actor 归属 | 回放数据保留在所属 header 下；不要在模型编写的 payload 中重复租户选择 |
| Workspace | `tenantId` 和执行卷绑定 | 服务端模式使用已授权 workspace id，替代任意共享 Host 路径 |
| Settings | 部署、租户和用户 scope | 解析显式分层，并独立持久化各层 |
| Credentials | 租户或用户 scope 加授权 | 通过 vault 提供方解析；永远不向执行环境暴露值或存储路径 |
| Attachments 与 spills | 租户和 session 引用 | 每次读取都通过所属 session 授权；隔离临时和持久对象的 namespace |
| Live agents、terminals、jobs、approvals、questions 和 workflow runs | 租户和 session 所有者 | 按已认证运行时/session 所有权设置注册表与通知键 |
| Projections、titles、search indexes、caches 和 telemetry | 租户加源资源 | 每个键、查询、失效、导出和保留操作都包含租户 |

不透明 id 仍使用全局抗冲突 UUID 或等价随机标识符，但不可猜测性不是授权。即使 `sessionId` 全局唯一，存储和服务方法也使用 `(tenantId, sessionId)` 等有 scope 的键。进程局部 `session-<n>` id 生成方式不适合持久多用户部署。

## Session 持久化

`SessionHeader` 已经承载所有持久化后端使用的日志外存储元数据，因此它适合拥有不可变 session 租户信息。提案中的 header 新增品牌类型 `tenantId`、可判别的 `ownerPrincipal` 和可选 `workspaceId`。服务端模式的创建流程从已校验 `AuthorityCallContext` 的 tenant scope 派生这些字段；其中嵌套的 `AuthenticatedCall` 仍只包含身份。只有 import 路径可以提交经过校验的历史所有权。

持久化 seam 的公共接口和后端接口都变为租户级。`create`、`prepare`、`load`、`inspect`、`readFrom`、`list`、`listSnapshots`、`fork`、修复和冲突检查都接收或派生访问 scope。任何方法都不能先扫描所有租户再过滤。系统维护接口可以枚举租户，但它属于独立控制平面能力，普通 Remote descriptor 无法访问。

SQLite 使用复合所有权和外键：

```text
sessions  PRIMARY KEY (tenant_id, id)
events    PRIMARY KEY (tenant_id, session_id, seq)
events    FOREIGN KEY (tenant_id, session_id) REFERENCES sessions
```

List、lineage、title、内容搜索、usage 或 retention 使用的每个索引都以 `tenant_id` 开头。生产部署通过提议的 `dsh-mysql` 基础设施服务使用 MySQL，以支持多进程并发、备份、时间点恢复和运维扩展。MySQL 没有 PostgreSQL 风格的 row-level security，因此应用服务和关系 constraint 始终强制执行租户级访问；每个 tenant 或 tenant group 使用独立 database 可以增加更强物理边界。SQLite 仍是单节点提供方，并使用相同租户感知查询规则，避免开发环境只覆盖更弱的所有权约定。

JSONL 保持为本地或显式单租户后端。如果服务端 import/export 工具仍使用它，则其根目录已经由租户运行时选择，并且物理布局在 project/session 目录之前包含编码后的租户目录。它永远不会用用户提交的 Host `cwd` 逃逸或选择租户根目录。跨租户产物发现应直接不存在，而不是依赖过滤。

Fork 要求源读取和子 session 创建权限，保留同一租户，并且只有在策略允许调用方读取完整源 session 时，才默认把子 session 所有者设为调用方。跨租户移动属于 export/import：它复制策略允许的事件和 attachment 数据，分配新的 id 与所有权，清除仅运行时引用，并在审计系统中记录两侧操作。

## Session 日志与安全审计

Session 事件日志和安全审计日志服务不同读者，必须保持分离。

| 日志 | 用途 | 内容规则 | 读者 |
|---|---|---|---|
| Session 事件日志 | 重建模型可见状态、resume、replay、fork 和 UI projection | 行为所需的模型/用户/工具事实；不含 auth token 或通用访问决策 | 已授权 session 消费方和 agent 运行时 |
| 安全审计日志 | 解释谁尝试或改变了受保护状态 | Actor、tenant、action、resource type/id、decision、outcome、request id、time、reason code 和有界传输元数据 | 租户审计角色和受独立策略约束的平台安全 operator |
| 运行日志 | 诊断服务健康和故障 | Request id、不透明 resource id、component、安全错误和耗时；默认不含消息/工具/secret 正文 | 部署 operator |

当多个 actor 可以影响一个 session 时，人类发起的 session 修改要携带 actor 来源。首个私有 session 版本中，所有权加已认证请求审计足以覆盖普通用户消息；协作功能必须先增加持久 actor 标注，再允许共享写入。提供方响应和模型发起的工具调用归属于 session 执行，而不是伪造的人类 actor。

审计写入发生在控制平面，并且对产品服务只追加。控制平面修改在一个数据库事务中提交业务状态和 audit outbox 条目。对于租户运行时修改，控制平面在分发前持久记录已授权尝试，运行时按 `requestId` 去重执行，outcome 交付可重试且可对账。已提交修改只有在必需 outcome 记录被接受后才能报告成功；被拒请求记录有界拒绝事件，而不读取受保护内容。

审计数据具有显式 retention、export、legal hold 和 redaction 策略。需要篡改证据的部署可以增加 hash chain 或 WORM 存储，但普通仅追加应用表不能声称具备该性质。

当前 session telemetry 可以包含 prompts、messages、tool arguments/results、paths 和 file content。多用户服务默认禁用内容 telemetry。启用它需要租户策略、用户告知、经过审阅的脱敏流水线、目标 allowlist、地域/保留控制，以及策略变更审计。Harness-home 匿名关联 id 不是账号 identity。

## Workspace 与路径模型

当前 workspace 注册表存储规范化 Host 路径和一个全局归档集合。租户感知注册表按 `TenantId` 存储自身全局状态，以 `(tenantId, workspaceId)` 为记录键，并验证每个关联 session 具有相同租户和 workspace 绑定。

服务端客户端选择 `WorkspaceId`，永远不提交任意 Host 目录。管理员或 provisioning 控制器把 workspace 绑定到租户卷、代码仓库 checkout 或远程 sandbox 模板。租户运行时把该绑定转换成执行环境坐标。Host 路径不会穿过浏览器协议，不会作为用户选择的权限写入 session 日志，也不会成为跨租户目录键。

本地 profile 在 local principal 下保留基于路径的 workspace。两种 profile 只在语义真实时共享业务 workspace 接口；服务端提供方可以不支持原生目录选择和 Host `openPath` 操作，而不是伪造实现。

## Settings 与 credentials

Settings 解析变为显式分层：schema defaults、deployment base、tenant section、user section。Namespace 声明自身允许哪些 scope。租户策略不能仅因为与用户偏好共用 schema 就被用户覆盖；强制策略和用户偏好是不同输入。Descriptor 报告来源和 revision，但不暴露其他 scope 的原始文档。

写入只针对一个已授权 scope，并携带该 scope 的 expected revision。Namespace 事件包含 scope owner，确保其他租户的 UI、cache 或 runtime 永远观察不到变更。文件后端 settings 仍是本地 profile 提供方。服务端提供方把有 scope 的 section 存入控制平面数据库，并发布租户特有的失效事件。

Credential ref 是有 scope 的 identity，不是全局环境变量名。解析接收租户/用户 scope 和操作的 agent identity，只把 secret 返回给正在发起出站请求的可信提供方适配器。租户共享 credential 需要显式 `credential:use` 授权；管理权限与使用权限分离。用户 credential 不会静默覆盖租户值，也不会对租户其他成员可见。

本地 `.credentials.yaml` 和环境变量层仍属于本地 profile 功能。它们不适合共享服务器，因为同 UID 模型进程可以读取文件，而基于环境变量名称的启发式规则不是 secret 安全边界。服务端模式使用维护良好的 vault 或 OS/cloud secret 提供方，不把提供方 secret 放入进程全局环境，并且只在特定工具需要时向执行环境提供短期任务 credential。

## Attachments、spills 与派生数据

即使相同字节在物理层去重，content-addressed attachment 也需要租户/session 引用表。知道对象 digest 或存储 id 永远不能授权读取。Session upload 在写入引用它的事件前提交对象和所有权引用；history、提供方解析、export、fork 和 garbage collection 都沿这些引用工作。

跨租户物理去重是可选项，并且不能通过耗时、配额、错误或元数据泄露对象存在性。按租户使用加密密钥可以避免共享 ciphertext identity，但会牺牲去重。首个实现应优先选择简单租户隔离，而不是全局去重。

Spills、子进程输出文件、PTY 状态、LSP 状态、workflow workers、projection caches、title caches、prepared-session caches、search indexes 和临时 upload 文件都携带租户/session scope。清理只在该 scope 内运行，不能根据用户提交的 id 枚举或删除更宽的根目录。

## 事件与实时状态隔离

当前 mux 与 Host 事件流广播所有已附加 session、workspace 变更、待处理交互和部分 host 事件。已认证订阅应只对 principal 可读取的资源建立快照，并注册不会接收其他租户事件的有 scope listener。Frame 进入共享 queue 后再过滤已经太晚，因为 queue 大小、错误和时序已经泄露活动信息。

每次重连都重建已授权基线。成员关系或资源授权变化会使受影响事件流失效。Approval 和 question frame 只发送给允许回答的 actor；同一 actor 的第二个浏览器可以观察同一个 pending identity，而其他用户既收不到请求，也收不到结果，除非协作策略显式授权。

Live Map 使用复合 tenant/resource 键，或者位于单一租户运行时内部。Session lookup、resume 去重、retirement chain、prepared cache、open tool-call table、job visibility 和 projection subscription 不能在共享基础设施中使用裸 `SessionId`。Host 全局事件按公开部署事实、租户级事实和平台 operator 事实拆分，而不是逐字转发给每个客户端。

## 执行隔离

已交付的本地文件系统 sandbox 限制写入但允许读取。本地 subprocess、terminal、LSP server、code worker 和 workflow worker 共享 Host 权限；worker thread 与 `node:vm` 已明确不是安全边界。这些实现不能在一个 OS 账号中服务互不信任的租户。

服务端 session 从容器或微虚机提供方获取一个 `ExecutionLease`。该 lease 拥有租户/session 级文件系统、process namespace、PTY/LSP 进程、network policy、CPU/memory/process/time quota、environment 和 teardown。它携带不可变 tenant、session 和 generation identity；cold resume 可以分配新 generation，但任何 lease 都不能关联其他 session，generation 变化后也不能保留 live handle。文件系统与子进程能力提供方路由到同一个 lease，确保 Bash、文件工具、terminal、LSP、hooks、code、workflow child 和每个 subagent 的执行能力调用不会漂移到不同执行环境。Agent orchestration 可以留在租户运行时，但在服务端模式中不能打开 Host-local 执行提供方。

执行环境不接收控制平面数据库 credential、身份提供方 secret、租户 vault master credential、Host 文件系统根目录或 ambient `DSH_*` 值。它只接收显式 workspace mount 和短期 capability credential。网络 egress 默认拒绝或受策略控制，并具有目标和 byte/time quota。Teardown 撤销 credential、终止 process tree、等待完全停稳、封存输出，并通过幂等且有界的操作释放 lease。

现有 E2B 提供方展示了通过正确 seam 替换远程文件系统和子进程的方式，但其文档中的 POC 限制仍然存在。生产隔离需要 control channel、process identity、secret delivery、cleanup 和 output retention 都满足本威胁模型的提供方；提供方名称本身不能证明隔离能力。
