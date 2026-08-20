# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

协议消费层：客户端插件的 apply 会挂载 `ctx.connection`（共享 API 客户端 + 当前页面的 loopback 状态 + 可观察且按 generation 生效的 `hostDescription` + 单消费方流循环启动器）；导出表层携带协议约定类型、`AbstractApiClient` 抽象，以及循环的 sink／配置类型。每次就绪握手成功后，都会在 `onConnected` 之前发布完整的 `host.describe` 值；generation 失效或显式 stop 会清空它，因此原生能力消费者不会保留已经断线的判断。浏览器载体以 HTTP POST 发送 unary／respond，并为 `events.mux` 与 `events.host` 各开一条只下行的 WebSocket；进程内载体满足同一双流抽象。Host half 持有唯一 `/api` route 及其 Fetch bridge；已注册的 Typert interceptor 会先认领自己的 Remote endpoint，未认领请求再回退 API Proxy。Loopback hostname 判定逻辑留在包内部：`/api` Host fence 与 WebSocket upgrade 会直接使用它，其他客户端插件则消费派生的 `ctx.connection.isLoopback` 状态。node 半侧的 `/api` 路由让特权方法集（`host.pickDirectory`、`host.openPath`，以及整个配置面——`settings.describe`/`openDocument`/`update`/`replace`/`mutate` 与 `credentials.describe`/`set`/`unset`；读取与原生操作也在内，因为 describe 会返回已暴露的配置、打开操作会作用于 Host 桌面，而探测任意引用会报出某条凭据来自何处——以及 agent（智能体） preset 的创作面 `agentPreset.read`/`copy`/`openDocument`/`remove`，因为组装指明了一个会话所运行的插件，读取它是侦察，而 copy/remove/openDocument 管理名单并驱动宿主桌面（创作只有复制一种写入，因此这些方法都不接收组装文本或路径）；`agentPreset.list` 与 `agentPreset.select` 不在其中——名单只携带 id 与信任级别，而选择一个 preset 并不比 `session.create` 自带的 `agentPreset` 多给任何能力，何况默认 preset 本就带着 bash）以空信任表过信任 fence，从而钉在回环——这些操作还必须满足路径权限和已认证 call；回环栅栏不是身份 grant。平台载体与 ConnectionController 循环属于包内部；apply 负责选择并驱动它们。下行边界见 [WebSocket 下行载体 Agent Note](../../../.agents/notes/implemented/architecture/2026-08-04-websocket-downlink-carrier.md)。

## /api 浏览器信任栅栏

这道栅栏是可达性策略，不是身份认证；它先于认证和路径授权执行。若栅栏失败，HTTP 在认证或 RPC 分发前返回，WebSocket upgrade 则在认证、授权和创建事件 source 前拒绝。

node 半侧在桥接或 upgrade 前守卫 `/api` 下的每个入口（`src/api-request-trust.ts`）。每个请求——无论是否带浏览器标记——`Host` 都必须是回环地址权威，或与某个 `trustedHosts` 条目匹配：带端口的 `host:port` 条目精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化后比较（DNS rebinding 防御）。刻意不为无浏览器标记的 HTTP 请求开捷径：明文 HTTP 下浏览器的图片与导航读取既不带 `Origin` 也不带 Fetch-Metadata，因此无标记请求仍可能是被重绑页面发起的、响应可被读走的读取，而 Host 是重绑唯一伪造不了的请求头；WebSocket 浏览器握手会带 `Origin` 并通过同一道比较。非浏览器客户端经由回环地址、部署推导的 LAN IP 字面量或已声明的权威通过同一道栅栏。当标记存在时，如附带 `Origin`，则它必须与 Host 权威完全一致；显式的 `sec-fetch-site: cross-site` 标记一律拒绝。不是纯的、规范形 `host[:port]` 权威的 `trustedHosts` 条目——即 WHATWG 解析读回后与原文不完全一致的——会让插件加载明确报错：否则解析会悄悄授权 `harness.internal/path` 这类笔误里的 hostname，或把悬空冒号、补零端口放大成任意端口授权。真实 Node 请求若声明回环 Host，其 socket 对端也必须是回环地址（`127/8`、`::1` 或 IPv4-mapped loopback），因此远程客户端不能用 `Host: localhost` 绕过 local-only 或特权栅栏。HTTP 失败在任何 RPC 分发之前以纯 403 应答，upgrade 失败在启动任何事件流前拒绝握手。非回环组合必须显式信任其服务权威：Web 运行时从全接口服务器配置推导 LAN IP 字面量，cordis.yml 中的 `trustedHosts` 与 CLI（命令行界面）的 `--trusted-host` flag 则声明具名权威。`dsh web --host 0.0.0.0` 仍有意不受支持，因为内置 Authentication Provider 仅允许本地回环。网络部署必须组合能校验凭证的 Provider，并通过 `trustedHosts` 声明服务权威；信任栅栏始终是独立的可达性策略，绝不授予身份。决策记录：[api 浏览器信任边界 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.md)。

## Host 认证与 RPC 身份

每个被接受的 RPC 请求都会在 Connection 仍持有原始 `Request` 时由配置的 `AuthenticationProvider` 完成认证。通用 unary RPC 会在读取或 schema 解析 body 前认证。若这一步拒绝，Host 不能安全回显不可信 body 中的 rpcId，因此返回保留的 `security-denied` rpcId；Client 只在错误为 `unauthenticated` 或 `permission-denied` 时接受该 sentinel，其他响应仍严格校验关联。生成的不可变 `AuthenticatedCall` 通过带外参数传给 Host handler，绝不从 JSON envelope、`Host`、`Origin`、loopback 状态或客户端 payload 解码或重建。缺少 Provider 或 Provider 失败会在分发前返回 `unauthenticated`；受保护的 Typert endpoint 在认证调用被授权策略拒绝时则返回 `permission-denied`。

当前这道边界覆盖已注册的 unary Typert RPC 和 legacy API Proxy 入口：`/api/respond`、`/api/session.export`、`/api/events.mux` 与 `/api/events.host`。每条路径都有稳定的 `api:*` 权限码；Connection 在 body 解析和 handler 分发前认证原始 request，再把 call 带外传给受保护的 API Proxy adapter。WebSocket 下行会在创建事件 source 前认证并校验 upgrade 请求的路径权限。回环／trusted-host 栅栏仍是独立的可达性检查，因此 `trustedHosts` 不是身份或账号 grant。未传 security option 的 `toFetchHandler(api)` 仍可用于同构协议测试；生产 Host 组合必须提供 security adapter。

## `/api` WebSocket 下行

身份认证和路径授权仍负责建立连接时的决策，随后由 `AuthorizationLease` 在整个流生命周期保持该决策可撤销。最终新鲜度检查完成后，Connection 会在把 upgrade 交给下行之前打开租约。调用取消、凭证过期、策略或权限目录失效、以及 Authorization Provider 释放都会中止它的 signal。如果决策在打开租约时变得过期，upgrade 会在创建事件 source 前被拒绝；与 socket accept 竞态发生的失效也会在 source 启动前中止。

`/api/events.mux` 与 `/api/events.host` 各接受一条 WebSocket upgrade，并只向浏览器发送对应的 `ServerRequest` 文本消息；客户端不会在这些 socket 上发送业务数据。upgrade 会先通过浏览器信任栅栏、请求认证和路径权限校验，再创建 source。下行通过中止领域 source、并以 WebSocket policy code 1008 和通用原因关闭已打开 socket 来消费租约 signal；authorization 撤销不会被报告成 source `handler failure`。由下行拥有的 socket／source 完成路径和已处理的 negotiation failure 都会恰好调用一次 `release()`；撤销一条连接不会关闭 acceptor，后续尝试仍可重新认证和授权。任一 socket 结束都会使当前 connection generation 失败并重建两条流，连接就绪仍要求两条 socket 均已打开且 `host.describe` HTTP 调用成功。Host teardown 会终止两条 socket、中止各自的 source、释放其租约，并等待 source 清理完成后再返回。普通网络 GET 这些路径会返回 426，不保留 SSE 回退；受保护的进程内 SSE 路径会消费并释放同一租约约定，显式不带 security 的 `toFetchHandler` 仅作为协议测试 helper。

## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **History 会恢复未附加的会话**：打开 history 可能创建宿主侧 agent，并增加首次打开的延迟；没有仅从持久化读取的路径。
- **`/api` 桥会在 Fetch security handler 运行前把每个请求体整体缓冲在内存里**：`maxRequestBodyBytes`（默认 160 MiB，按默认 100 MiB 图片总量上限经 base64 膨胀加信封余量得出）因此同时是单请求的驻留内存上界；即使凭证最终被拒绝，只要通过外层 Host/socket 信任栅栏，也可能消耗该上界。若不缩小图片限额，需要流式 Request 或 bridge 认证预检才能关闭这个资源成本窗口。
