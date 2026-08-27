# @deepseek-ai/dsh-team-mysql

English | [中文](README.zh.md)

MySQL Service Provider for the [`dsh-team`](../team) team and membership directory. It supplies `ctx.teams` through the shared `dsh-mysql` connection service and owns only the team-directory schema and SQL.

## Composition

Mount one [`dsh-mysql`](../../multi/mysql) service before this plugin. Plugin activation creates or verifies the `dsh_team_schema` metadata table and the `dsh_teams` and `dsh_team_memberships` data tables. An existing schema version other than `TEAM_MYSQL_SCHEMA_VERSION` rejects activation; this pre-release Provider does not migrate incompatible data.

```yaml
- name: mysql
  package: '@deepseek-ai/dsh-mysql'
  config:
    host: mysql.internal
    user: dsh
    password: secret
    database: harness
- name: teams
  package: '@deepseek-ai/dsh-team-mysql'
```

Consumers use the provider-neutral API:

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-team'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'

export async function kickTeamMember(ctx: Context): Promise<void> {
  const owner = tenantId('tenant-1')
  const team = await ctx.teams.create({ tenantId: owner, displayName: 'Platform' })
  const added = await ctx.teams.addMember({
    teamId: team.teamId,
    tenantId: owner,
    userId: userId('user-1'),
  })
  await ctx.teams.removeMembership({
    teamId: added.teamId,
    userId: added.userId,
    expectedRevision: added.revision,
  })
}
```

Mount exactly one `ctx.teams` Provider. This package has no configuration because table names, indexes, and schema identity are owned persistent-format constants rather than deployment tunables.

## Persistence

`dsh_teams` stores the stable UUID `team_id`, owning `tenant_id`, optional display name, lifecycle status, epoch-millisecond timestamps, and monotonic revision. `dsh_team_memberships` stores one current slot per `(team_id, user_id)` with a unique `membership_id` and a copied `tenant_id`. The membership table has no action, role, or grant columns. Re-adding a removed pair overwrites that slot with a new membership id and revision 1.

Each team mutation leases one connection, locks the team row with `SELECT ... FOR UPDATE`, validates the expected revision and lifecycle transition, updates the row with a revision predicate, reads the committed record, and commits. Membership creation locks the team row first, then the membership slot, and rejects a claimed tenant that does not own the locked team. Kick is revoke: status and revision change in the same membership update, and `team/membership-changed` is emitted only after commit. Expected absence and conflicts retain the `dsh-team` failure codes. Connection, SQL, malformed-row, and transaction failures become `provider-unavailable` without exposing SQL or driver diagnostics.

List operations use ascending `membership_id` keyset pagination. The opaque cursor carries the last returned id, the selected status, and the team or user-and-tenant scope; malformed cursors and reuse with a different filter or scope fail as `invalid-input`.

## Model Experience

### MySQL team records

#### What the model sees

Nothing. The Provider is Host-only and registers no tool, prompt, message, or Session event. The `dsh-team` service emits its existing sanitized process-local change events after this Provider commits.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: database reads and mutations do not change a request prefix.

## Known Limitations and Deferred Work

- **Schema version 1 only** - incompatible versions fail activation; a later release must add explicit migrations before persistent compatibility is promised.
- **No transactional outbox** - `team/changed` and `team/membership-changed` remain process-local and follow commit; durable audit delivery needs a separately owned outbox and relay.
- **No physical erasure** - directory deletion and membership revoke are terminal soft changes as required by `dsh-team`.
- **Single database binding** - this Provider uses the one injected `ctx.mysql` service and does not select a database per request or tenant.
