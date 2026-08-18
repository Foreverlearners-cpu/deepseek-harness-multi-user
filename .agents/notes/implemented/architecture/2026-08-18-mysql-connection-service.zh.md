# Agent Note: MySQL 连接服务生命周期

Status: implemented

[English](2026-08-18-mysql-connection-service.md) | 中文

## 问题

可信 Host 领域插件需要共享 MySQL 连接能力，并且不能各自创建连接池、持有 credential 或定义不兼容的资源释放行为。第一阶段实现需要为后续认证和持久化消费方提供可用连接，但这些未来领域尚未提供足以确定 transaction、migration、query 或 schema API 的使用依据。

## 决策

`@deepseek-ai/dsh-mysql` 提供仅限 Host 的 Cordis 服务 `ctx.mysql`，底层拥有一个 `mysql2/promise` 连接池。经过校验的插件配置选择一个 TCP host、port、user、password、database、连接数上限和建立连接的超时时间。该超时不得超过 Node 的最大 timer delay，防止 runtime 把溢出值限制为 1 毫秒。服务在激活期间获取一个连接并调用 `ping()`，因此数据库无法访问或拒绝连接时，插件不会进入就绪状态。

公开 API 为 `connection(callback)`。服务在获取连接池连接前接纳调用，并且在每个已接纳操作等待、使用和清理连接期间持续跟踪该操作。Callback 收到的是不含连接池生命周期方法或原始驱动状态的 `MysqlConnection` façade。Callback 结算时，该 façade 以及通过它获取的 prepared statement 会失效；后续操作会失败，而返回其中任一对象会使租用操作失败，不会发布逃逸连接。随后服务会等待 `COM_RESET_CONNECTION` 完成，从而回滚未结束的 transaction 并清除 session variable 和临时状态，重新选择配置的 database，再释放租用连接。Reset 或 database 恢复失败时，服务会销毁连接，不会把状态不确定的连接放回池中，也不会覆盖 callback 原本的结果或错误。

资源释放会停止接纳新操作，等待所有已接纳操作完成，然后关闭连接池。这使已接受工作达到完全停稳，包括仍在等待连接池容量的调用方。第一阶段实现没有关闭时限，因此每个已接纳 callback 最终都必须结算。

该包只拥有连接基础设施。领域消费方拥有数据表、SQL、migration、transaction 策略、租户 scope 和持久化语义。该服务不注册模型可见工具、提示词、消息或事件，也不记录配置或连接错误。维护者子系统文档保留其 API，但面向模型的 Cordis API 目录和实时服务检查都会排除它。生成的 runtime catalog 携带供每条检查路径使用的隐藏服务键。动态 Host 沙箱只接受 primitive string 形式的服务名称，并会在解析声明属性访问、可选 `ctx.get()` 查询或 `ctx.provide()` 注册前拒绝 `mysql`。

## 考虑过的替代方案

**直接公开 `mysql2` 连接池。** 直接访问连接池会允许调用方保留连接并在资源释放期间接纳工作，使服务无法强制释放连接和达到完全停稳。

**在基础设施包中实现认证或会话持久化。** 这些领域具有不同的 schema、授权规则和服务 API。将它们与驱动包耦合会让数据库连接层拥有领域策略。

**从 transaction、migration 和错误分类开始。** 当前没有消费方能够确定它们的准确 API 或默认值。在第一个领域实现之前加入这些能力，会产生缺少使用依据的公开选择。

**通过现有 KV 存储形式路由所有关系数据。** KV 形式仍适合简单记录，但不能表达认证和会话持久化需要的跨表 transaction 与关系查询。

## 实施经验

仅实现连接能力使核心改动保持精简。现有 Cordis 服务和包模式提供了生命周期结构，`mysql2/promise` 提供了维护中的连接池行为，聚焦的连接池 mock 覆盖失败和资源释放路径，可复用的 Docker 镜像则让真实服务器检查具备确定性。只验证 `release()` 的 mock 不足以证明服务端 session 状态已经清除；真实服务器测试会刻意留下未结束的 transaction、session variable 和已更改的 database，再验证下一次租用看不到这些状态。在这台工作站上，聚焦单元测试约耗时 1–3 秒，镜像可用后的 e2e 测试约耗时 5 秒，包构建约耗时 16 秒。这些数据描述开发反馈时间，不是运行时性能保证。

大部分总耗时来自仓库和环境集成，而不是连接服务本身。并行工作要求使用隔离 worktree；首次拉取 MySQL 8.0 镜像耗时数分钟；包管理器的可选二进制解析问题以及不完整的过滤依赖安装导致了重试。Host TypeScript aggregate、path mapping、生成的 catalog 分类、capability graph 和双语配对也必须保持一致，仓库 gate 才能通过。完整 `doc-sync` 约耗时 98 秒并通过 28 项中的 27 项；剩余失败是 Windows 拒绝文档测试创建 symlink。

可复用的实施顺序是：编辑前先创建隔离 worktree；引入包时立即添加 Host aggregate 和 path-map 条目；生成 lockfile 时使用 npm 官方 registry；通过 `vitest.e2e.config.ts` 运行真实服务器测试；运行 catalog generator 前先确定 service 和 type 的归属分类；最后先记录 translation pairing，再运行 `doc-sync`。这个顺序能尽早暴露结构遗漏，并把较慢且依赖环境的检查放在包级反馈已经通过之后。

## 影响

领域插件获得一致的连接生命周期，并在 MySQL 不可用时启动失败。Callback 作用域的租用收紧了所有权，阻止服务端 session 状态跨 callback 传播，并使插件资源释放等待已接受工作和连接重置。初始 API 明确不包含 transaction、migration、TLS 策略、query timeout、取消、错误分类、健康状态报告、可观测性、具名 binding、replica 和有界关闭；每项新增能力都需要当前消费方以及相应的真实 MySQL 覆盖。

单元测试固定配置边界、启动失败、租用 façade 限制和失效、重置先于释放、重置失败后销毁、保留 callback 结果、资源释放期间的接纳行为、invariant 重新注册和连接池关闭。`mysql.e2e.ts` 使用 `DSH_MYSQL_TEST_URL`，针对真实 MySQL server 验证激活、租用之间的服务端 session 清理和资源释放期间的排队工作排空。沙箱测试覆盖动态读取、名称强制转换和提供方冒充；检查和目录测试证明维护者文档保留 `ctx.mysql`，而每种模型报告都会将其排除。
