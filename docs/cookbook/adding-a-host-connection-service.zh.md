# 实操手册：新增 Host 连接服务

[English](adding-a-host-connection-service.md) | 中文

本文介绍仅限 Host 的网络连接服务所特有的工作，并解释为什么其实现可能很小，而仓库交付仍需投入较多时间。[工作区包检查清单](adding-a-package.md)负责通用包文件与注册规则；[`dsh-redis`](../infrastructure/dsh-redis.md)是连接服务的具体示例。

## 范围

连接服务拥有经过校验的客户端配置、启动连通性、回调接纳和客户端资源释放。领域消费方拥有 key、record、serialization、授权、重试和故障策略。编写代码前先保持这项拆分；向连接包加入领域操作会改变它的安全与生命周期责任。

首先阅读[架构](../architecture.md)、[防御性模式](../defensive-patterns.md)和包检查清单。其他进程正在修改同一仓库时，使用独立 git worktree，使分支切换和生成文件相互隔离。

## 1. 限定服务范围

围绕维护良好的协议客户端定义最小可用 API。`withClient(callback)` 这类回调范围方法让服务继续拥有实时客户端，并使接纳与关闭状态可被观察。配置在连接工作开始前只解析一次，随部署变化的 timeout 保持为经过校验的插件字段。

启用过程先连接并执行低成本协议探测，再公开服务。资源释放会停止接纳新工作，等待已接纳回调，在关闭客户端期间保留必要的连接错误处理，然后移除包拥有的 listener。启动、回调和关闭失败都保持显式可见。

把重连行为作为生命周期所有权的一部分来选择。如果维护良好的客户端会安排服务无法取消并等待的 retry timer，则在服务拥有显式 retry 状态之前关闭自动重连。不支持重连期间，服务必须提供有文档记录的恢复机制，例如重新挂载插件。

### 为什么这个阶段快

该包不实现 Redis command、pooling、cache、tenant authorization 或持久存储。维护良好的客户端依赖拥有协议格式与 socket 实现，而现有 Cordis `Service`、`ctx.effect()`、配置和 invariant 模式提供生命周期结构。因此，大部分源代码工作只是一个配置解析器、一个服务类和一个小型 invariant companion。

这种速度依赖范围约束。加入 cache policy、key construction、Pub/Sub、lease 或 transaction 会引入独立的正确性规则，应当放在领域消费方或专用客户端中。

## 2. 在没有外部服务时测试生命周期

Mock 客户端构造器，并覆盖配置传递、连接与探测顺序、回调结果与失败、readiness 拒绝、启动清理、资源释放期间的接纳、操作排空、关闭失败和 listener 移除。使用可控 Promise 驱动启动 deadline 和进行中的回调，使测试直接观察生命周期顺序。

增加无需 credential 的 loopback TCP fixture（测试前置数据），让维护良好的客户端面对静默 peer、立即关闭、有效协议响应和已建立连接丢失。这些测试可以暴露构造器 mock 无法表示的依赖重连与 socket event 行为，同时不需要 Redis 进程或 credential。

增加一个可选真实服务测试来验证客户端与服务器兼容性。该测试启动实际 Cordis 服务，通过公开回调 API 执行协议探测，然后释放上下文。环境变量不存在时跳过。

### 为什么迭代快

Mock 测试具有确定性，并能覆盖难以在真实服务器上复现的失败。Loopback fixture 在不使用 container 的情况下加入真实客户端 event sequence。真实服务测试保持狭窄，因为它只验证服务器兼容性，不重复生命周期覆盖。这种分工缩短常规编辑与测试循环，同时不把 mock 或协议 fixture 当作部署兼容性的证明。

## 3. 集成完整工作区包

按照[包检查清单](adding-a-package.md)处理 manifest、TypeScript project reference、Host aggregate、包索引、invariant 注册、README 和发布文件。通过生成器更新 capability、configuration、subsystem 和 dependency 文档，不手动修改生成区域。

安装依赖后检查 lockfile 和第三方声明。差异必须只包含预期的依赖图变化，不能包含 registry mirror URL 改写或无关 metadata 变动。

### 为什么这个阶段更慢

- 即使源代码包很小，它仍会进入仓库 compiler graph、包约束、runtime closure check、dependency analysis、build 和发布检查。
- Public JSDoc 与包 metadata 会进入生成 catalog 和 graph，因此一个 API 可能更新多项需要审查的产物。
- 范围内的每个文档页面都需要中文对侧文件和已记录的配对文件；公开页面还需要文档站 manifest 项与投影测试覆盖。
- 新 worktree 可以隔离并发改动，但拥有自己的工作区链接与构建输出，所以依赖安装和首次构建比后续聚焦运行更耗时。
- 生成器可能依赖另一个工作区包的已构建产物。即使新包本身正确，缺少生产方产物仍会阻塞生成。

应把这些视为集成工作，而不是服务实现复杂的证据。分别估算行为工作与仓库集成工作。

## 4. 分层验证

每次局部修改后运行最小检查，在 API 与文档稳定后再扩大覆盖范围：

1. 对变更服务与 invariant companion 运行聚焦 unit test、loopback-client test 和包级 coverage。
2. 有可丢弃 endpoint 时，运行可选真实服务测试。
3. 对源代码与 public JSDoc 运行类型检查和 lint。
4. 根据待提交差异选择 build、hygiene、constraints、dependency、license、notice 和 generator check。
5. 重新记录每个已编辑双语配对，再对公开页面运行 `doc-sync` 与网站构建。

Redis 示例在 PowerShell 中使用以下聚焦真实服务入口：

```powershell
$env:DSH_REDIS_TEST_URL = 'redis://localhost:6379/15'
pnpm exec vitest run packages/multi/redis/tests/redis.e2e.ts
```

最后运行[推送前工作流](../../.agents/skills/dsh-pre-push-checks/SKILL.md)根据差异选出的仓库检查，并检查完整差异：

```sh
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run hygiene
pnpm run doc-sync
git diff --check
```

不要仅为提交而重复已通过的广泛检查。CI 负责穷尽覆盖与平台矩阵。

## 5. 区分产品失败与宿主限制

- 包测试失败是产品证据，必须先修复，再继续更广泛的检查。
- Registry mirror 可能在安装期间改写解析后的 tarball URL。接受依赖差异前，检查并移除无关 lockfile 变动。
- 导入已构建输出的生成器要求先构建对应生产方。通过所属构建恢复必需产物，不要手写生成输出。
- Windows 可能以 `EPERM` 拒绝创建 symbolic link 的仓库测试。使用最小直接 symlink probe 确认宿主限制，报告被阻塞的具体检查，并让产品检查保持未完成，而不是削弱检查。
- 缺少 `DSH_REDIS_TEST_URL` 表示可选兼容性测试未执行，而不是通过。应把这项跳过与确定性的 unit coverage 分开报告。

这种分类可以在不掩盖代码缺陷的前提下明确环境延迟，并让其他宿主或 CI 上剩余的验证工作保持清晰。
