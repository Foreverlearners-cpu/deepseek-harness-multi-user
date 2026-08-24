# DeepSeek Harness Multi-User

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它采用**一切皆插件**的架构，并由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)。

## 多用户版本

这个 fork 正在把 DeepSeek Harness 从单用户 agent runtime（智能体运行时）扩展为多用户平台。项目保留原有插件架构，并在其上增加共享基础设施、用户身份、认证、授权和运维 Web UI。

| 层级 | 范围 | 进度 |
|---|---|---|
| 基础设施 | Kafka 传输与类型化事件、MySQL 持久化、Redis 缓存失效、Elasticsearch 搜索投影和 CDC 流水线 | 基础已完成 |
| 身份与认证 | 用户目录、凭据存储、token 生命周期和认证运行时 | 开发中 |
| 授权 | 面向用户操作的统一身份校验与权限验证 | 规划中 |
| 管理体验 | 面向用户、访问控制和系统运维的图形化界面 | 规划中 |

整体设计将持久化领域状态与投影、缓存状态分离：MySQL 负责持久化，Kafka 传递变更事件，CDC 协调传播，Redis 处理失效，Elasticsearch 提供搜索。这套基础让认证与授权可以独立演进，避免用户工作流与单一存储引擎耦合。

## 开发者预览

DeepSeek Harness 目前处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

## 运行

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令会启动 Web UI，默认地址为 `http://127.0.0.1:3080`。详见 [Web UI 指南](docs/user/guide/index.md)。

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## 认证套件

认证套件提供完整的 Host 侧账号流程，同时不把认证与 HTTP 路由或授权策略耦合。默认的 [`dsh-auth-starter`](packages/identity/auth-starter/README.md) 入口会装配由 MySQL 支撑的用户、登录凭据、Refresh Token Family、持久化注册、Password 与 JWT 认证、账号操作和传输无关网关。应用通常挂载 Starter，而不是逐个连接所有包。

### 包与职责

| 层级 | 包 | 职责 |
|---|---|---|
| 认证契约 | [`dsh-auth`](packages/identity/auth/README.md) | 按 evidence kind 精确选择一个 Provider，对不可信 evidence 进行认证，签发进程内 `AuthenticatedCall`，并检查其当前来源。 |
| 用户目录 | [`dsh-user`](packages/identity/user/README.md)、[`dsh-user-mysql`](packages/identity/user-mysql/README.md) | 定义稳定用户、资料和生命周期 revision，再把该目录持久化到 MySQL。 |
| 登录凭据 | [`dsh-user-credential`](packages/identity/user-credential/README.md)、[`dsh-user-credential-mysql`](packages/identity/user-credential-mysql/README.md) | 定义归一化标识和密码状态；MySQL Provider 负责唯一性、scrypt verifier、事务和 dummy verification。 |
| Refresh 状态 | [`dsh-auth-token`](packages/identity/auth-token/README.md)、[`dsh-auth-token-mysql`](packages/identity/auth-token-mysql/README.md) | 定义不透明 Refresh Family、仅 digest 持久化、原子轮换、重放检测、检查和撤销。 |
| 账号编排 | [`dsh-account`](packages/identity/account/README.md)、[`dsh-account-mysql`](packages/identity/account-mysql/README.md) | 协调注册、登录、刷新、退出、资料和密码修改，以及持久化、幂等的注册进度。 |
| 认证 Provider | [`dsh-auth-password`](packages/identity/auth-password/README.md)、[`dsh-auth-jwt`](packages/identity/auth-jwt/README.md) | 验证密码 evidence，并分别签发和验证短期 Access JWT 与轮换式 Refresh JWT。 |
| 入口与组合 | [`dsh-auth-gateway`](packages/identity/auth-gateway/README.md)、[`dsh-auth-starter`](packages/identity/auth-starter/README.md) | 约束 HTTP/WebSocket 凭据载体，并按依赖顺序组合完整 MySQL 套件。 |

`dsh-user`、`dsh-user-credential` 和 `dsh-auth-token` 是 Provider-neutral 服务定义。对应 MySQL 包拥有持久化数据；Password 和 JWT 包消费这些服务，但不拥有其数据表。

### 请求生命周期

1. **注册：**adapter 调用 `ctx.authGateway.register()`；`ctx.accounts` 记录持久化进度，创建用户，加入归一化标识，设置密码，并返回完成后的 `UserRecord`。
2. **登录：**网关把标识与密码交给 `ctx.accounts`；`dsh-auth-password` 解析标识并执行真实或 dummy verification，系统检查用户仍为 active，随后 `dsh-auth-jwt` 创建 Access JWT、Refresh JWT 和服务端 Refresh Family。
3. **保护请求：**Authorization Bearer 进入 `authenticateHttp()`；JWT Provider 验证签名、issuer、audience、Token type、有效期、Family 状态和 active 用户状态。网关返回进程内 `AuthenticatedCall`，`guard()` 在受保护操作前再次检查它。
4. **刷新：**网关要求已配置的 Refresh Cookie、完全匹配的 allowed Origin，以及相同的 CSRF header 与可读 Cookie。系统验证 Refresh JWT，并原子轮换服务端不透明 Credential；返回的 directive 会把替代 Refresh Cookie 设置为 Secure 和 HttpOnly，重放已轮换的 Refresh JWT 则会撤销整个 Family。
5. **退出：**网关认证 Access Bearer，再次校验 call，撤销该用户的所有 JWT Family，并返回清除 Refresh 与 CSRF Cookie 的指令。

### 从源码运行完整 MySQL 套件

完成前面的源码安装后，把 Starter 链接到 Web profile：

```sh
pnpm dsh plugin --profile web add ./packages/identity/auth-starter
```

在仓库根目录创建 `auth.cordis.yml`。下面的值和字段名来自 Starter 对外发布的 Cordis 配置：

```yaml
- insert:
    - id: authentication
      name: '@deepseek-ai/dsh-auth-starter'
      config:
        mysql:
          host: 127.0.0.1
          user: dsh
          password: !!js env.DSH_MYSQL_PASSWORD
          database: dsh
        jwt:
          issuer: https://auth.example
          audience: dsh-web
          activeKeyId: primary
          keys:
            - keyId: primary
              secret: !!js env.DSH_AUTH_JWT_SECRET
        gateway:
          allowedOrigins: [https://app.example]
```

Starter 只挂载 Host 侧 `ctx.authGateway` 服务。它不会添加 HTTP route、framework middleware 或 Web 登录 UI；用户能够注册或登录之前，framework adapter 必须在原生请求、响应与 Gateway API 之间完成转换。

可在 Windows、macOS 或 Linux 上用 Node.js 生成 32 字节密钥，再把命令打印的值设置为 Harness 进程的 `DSH_AUTH_JWT_SECRET` 环境变量。不要把该值粘贴到本文档或提交到 Git：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

使用该 patch 启动 Web profile：

```sh
pnpm dsh web --patch ./auth.cordis.yml
```

`DSH_AUTH_JWT_SECRET` 必须是 32-128 个随机字节的规范 Base64url 编码。MySQL 凭据和 JWT 签名材料均为必填项；Starter 不提供生产 Secret 默认值。MySQL 账号必须有权创建和使用套件自有表。

### 调用公开网关

Framework adapter 把结构化 Header、解析后的 Cookie、解码后的 Query entry 和有界 Body 字段传给 `ctx.authGateway`。下面的示例使用 Starter 测试覆盖的同一组公开注册、登录、Access Bearer 和 `guard()` API：

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-auth-gateway'

const signal = new AbortController().signal

export async function registerAndAuthenticate(ctx: Context): Promise<string> {
  const user = await ctx.authGateway.register({
    requestId: 'register-1',
    signal,
    identifier: { kind: 'username', value: 'alice' },
    password: 'correct horse battery staple',
    displayName: 'Alice',
  })

  const login = await ctx.authGateway.login({
    requestId: 'login-1',
    signal,
    identifier: { kind: 'username', value: 'alice' },
    password: 'correct horse battery staple',
  })

  const call = await ctx.authGateway.authenticateHttp({
    requestId: 'request-1',
    signal,
    headers: [{ name: 'Authorization', value: `Bearer ${login.accessToken}` }],
  })

  return ctx.authGateway.guard(call, current => current.principal.id === user.userId
    ? current.principal.id
    : Promise.reject(new Error('authenticated user changed')))
}
```

登录返回 adapter-neutral Cookie 指令：Refresh 值默认放在 Secure、HttpOnly、SameSite=Strict 的 `__Host-dsh_refresh` Cookie 中，`__Host-dsh_csrf` 则携带可读的 double-submit 值。Adapter 必须使用维护良好的 Cookie parser，且不得记录 request object、session result、Token、密码或 Cookie 指令。

### 安全边界

- Access 与 Refresh JWT 是不同的签名产物，只能进入各自流程；Refresh 还要求服务端 Family 状态保持有效。
- Refresh 只能轮换一次。复用旧 Refresh JWT 会撤销 Family，而不是签发另一个 Session。
- `AuthenticatedCall` 是 Host-only、进程内 authority，不得跨越 JSON、RPC、Session 存储或进程。
- `dsh-auth-gateway` 返回结构化操作和 Cookie 指令；它不是 HTTP Router 或 framework middleware。
- Starter 会挂载账号管理服务，但不挂载管理员 authorizer。在显式注册授权 Provider 前，管理操作默认拒绝。
- Rate limit、lockout、recovery、RBAC、tenant 派生和长连接 WebSocket 过期策略仍由独立插件负责。

完整契约参见 [Starter 指南](packages/identity/auth-starter/README.md)、[认证运行时](docs/subsystems/authentication.md)、[用户目录](docs/subsystems/user-directory.md)、[用户凭据](docs/subsystems/user-credentials.md)、[Refresh Token 生命周期](docs/subsystems/auth-token.md)和生成的[配置目录](docs/config-catalog.md)。

## 快速接入 MySQL、Kafka、Redis 和 Elasticsearch

下面的示例会把 MySQL `app.users` 表启动后的行变化发送到 Kafka，再分别投影到 Redis 和 Elasticsearch。它使用通用 CDC 插件；Session 专用组合参见 [`dsh-session-cdc-starter`](packages/session/session-cdc-starter/README.md)。

### 1. 准备外部资源

- MySQL 必须启用 `log_bin=ON`、`binlog_format=ROW`、`binlog_row_image=FULL` 和 `binlog_row_metadata=FULL`。CDC 账号需要 `REPLICATION CLIENT`、`REPLICATION SLAVE` 和目标表的 `SELECT` 权限。
- 在 Kafka 中预先创建 `dsh.cdc.users` Topic；项目不会自动创建 Topic。
- 在 Elasticsearch 中预先创建业务索引 `dsh-users-v1` 和永久保留的顺序状态索引 `dsh-cdc-state-v1`。
- Redis 不需要预建 Key，但应给该部署分配独立的数据库或 Key 前缀。

可先检查 MySQL：

```sql
SHOW VARIABLES WHERE Variable_name IN
  ('log_bin', 'binlog_format', 'binlog_row_image', 'binlog_row_metadata');
SHOW GRANTS FOR 'dsh_cdc'@'%';
```

### 2. 填写连接信息

这些插件不会默认挂载到 Web profile。从源码运行时，先在仓库根目录把它们链接到该 profile（完成前面的 `pnpm install` 和 `pnpm run build` 后执行）：

```sh
pnpm dsh plugin --profile web add ./packages/multi/kafka ./packages/multi/redis ./packages/multi/elasticsearch ./packages/multi/cdc ./packages/multi/cdc-redis ./packages/multi/cdc-elasticsearch
```

在仓库根目录创建 `cdc.cordis.yml`，把示例地址、账号、密码、库名、表名和主键替换为自己的值：

```yaml
- insert:
    - id: kafka
      name: '@deepseek-ai/dsh-kafka'
      config:
        binding: 'main-kafka'
        brokers: ['kafka.example.com:9092']
        clientId: 'dsh-cdc'
        tls: false
        topics: ['dsh.cdc.users']
        consumerGroups: ['dsh-cdc-redis', 'dsh-cdc-elasticsearch']

    - id: redis
      name: '@deepseek-ai/dsh-redis'
      config:
        url: 'redis://username:password@redis.example.com:6379/0'

    - id: elasticsearch
      name: '@deepseek-ai/dsh-elasticsearch'
      config:
        node: 'https://elasticsearch.example.com:9200'
        auth:
          username: 'elastic'
          password: 'replace-me'
        maxRetries: 3
        requestTimeoutMs: 10000
        pingTimeoutMs: 5000

    - id: users-redis-projection
      name: '@deepseek-ai/dsh-cdc-redis'
      config:
        subscriptionId: 'users-redis'
        consumerGroup: 'dsh-cdc-redis'
        topics: ['dsh.cdc.users']
        fallbackMode: 'latest'
        routes:
          - database: 'app'
            table: 'users'
            topic: 'dsh.cdc.users'
            keyPrefix: 'dsh:users'

    - id: users-search-projection
      name: '@deepseek-ai/dsh-cdc-elasticsearch'
      config:
        subscriptionId: 'users-elasticsearch'
        consumerGroup: 'dsh-cdc-elasticsearch'
        topics: ['dsh.cdc.users']
        fallbackMode: 'latest'
        stateIndex: 'dsh-cdc-state-v1'
        routes:
          - database: 'app'
            table: 'users'
            topic: 'dsh.cdc.users'
            index: 'dsh-users-v1'

    - id: mysql-cdc
      name: '@deepseek-ai/dsh-cdc'
      config:
        host: 'mysql.example.com'
        port: 3306
        user: 'dsh_cdc'
        password: 'replace-me'
        serverId: 7102
        checkpointFile: './data/cdc/mysql-main.json'
        routes:
          - database: 'app'
            table: 'users'
            topic: 'dsh.cdc.users'
            primaryKey: ['id']
            excludeColumns: ['password_hash']
```

生产环境不要把密码提交到 Git。可以使用 Cordis 的 JavaScript 值从环境变量读取，例如：

```yaml
password: !!js process.env.DSH_MYSQL_CDC_PASSWORD
```

如果 Kafka 使用 TLS 或 SASL，请按 [`dsh-kafka` 配置说明](packages/multi/kafka/README.md)填写 `tls` 和 `sasl`；如果 Elasticsearch 是可信本机 HTTP，必须显式设置 `allowInsecureHttp: true`。

### 3. 启动和验证

```sh
pnpm dsh web --patch ./cdc.cordis.yml
```

启动成功后，在 MySQL 中新增或修改一行，再检查：

- Kafka `dsh.cdc.users` 出现一条 CDC 事件；
- Redis 出现以 `dsh:users:` 开头的 JSON Key；
- Elasticsearch `dsh-users-v1` 出现对应文档；
- `checkpointFile` 持续前进，重启后从上次位置继续。

Redis 和 Elasticsearch 必须使用不同的消费者组，否则两者会分摊消息，而不是各自收到完整事件。`fallbackMode: latest` 表示新消费者只处理启动后的消息；首次联调若需要重放 Topic 中已有消息，可改为 `earliest`。CDC 不复制历史数据，已有 MySQL 数据需要另行做一次初始化导入或对账。

`serverId` 必须在连接同一 MySQL 的复制客户端中唯一。`excludeColumns` 只能填写真实存在的字段；如果表中没有 `password_hash`，请删除该示例项。完整字段约束见[配置目录](docs/config-catalog.md)。

## 社区与支持

- 欢迎通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群：扫码添加企微小助手并填写入群问卷，完成后小助手会邀请你入群。

<table>
  <thead>
    <tr>
      <th align="center">企微小助手</th>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="assets/community-wecom-assistant.png" alt="DeepSeek Harness 企微小助手二维码" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="assets/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="assets/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

请先阅读[开发指南](docs/development.md)与[架构文档](docs/architecture.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
