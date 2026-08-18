# @deepseek-ai/dsh-mysql

[English](README.md) | 中文

供关系数据领域插件使用的仅限 Host 的 MySQL 连接服务。该包公开 `ctx.mysql.connection(callback)`，拥有一个 `mysql2` 连接池，在启动期间校验连通性，在重用每个租用连接前重置服务端 session，并在关闭连接池前等待已接纳回调完成。它实现 [dsh-mysql 基础设施提案](../../../docs/infrastructure/dsh-mysql.md)的第一阶段；认证、会话持久化、设置、审计和其他领域仍是独立消费方，并拥有自身数据表与 SQL。

## 配置

| 配置键 | 必需 | 含义 |
|---|---|---|
| `host` | 是 | MySQL 服务端主机名或 IP 地址 |
| `port` | 否 | TCP 端口；默认为 `3306` |
| `user` | 是 | 数据库启动用户 |
| `password` | 是 | 启动密码；配置 schema 将其标记为 secret |
| `database` | 是 | 每个池连接选择的数据库 |
| `connectionLimit` | 否 | 连接池最大连接数；默认为 `10` |
| `connectTimeoutMs` | 否 | 建立连接的超时时间，单位为毫秒；默认为 `10000`，且不得超过 `2147483647` |

服务无法获取连接并完成 ping 时，插件启动失败。该包不记录配置或连接错误，因此包自身的诊断不会复制密码和连接参数。

## 连接生命周期

`connection(callback)` 接纳一个操作，等待连接池分配连接，然后使用 `MysqlConnection` façade 调用 callback。该 façade 不包含连接池生命周期方法和原始驱动状态；callback 结算后，它以及通过它获取的 prepared statement 都会拒绝操作，而从 callback 返回其中任一对象会使该租用操作失败。Callback 结算后，服务会发送 MySQL `COM_RESET_CONNECTION`，从而回滚未结束的 transaction 并清除 session variable 和临时状态，然后在释放租用连接前重新选择配置的 database。Reset 或 database 恢复失败时，服务会销毁该连接，不会把状态不确定的连接放回池中；清理过程不会覆盖 callback 原本的结果或错误。资源释放会停止接纳新操作，等待所有已接纳回调，包括仍在连接池中排队的调用方和连接重置，并且只在清理完成后调用 `pool.end()`。

## 模型体验

### MySQL 连接

#### 模型看到的内容

无。只有可信 Host 插件可以使用 `ctx.mysql`；面向模型的 Cordis API 目录不包含它，动态 Host 沙箱也会拒绝声明注入、可选 `ctx.get()` 查询和 `ctx.provide()` 注册。该包不注册工具、提示词、消息或会话事件。

#### Token 影响

每次请求都不会直接增加 token。

#### KV Cache 影响

与模型请求相互独立：数据库连接活动不会改变请求前缀。

## 已知限制与暂缓事项

- **仅提供连接 API**：尚未实现事务、migration、错误分类、查询超时、取消、健康状态报告和可观测性。
- **仅支持一个 TCP 目标**：具名 binding、Unix socket、TLS 策略、replica 和独立 migration credential 仍暂缓实现。
- **回调等待没有时限**：资源释放会无限等待已接纳回调；调用方必须让数据库工作结算。
