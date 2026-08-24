# @deepseek-ai/dsh-user-mysql

English | [中文](README.zh.md)

MySQL Service Provider for the [`dsh-user`](../user) human user directory. It supplies `ctx.users` through the shared `dsh-mysql` connection service and owns only the user-directory schema and SQL.

## Composition

Mount one [`dsh-mysql`](../../multi/mysql) service before this plugin. Plugin activation creates or verifies the `dsh_user_schema` metadata table and the `dsh_users` data table. An existing schema version other than `USER_MYSQL_SCHEMA_VERSION` rejects activation; this pre-release Provider does not migrate incompatible data.

```yaml
- name: mysql
  package: '@deepseek-ai/dsh-mysql'
  config:
    host: mysql.internal
    user: dsh
    password: secret
    database: harness
- name: users
  package: '@deepseek-ai/dsh-user-mysql'
```

Consumers use the provider-neutral API:

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-user'

export async function disableNewUser(ctx: Context): Promise<void> {
  const created = await ctx.users.create({ displayName: 'Alice' })
  const current = await ctx.users.requireActive(created.userId)
  await ctx.users.disable({ userId: current.userId, expectedRevision: current.revision })
}
```

Mount exactly one `ctx.users` Provider. This package has no configuration because table names, indexes, and schema identity are owned persistent-format constants rather than deployment tunables.

## Persistence

`dsh_users` stores the stable UUID `user_id`, optional display name, lifecycle status, epoch-millisecond timestamps, monotonic revision, and JSON extensions. It has a binary primary key and a `(status, user_id)` index. Usernames, password verifiers, external identities, roles, tenant memberships, tokens, and sessions remain in their owning plugins.

Each mutation leases one connection, locks the target row with `SELECT ... FOR UPDATE`, validates the expected revision and lifecycle transition, updates the row with a revision predicate, reads the committed record, and commits. Expected absence and conflicts retain the `dsh-user` failure codes. Connection, SQL, malformed-row, and transaction failures become `provider-unavailable` without exposing SQL or driver diagnostics.

List operations use ascending `user_id` keyset pagination. The opaque cursor carries the last returned id and the selected status; malformed cursors and reuse with a different status fail as `invalid-input`.

## Model Experience

### MySQL user records

#### What the model sees

Nothing. The Provider is Host-only and registers no tool, prompt, message, or Session event. The `dsh-user` service emits its existing sanitized process-local change event after this Provider commits.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: database reads and mutations do not change a request prefix.

## Known Limitations and Deferred Work

- **Schema version 1 only** - incompatible versions fail activation; a later release must add explicit migrations before persistent compatibility is promised.
- **No transactional outbox** - `user/changed` remains process-local and follows commit; durable audit delivery needs a separately owned outbox and relay.
- **No physical erasure** - directory deletion is terminal soft deletion as required by `dsh-user`.
- **Single database binding** - this Provider uses the one injected `ctx.mysql` service and does not select a database per request or tenant.
