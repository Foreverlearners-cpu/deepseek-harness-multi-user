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
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
