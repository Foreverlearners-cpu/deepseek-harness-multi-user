# DeepSeek Harness Multi-User

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Multi-user edition

This fork is evolving DeepSeek Harness from a single-user agent runtime into a multi-user platform. It preserves the plugin architecture while adding shared infrastructure, user identity, authentication, authorization, and an operational Web UI.

| Layer | Scope | Progress |
|---|---|---|
| Infrastructure | Kafka transport and typed events, MySQL persistence, Redis cache invalidation, Elasticsearch search projections, and CDC pipelines | Foundation complete |
| Identity and authentication | User directory, credential storage, token lifecycle, and authentication runtime | In progress |
| Authorization | Unified authentication and permission validation across user-facing operations | Planned |
| Management experience | A graphical interface for users, access control, and system operations | Planned |

The design separates durable domain state from projections and cache state: MySQL owns persistence, Kafka carries change events, CDC coordinates propagation, Redis handles invalidation, and Elasticsearch serves search. This foundation lets authentication and authorization evolve without coupling user-facing workflows to one storage engine.

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI, served at `http://127.0.0.1:3080` by default. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## Authentication suite

The authentication suite provides a complete Host-only account path without coupling authentication to HTTP routing or authorization policy. The default [`dsh-auth-starter`](packages/identity/auth-starter/README.md) entry assembles MySQL-backed users, login credentials, refresh-token families, durable registration, Password and JWT authentication, account operations, and a transport-neutral gateway. Applications normally mount the Starter instead of wiring every package independently.

### Packages and responsibilities

| Layer | Packages | Responsibility |
|---|---|---|
| Authentication contract | [`dsh-auth`](packages/identity/auth/README.md) | Selects exactly one Provider by evidence kind, authenticates untrusted evidence, mints process-local `AuthenticatedCall` values, and checks their current provenance. |
| User directory | [`dsh-user`](packages/identity/user/README.md), [`dsh-user-mysql`](packages/identity/user-mysql/README.md) | Defines stable users, profile and lifecycle revisions, then persists that directory in MySQL. |
| Login credentials | [`dsh-user-credential`](packages/identity/user-credential/README.md), [`dsh-user-credential-mysql`](packages/identity/user-credential-mysql/README.md) | Defines normalized identifiers and password state; the MySQL Provider owns uniqueness, scrypt verifiers, transactions, and dummy verification. |
| Refresh state | [`dsh-auth-token`](packages/identity/auth-token/README.md), [`dsh-auth-token-mysql`](packages/identity/auth-token-mysql/README.md) | Defines opaque refresh families, digest-only persistence, atomic rotation, replay detection, inspection, and revocation. |
| Account orchestration | [`dsh-account`](packages/identity/account/README.md), [`dsh-account-mysql`](packages/identity/account-mysql/README.md) | Coordinates registration, login, refresh, logout, profile/password changes, and durable idempotent registration progress. |
| Authentication Providers | [`dsh-auth-password`](packages/identity/auth-password/README.md), [`dsh-auth-jwt`](packages/identity/auth-jwt/README.md) | Verifies password evidence and independently signs and validates short-lived Access JWTs and rotating Refresh JWTs. |
| Entry and composition | [`dsh-auth-gateway`](packages/identity/auth-gateway/README.md), [`dsh-auth-starter`](packages/identity/auth-starter/README.md) | Enforces HTTP/WebSocket credential carriers and composes the complete MySQL suite in dependency order. |

`dsh-user`, `dsh-user-credential`, and `dsh-auth-token` are Provider-neutral service definitions. Their MySQL packages own durable data; Password and JWT packages consume those services without owning their tables.

### Request lifecycle

1. **Register:** the adapter calls `ctx.authGateway.register()`, `ctx.accounts` records durable progress, creates the user, adds the normalized identifier, sets the password, and returns the completed `UserRecord`.
2. **Log in:** the gateway passes the identifier and password to `ctx.accounts`; `dsh-auth-password` resolves the identifier and performs real or dummy verification, active-user state is checked, and `dsh-auth-jwt` creates an Access JWT, Refresh JWT, and server-side refresh family.
3. **Protect a request:** an Authorization Bearer reaches `authenticateHttp()`; the JWT Provider verifies signature, issuer, audience, Token type, expiry, family state, and active-user state. The gateway returns a process-local `AuthenticatedCall`, and `guard()` checks it again immediately before protected work.
4. **Refresh:** the gateway requires the configured Refresh Cookie, an exact allowed Origin, and matching CSRF header and readable Cookie. It verifies the Refresh JWT and atomically rotates the opaque server-side Credential; the returned directive sets the replacement Refresh Cookie as Secure and HttpOnly, and replaying a rotated Refresh JWT revokes the whole family.
5. **Log out:** the gateway authenticates the Access Bearer, revalidates the call, revokes every JWT family for that user, and returns directives that clear the Refresh and CSRF Cookies.

### Run the complete MySQL suite from source

After the source installation above, link the Starter into the Web profile:

```sh
pnpm dsh plugin --profile web add ./packages/identity/auth-starter
```

Create `auth.cordis.yml` in the repository root. The values and field names below are the Starter's published Cordis configuration:

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

The Starter mounts only the Host-side `ctx.authGateway` service. It does not add HTTP routes, framework middleware, or a Web login UI; a framework adapter must translate native requests and responses to and from the gateway API before users can register or log in.

Generate a 32-byte key with Node.js on Windows, macOS, or Linux, then set the printed value as the `DSH_AUTH_JWT_SECRET` environment variable for the Harness process. Do not paste the value into this file or commit it:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Start the Web profile with the patch:

```sh
pnpm dsh web --patch ./auth.cordis.yml
```

`DSH_AUTH_JWT_SECRET` must be the canonical Base64url encoding of 32-128 random bytes. MySQL credentials and JWT signing material are mandatory; the Starter has no production secret defaults. The MySQL account must be allowed to create and use the suite-owned tables.

### Call the public gateway

Framework adapters pass structured headers, parsed Cookies, decoded Query entries, and bounded body fields to `ctx.authGateway`. This example uses the same public registration, login, Access Bearer, and `guard()` APIs exercised by the Starter tests:

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

Login returns adapter-neutral Cookie directives: the Refresh value defaults to the Secure, HttpOnly, SameSite=Strict `__Host-dsh_refresh` Cookie, while `__Host-dsh_csrf` carries the readable double-submit value. Adapters must use maintained Cookie parsers and must not log request objects, session results, tokens, passwords, or Cookie directives.

### Security boundaries

- Access and Refresh JWTs are distinct signed artifacts and are accepted only by their own flows; Refresh also requires current server-side family state.
- Refresh rotation is single-use. Reuse of an old Refresh JWT revokes the family rather than issuing another session.
- `AuthenticatedCall` is Host-only, process-local authority. It must not cross JSON, RPC, session storage, or another process.
- `dsh-auth-gateway` returns structured operations and Cookie directives; it is not an HTTP router or framework middleware.
- The Starter mounts account administration but no administrator authorizer. Administration fails closed until one explicit authorization Provider is registered.
- Rate limiting, lockout, recovery, RBAC, tenant derivation, and long-lived WebSocket expiry policy remain separate plugins.

For the complete contracts, see the [Starter guide](packages/identity/auth-starter/README.md), [authentication runtime](docs/subsystems/authentication.md), [user directory](docs/subsystems/user-directory.md), [user credentials](docs/subsystems/user-credentials.md), [refresh-token lifecycle](docs/subsystems/auth-token.md), and generated [configuration catalog](docs/config-catalog.md).

## Quick MySQL, Kafka, Redis, and Elasticsearch setup

The following example publishes row changes made to `app.users` after startup to Kafka, then projects them independently into Redis and Elasticsearch. It uses the generic CDC plugins; for the session-specific composition, see [`dsh-session-cdc-starter`](packages/session/session-cdc-starter/README.md).

### 1. Prepare external resources

- MySQL must use `log_bin=ON`, `binlog_format=ROW`, `binlog_row_image=FULL`, and `binlog_row_metadata=FULL`. The CDC account needs `REPLICATION CLIENT`, `REPLICATION SLAVE`, and `SELECT` on each routed table.
- Pre-create the Kafka topic `dsh.cdc.users`; this project does not auto-create topics.
- Pre-create the Elasticsearch target index `dsh-users-v1` and the permanently retained ordering-state index `dsh-cdc-state-v1`.
- Redis needs no pre-created keys, but each deployment should have its own database or key prefix.

Check MySQL first:

```sql
SHOW VARIABLES WHERE Variable_name IN
  ('log_bin', 'binlog_format', 'binlog_row_image', 'binlog_row_metadata');
SHOW GRANTS FOR 'dsh_cdc'@'%';
```

### 2. Enter connection details

These plugins are not mounted in the Web profile by default. For a source checkout, link them into that profile from the repository root after `pnpm install` and `pnpm run build`:

```sh
pnpm dsh plugin --profile web add ./packages/multi/kafka ./packages/multi/redis ./packages/multi/elasticsearch ./packages/multi/cdc ./packages/multi/cdc-redis ./packages/multi/cdc-elasticsearch
```

Create `cdc.cordis.yml` in the repository root and replace the sample endpoints, credentials, database, table, and primary key:

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

Do not commit production passwords to Git. Cordis JavaScript values can read them from environment variables instead:

```yaml
password: !!js process.env.DSH_MYSQL_CDC_PASSWORD
```

For Kafka TLS or SASL, fill in `tls` and `sasl` as described in the [`dsh-kafka` configuration guide](packages/multi/kafka/README.md). A trusted local plaintext Elasticsearch node requires explicit `allowInsecureHttp: true`.

### 3. Start and verify

```sh
pnpm dsh web --patch ./cdc.cordis.yml
```

After startup, insert or update one MySQL row and verify that:

- Kafka receives a CDC event on `dsh.cdc.users`;
- Redis contains a JSON key beginning with `dsh:users:`;
- Elasticsearch contains the corresponding document in `dsh-users-v1`;
- `checkpointFile` advances and is reused after a restart.

Redis and Elasticsearch must use different consumer groups. Sharing a group would split records between them instead of delivering every record to both. `fallbackMode: latest` processes only records published after a new consumer starts; use `earliest` for an intentional first-time replay. CDC does not copy historical MySQL rows, so existing data requires a separate initial import or reconciliation.

`serverId` must be unique among replication clients connected to the same MySQL server. Every `excludeColumns` entry must exist in the table; remove the sample `password_hash` entry if your table does not have that column. See the [configuration catalog](docs/config-catalog.md) for every field constraint.

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.

- Join the DeepSeek Harness WeCom group by scanning the assistant QR code and completing the survey; the assistant will invite you after submission.

<table>
  <thead>
    <tr>
      <th align="center">WeCom assistant</th>
      <th align="center">Group survey</th>
      <th align="center">WeChat official account</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="assets/community-wecom-assistant.png" alt="DeepSeek Harness WeCom assistant QR code" width="180" height="180"></td>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="assets/community-wecom-survey.png" alt="DeepSeek Harness group survey QR code" width="180" height="180"></a></td>
      <td align="center"><img src="assets/community-wechat-official-account.png" alt="DeepSeek Harness WeChat official account QR code" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
