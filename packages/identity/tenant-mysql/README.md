# @deepseek-ai/dsh-tenant-mysql

English | [中文](README.zh.md)

MySQL Service Provider for the [`dsh-tenant`](../tenant) tenant and membership directory. It supplies `ctx.tenants` through the shared `dsh-mysql` connection service and owns only the tenant-directory schema and SQL.

## Composition

Mount one [`dsh-mysql`](../../multi/mysql) service before this plugin. Plugin activation creates or verifies the `dsh_tenant_schema` metadata table and the `dsh_tenants` and `dsh_tenant_memberships` data tables. An existing schema version other than `TENANT_MYSQL_SCHEMA_VERSION` rejects activation; this pre-release Provider does not migrate incompatible data.

```yaml
- name: mysql
  package: '@deepseek-ai/dsh-mysql'
  config:
    host: mysql.internal
    user: dsh
    password: secret
    database: harness
- name: tenants
  package: '@deepseek-ai/dsh-tenant-mysql'
```

Consumers use the provider-neutral API:

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'

export async function disableNewTenantMember(ctx: Context): Promise<void> {
  const tenant = await ctx.tenants.create({ displayName: 'Acme' })
  const added = await ctx.tenants.addMember({ tenantId: tenant.tenantId, userId: userId('user-1') })
  await ctx.tenants.disableMembership({
    tenantId: added.tenantId,
    userId: added.userId,
    expectedRevision: added.revision,
  })
}
```

Mount exactly one `ctx.tenants` Provider. This package has no configuration because table names, indexes, and schema identity are owned persistent-format constants rather than deployment tunables.

## Persistence

`dsh_tenants` stores the stable UUID `tenant_id`, optional display name, lifecycle status, epoch-millisecond timestamps, and monotonic revision. `dsh_tenant_memberships` stores one current slot per `(tenant_id, user_id)` with a unique `membership_id`. Re-adding a removed pair overwrites that slot with a new membership id and revision 1. Roles, teams, object grants, credentials, and sessions remain in their owning plugins.

Each tenant mutation leases one connection, locks the tenant row with `SELECT ... FOR UPDATE`, validates the expected revision and lifecycle transition, updates the row with a revision predicate, reads the committed record, and commits. Membership creation locks the tenant row first, then the membership slot, so a concurrent tenant disable and member add cannot deadlock or mix lock order. Membership status mutations lock only the membership slot. Expected absence and conflicts retain the `dsh-tenant` failure codes. Connection, SQL, malformed-row, and transaction failures become `provider-unavailable` without exposing SQL or driver diagnostics.

List operations use ascending `membership_id` keyset pagination. The opaque cursor carries the last returned id, the selected status, and the tenant or user scope; malformed cursors and reuse with a different filter or scope fail as `invalid-input`.

## Model Experience

### MySQL tenant records

#### What the model sees

Nothing. The Provider is Host-only and registers no tool, prompt, message, or Session event. The `dsh-tenant` service emits its existing sanitized process-local change events after this Provider commits.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: database reads and mutations do not change a request prefix.

## Known Limitations and Deferred Work

- **Schema version 1 only** - incompatible versions fail activation; a later release must add explicit migrations before persistent compatibility is promised.
- **No transactional outbox** - `tenant/changed` and `tenant/membership-changed` remain process-local and follow commit; durable audit delivery needs a separately owned outbox and relay.
- **No physical erasure** - directory deletion and membership removal are terminal soft changes as required by `dsh-tenant`.
- **Single database binding** - this Provider uses the one injected `ctx.mysql` service and does not select a database per request or tenant.
