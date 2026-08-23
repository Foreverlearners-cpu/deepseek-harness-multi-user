# Agent Note: MySQL 多用户插件套件的解耦交付

Status: proposed

[English](2026-08-23-decoupled-mysql-plugin-delivery.md) | 中文

## 问题

候选 MySQL 多用户实现把五个新增包、多个可独立加载的 Cordis 入口、对上游分支中十三个既有包的修改、根级构建元数据、生成引用、部署组合和迁移脚本放进了共享主题分支的一个提交。这个组合改动存在三个交付缺陷。

第一，开发直接发生在共享 `mysql` 分支上。继续在该分支修正会进一步混合评审历史，而重写分支会使协作者的本地历史失效。

第二，一个提交和一个分支承载了职责与依赖方向不同的多个插件。评审者无法独立批准、测试、合并、回退或发布其中一个插件。

第三，候选实现修改了 DSH 既有包来让新插件完成编译和集成。这颠倒了预期依赖方向：可选插件要求一份本地打过补丁的 DSH 发行版，而不是消费未修改发行版提供的已记录服务、事件、路由、slot 和配置层。

替代实现必须保留有用结果——MySQL 会话持久化、语义 Conversation 投影、用户所有权、文件存储、可选 HTTP 与 UI 集成，以及可选检查点或 outbox 行为——但不能保留耦合实现。

## 方案

把现有 `mysql` 分支视为共享历史，通过普通 revert PR 恢复其内容。每项替代实现都从最新上游 `master` 构建，一个可独立加载或发布的单元对应一个分支，每个分支最终保留一个逻辑提交。插件分支可以修改自己的包、测试和文档，以及范围严格受限的必要仓库注册元数据；不得修改另一个既有或拟新增插件。

候选实现新增的五个包目录只是源码材料，不是可复用提交。实现者可以查看或按路径提取候选提交中由该包拥有的文件，但不得 cherry-pick 整个提交。每个提取文件都要以当前 `master` 为基准重新评审，移除对打补丁 DSH 包的依赖，并在自己的分支范围内完成验证。

任何原本通过修改既有 Host、客户端、持久化、标题、检查点、组合包或 catalog 包实现的效果，只能变成三类之一：使用已记录扩展点的独立配套插件、由采用方拥有的部署配置，或者在不存在公开扩展点时暂缓的能力。MySQL 插件绝不向既有 DSH 包引入未声明补丁。

## 交付不变量

- 共享 `mysql` 分支发布后绝不强推或 rebase。
- 每项修正或实现改动都从新分支开始。
- 每个插件分支只包含一个可独立加载或发布的单元，并最终形成一个逻辑提交。
- 插件只导入当前上游包，以及已经合并或作为临时 stacked PR 明确 base 的前置插件约定。
- 不修改 `packages/core` 下的包、默认组合包或既有插件来让可选 MySQL 插件工作。
- 未安装任何 MySQL 插件时，上游构建、运行时组合、公共类型、路由、UI 和持久化行为保持不变。
- 缺少所需扩展点时，暂缓该功能或单独向上游提案；插件不创建消费方的私有 fork。
- 每个分支都包含包自有的中英文文档、测试、invariant，以及其 diff 所需的最小验证证据。

## 包拓扑

| 拟定分支 | 拟定包或单元 | 职责 | 前置条件 |
|---|---|---|---|
| `plugin/user-service` | `packages/identity/user` | 用户身份和查询的 Service Definition；不包含 MySQL 实现 | 当前 `master` |
| `plugin/user-mysql` | `packages/identity/user-mysql` | 用户服务的 MySQL Service Provider | 已合并 `user-service`；上游 MySQL 服务 |
| `plugin/file-storage` | `packages/storage/file-storage` | 提供方无关的文件对象约定，以及在同一生命周期拥有两个角色时的本地内容寻址提供方 | 当前 `master` |
| `plugin/session-persistence-mysql` | `packages/session/session-persistence-mysql` | 既有 `SessionPersistence` 服务的 MySQL 实现 | 上游 session-persistence 和 MySQL 服务；仅在需要身份时依赖已合并用户约定 |
| `plugin/conversation-persistence-mysql` | `packages/session/conversation-persistence-mysql` | 语义 Conversation、消息、尝试、文件元数据和 outbox 投影 | 已合并用户与 file-storage 约定；上游 MySQL 服务 |
| `plugin/runtime-config-mysql` | 保留时新增独立包 | 拥有自身服务和生命周期的运行时配置存储 | 上游 MySQL 服务 |
| `plugin/conversation-outbox-consumer` | 保留时新增独立包 | 向 Kafka、Redis 或 Elasticsearch 可选投递已提交 outbox 行 | 已合并 Conversation 持久化约定和选定上游提供方 |
| `plugin/conversation-file-api` | 新增 Host 配套包 | 通过 `ctx.webServer` 注册文件上传和下载路由 | 已合并 Conversation 与 file-storage 约定；上游 webserver 服务 |
| `plugin/storage-status-ui` | 新增客户端配套包 | 在既有设置 slot 中注册存储状态卡片 | 已发布的客户端状态源和上游客户端 slot |
| `plugin/session-checkpoint-time` | 保留时新增策略包 | 使用既有会话事件和持久化操作实现可选的按时间检查点 | 上游会话与持久化服务 |

主 Conversation 包只拥有其主要 Cordis 插件。现有 `session-persistence`、`runtime-configs` 和 `outbox-consumer` 子路径入口不再作为隐藏的次级插件留在该包中。没有独立配置、注入列表、生命周期或 loader 入口的 helper 可以保持内部实现；可独立激活的入口属于独立插件，因此必须有独立分支。

## 兼容性设计

### 会话所有权

插件不向 `SessionHeader`、`CreateSessionOptions`、`CreateAgentOptions` 或 agent loop（智能体循环）增加 `userId`。持久化提供方在自己的 schema 中保存所有权，并将已认证或已配置主体应用到每个存储操作。

```sql
CREATE TABLE session_owners (
  session_id VARCHAR(128) PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL
);

SELECT ...
FROM sessions
WHERE session_id = ? AND user_id = ?;
```

对于一个配置用户对应一个 DSH Host 的部署，提供方在激活期间解析该用户，并在会话首次持久化时记录它。一个部署若并发服务多个已认证用户，就需要已记录的请求级身份机制。如果当前 DSH 没有该机制，并发多用户服务不属于本方案，而不是通过全局可变状态或 core 补丁模拟。

### 会话持久化与恢复

`session-persistence-mysql` 实现上游 `SessionPersistence` 约定，包括创建、追加、加载、列举和准备行为。DSH 既有消费方继续使用 `ctx.sessionPersistence`；它们不探测 MySQL 专用服务，也不对语义 Conversation 存储做特殊处理。提供方持久化上游验证、回放、恢复、fork、transcript（文本记录）和 UI 保真所需的事件信息。

语义 Conversation 存储是投影，不是规范会话事件日志的替代品。它可以为自己的 API 响应执行 hydrate，但不会静默重定向 `api/remotes` 或其他既有消费方。如果产品需要新的语义恢复约定，该约定应作为具有 Service Definition、Service Provider 和 Consumer 的独立能力提出。

### 事务

MySQL 插件使用既有连接 callback，并在该 callback 内拥有自己的事务序列。它们不向上游 MySQL 插件添加便利方法。Callback 失败、commit 失败和资源释放都必须让租用连接处于上游连接约定要求的状态；集成测试固定 commit、rollback 和重试行为。

### HTTP 与客户端集成

文件传输属于 `conversation-file-api`，它通过上游 webserver 服务注册并释放自己的精确路由。它不向 `host/apiproxy` 添加方法、schema、配置或处理器。在文件元数据或字节离开服务之前执行认证和所有权检查。

存储展示属于 `storage-status-ui`，它在既有设置 slot 中注册自己的组件。它不向 `ui-settings-general` 添加组件、locale 键、fixture 或测试，也不手工修改客户端 slot catalog。如果客户端无法通过公开状态源取得安全的存储状态快照，该卡片暂缓到状态源存在之后。

### 组合、检查点、标题与 catalog

默认 Web 组合包保持不变。采用方通过自己的 profile 或 `cordis.patch.yml` 启用提供方并禁用默认 JSONL 配置项；包文档拥有完整示例，并列出所需环境变量但不嵌入凭据。

既有检查点和 session-title 插件保持不变。若公开会话和持久化操作足够，按时间检查点作为独立事件消费方实现。除非标题服务公开受支持的配置操作，否则暂缓运行时标题修改。服务与模块 catalog 只从权威包元数据或源码生成；插件分支不会手工编辑生成条目来宣传尚未合并的服务。

## 保持不变的既有包

| 既有包 | 要移除的候选修改 | 替代方式 |
|---|---|---|
| `packages/core/session` | 用户身份字段及对用户包的依赖 | 插件自有所有权表和检查 |
| `packages/core/agent` | agent 创建元数据中的用户身份 | 提供方在受支持边界解析身份 |
| `packages/core/agent-loop` | 为用户元数据修改会话创建 | 无替代；上游 loop 继续消费上游会话约定 |
| `packages/api/remotes` | 在标准持久化前查询 MySQL Conversation | 完整实现既有 `SessionPersistence` 约定 |
| `packages/bundle/web-app` | 默认组合包中的 MySQL 包、环境配置和提供方选择 | 采用方拥有的 profile 或 patch 示例 |
| `packages/client/connection` | 在既有 fixture 中增加文件传输方法 | 如有需要，由配套客户端包及其 fixture 承担 |
| `packages/client/ui-settings-general` | 存储状态组件和 locale 增量 | 独立设置 slot 插件 |
| `packages/extensions/cordis-client-runner` | 手工注册存储状态组件 | 由新客户端插件拥有注册 |
| `packages/extensions/tool-cordis` | 新服务的手写条目 | 包自有公共文档，以及合并后的普通 catalog 生成 |
| `packages/host/apiproxy` | Conversation 列举、存储状态、身份配置和文件路由 | 标准持久化加独立 webserver 路由插件 |
| `packages/multi/mysql` | 新事务便利 API | 由每个新提供方拥有事务序列 |
| `packages/session/session-checkpoint-policy` | 定时调度器和策略注册表 | 独立检查点插件，或保持上游行为不变 |
| `packages/session/session-title` | runtime-config 注入和可变限制 | 启动配置或未来受支持适配器；否则暂缓 |

根级元数据不是包隔离的例外。仓库规则要求时，一个分支可以更新一个聚合 TypeScript 项目注册；自动发现不足时，可以更新一个包 manifest 或 workspace 声明；还可以包含由该包声明依赖导致的 lockfile 条目。无关生成改动、属于其他插件的脚本和尚未合并包的 catalog 变化都要排除。

## 分支与合并工作流

1. 拉取远程，从当前已验证的 `origin/master` 创建插件分支；只有当前置插件 PR 是明确临时 base 时，才从该前置分支创建。
2. 使用按路径限定的 Git 命令检查候选文件；绝不 cherry-pick 耦合提交。
3. 只添加当前包及其自有文档、测试、invariant 和必要注册元数据。
4. 将依赖其他未合并包或已打补丁 DSH 消费方的导入或运行时探测替换成已声明公共约定。
5. 运行 `pnpm --silent run change-scope --base <verified-base-ref>`，检查每个已提交、暂存、未暂存和未跟踪路径。
6. 运行针对改动行为选择的最小包测试和构建检查，然后对文档改动运行文档门禁。
7. squash 开发提交，使分支最终只有一个完整逻辑提交；正常推送并针对已验证 base 创建 PR。
8. 先合并前置项，再合并依赖项。临时 stacked 依赖分支在前置合并后 rebase 到更新后的 `master`，重新验证完整范围，并仅在确有必要且已获授权时用租约保护发布改写历史。

预期合并顺序如下：

```text
user-service ──> user-mysql
       │
       ├────────> session-persistence-mysql
       └────────> conversation-persistence-mysql ──> conversation-outbox-consumer
file-storage ──────────────────────────────────────> conversation-persistence-mysql
conversation-persistence-mysql + file-storage ────> conversation-file-api
published status source ───────────────────────────> storage-status-ui
upstream session + persistence ───────────────────> session-checkpoint-time
```

临时 stacked PR 把前置分支设为 base，使可见 diff 只包含依赖插件。前置项合并后，依赖分支移动到当前 `master`；只要相对实时 base 的 diff 仍包含前置插件，该 PR 就不能视为就绪。

## Diff 策略

每个插件 PR 在实现前定义明确路径 allowlist。Allowlist 通常包含包目录、配对的 Agent Note 或包文档、需要时恰好一个聚合 TypeScript 注册，以及只由依赖导致的 lockfile 改动。Allowlist 之外的任何修改路径都会停止推送，直到它被移除，或作为新插件分支单独说明。

范围评审拒绝以下模式，除非该分支本身恰好拥有该路径下的新增包：

```text
packages/core/**
packages/bundle/web-app/**
packages/host/apiproxy/**
packages/client/ui-settings-general/**
packages/extensions/tool-cordis/**
packages/extensions/cordis-client-runner/**
packages/multi/mysql/**
packages/session/session-checkpoint-policy/**
packages/session/session-title/**
```

未跟踪生成缓存目录 `Usersxishuai.npm-cache/` 永不暂存、提交、用作包源码或当作验证证据。

## 验证

| 要求 | 合并前证据 |
|---|---|
| 分支隔离 | `change-scope` 和 `git diff --name-only <base>...HEAD` 只包含 allowlist 路径 |
| 上游兼容性 | 未安装任何 MySQL 插件的干净上游组合可以构建和启动 |
| 插件激活 | 目标插件可以在声明前置服务满足时构建并激活，缺少必要服务时明确失败 |
| 持久化行为 | 聚焦测试覆盖由提供方拥有的创建、追加、flush、列举、加载、恢复、排序、取消以及损坏或部分数据行为 |
| 事务安全 | MySQL 集成测试覆盖 commit、callback 失败、rollback 失败、重试和资源释放 |
| 租户隔离 | 测试证明用户 A 无法列举、加载、更新、删除或读取用户 B 拥有的文件 |
| 迁移安全 | Schema 创建幂等；升级保留已提交数据；破坏性迁移需要单独评审的过程 |
| 生命周期安全 | 插件卸载时释放监听器、路由、定时器、订阅、租约和后台工作，不留下陈旧注册 |
| 可选集成 | HTTP、UI、检查点、runtime-config 和 outbox 测试位于各自插件分支 |
| 文档 | 中英文包文档与 Agent Note 完成配对；`pnpm run doc-sync`、`pnpm run lint` 和 `git diff --check` 通过 |
| 远程发布 | 远程分支 OID 与本地 `HEAD` 相同；共享分支只接受普通 PR 合并，绝不使用原始强推 |

除非插件修改了真正的仓库级约定，否则全仓测试仍由 CI 负责。分支不能仅凭推送成功宣称就绪；其选定本地证据和所需远程检查必须通过。

## 文档交付

每个包分支在自己的中英文 README 配对中记录配置、服务依赖、激活顺序、持久化或协议格式（wire format）语义、失败行为、安全与所有权规则、限制、扩展点、模型可见效果以及禁用或回滚说明。同一分支添加或更新拥有其非平凡决策的 Agent Note，并记录翻译配对伴随文件。

生成的架构、模块、服务、配置和持久化 catalog 只在源码包合并后通过其所属生成器变化。最终可以用一个纯文档集成分支说明已经独立合并的插件如何组合，但该分支不包含插件源码，也不会取代包 README 作为约定所有者。

## 共享分支回滚

因为 `mysql` 是共享分支，所以保留其已发布历史。从实时 `mysql` 头创建回滚分支，revert 耦合提交，并通过普通 PR 合并回 `mysql`。回滚提交可能反向修改很多路径，因为它原子移除一个耦合改动；这是历史修复操作，不是未来功能分支的范例。

回滚通过比较结果 tree 与耦合改动之前的提交来验证。共享分支内容只有在评审并合并后才回到该 tree。候选提交仍可在历史中按需检查，但任何替代分支都不以它为 base。

独立插件合并后，每个插件都可以通过组合配置禁用，也可以通过自己的 PR 回退。数据库迁移默认只做增量；禁用插件不会删除数据，破坏性清理属于单独明确授权的操作。

## 考虑过的替代方案

**保留耦合提交并逐步清理。** 不采用，因为每个中间状态都会继续混合包所有权，评审者无法证明表面上的插件 diff 已不再依赖打过补丁的 DSH 包。

**重置并强推共享 `mysql` 分支。** 不采用，因为协作者可能已拉取已发布提交，或在其上开展工作。普通 revert 保留对象可达性，并让团队评审内容恢复。

**把用户身份移入 core 会话和 agent 类型。** 不采用，因为可选持久化会把自己的身份模型施加到每个 DSH 部署，并使 core 包依赖可选插件约定。

**在一个长期分支中用不同提交保留所有插件。** 不采用，因为 PR、发布和回退范围仍包含此前所有插件，而依赖项可能静默依赖同分支实现细节。

**在每个消费方中复制服务接口，让所有分支从同一个 base 编译。** 不采用，因为结构相似的本地类型不会形成一个有归属的能力约定，并且可能在运行时漂移。共享约定先合并，或者成为明确的临时 stack base。

**没有扩展点时给既有消费方打补丁。** 本插件套件不采用。暂缓该能力，或将其作为通用扩展点单独向上游提出，并承担自己的评审和兼容义务。

## 验收条件

- 共享 `mysql` 分支通过已评审 revert PR 回到耦合改动前的 tree，不重写历史。
- 每个保留的可独立激活入口都有自己的包或单元、分支、PR 和最终逻辑提交。
- 每个替代分支从当前 `master` 开始，或声明一个临时前置分支作为其 PR base。
- 任何替代 PR 都不修改本说明列出的既有包路径。
- Core session、agent 和 agent-loop 公共类型不包含 MySQL 套件用户身份字段或依赖。
- `session-persistence-mysql` 满足既有 `SessionPersistence` 行为，不需要 MySQL 专用消费方探测。
- 用户所有权在插件自有存储中执行，并由跨用户拒绝测试覆盖。
- 保留文件路由和存储 UI 时，它们通过已记录 webserver 与客户端 slot 扩展点作为独立插件交付。
- 保留 runtime config、outbox 消费和按时间检查点时，它们具有独立所有权和生命周期。
- 未安装任何替代插件时，上游构建与默认运行时行为保持不变。
- 每个插件分支通过其范围行为检查、文档门禁、diff allowlist 评审和所需远程 CI。
- 包 README 与最终集成指南记录安装、排序、配置、限制和回滚，不要求修改上游包。

## 风险

顺序合并可能减慢依赖插件，但能保持每个 diff 可评审，并让依赖图保持明确。临时 stacked PR 只有在其 base 和合并后 rebase 始终可见时才能减少空等。

上游扩展点可能不支持每个候选 UI 或 runtime-config 效果。本方案明确放弃这些效果，直到通用扩展存在，而不是交付私有兼容 fork。

用户所有权的强度取决于提供给提供方的身份源。全局配置用户保留一个 Host 一个用户的部署，但不声称具备并发请求级隔离；真正共享 Host 需要已认证的请求级身份约定。

插件拆分会增加分支、发布和版本约束。顺序合并、明确的对等依赖（peer dependency）或 workspace 依赖、包自有兼容性声明和一份最终集成指南可以控制这项运维成本。

Schema 错误可能在插件回滚后继续存在。因此迁移默认保持增量和幂等，租户谓词接受集成覆盖，破坏性清理绝不作为隐式卸载步骤运行。
