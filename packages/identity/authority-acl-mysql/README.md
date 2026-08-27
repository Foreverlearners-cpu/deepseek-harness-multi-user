# @deepseek-ai/dsh-authority-acl-mysql

English | [中文](README.zh.md)

MySQL Service Provider for the [`dsh-authority-acl`](../authority-acl) `AclPolicySource`. It supplies `ctx.authorityAclMysql` through the shared `dsh-mysql` connection service, registers itself on `ctx.authorityAcl`, and owns only the object-grant schema and SQL.

## Composition

Mount `ctx.auth`, `ctx.authority`, `ctx.teams`, `ctx.authorityAcl`, and one [`dsh-mysql`](../../multi/mysql) service before this plugin. Plugin activation creates or verifies the `dsh_acl_schema` metadata table and the `dsh_resource_action_grants` data table, then registers this instance as the sole policy source. An existing schema version other than `AUTHORITY_ACL_MYSQL_SCHEMA_VERSION` rejects activation; this pre-release Provider does not migrate incompatible data.

```yaml
- name: mysql
  package: '@deepseek-ai/dsh-mysql'
  config:
    host: mysql.internal
    user: dsh
    password: secret
    database: harness
- name: auth
  package: '@deepseek-ai/dsh-auth'
- name: authority
  package: '@deepseek-ai/dsh-authority'
- name: teams
  package: '@deepseek-ai/dsh-team-mysql'
- name: authorityAcl
  package: '@deepseek-ai/dsh-authority-acl'
- name: authorityAclMysql
  package: '@deepseek-ai/dsh-authority-acl-mysql'
```

Consumers write already-authorized grants through `ctx.authorityAclMysql` and evaluate through `ctx.authorityAcl`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-authority-acl'
import '@deepseek-ai/dsh-authority-acl-mysql'
import { actionCode, resourceId, resourceType } from '@deepseek-ai/dsh-authority'
import { teamId } from '@deepseek-ai/dsh-team'

export async function grantResearchTeamExecute(ctx: Context): Promise<void> {
  await ctx.authorityAclMysql.grant({
    resource: { type: resourceType('plugin'), id: resourceId('plugin-100') },
    subject: { kind: 'team', id: teamId('team-rd') },
    use: [actionCode('plugin:execute')],
    delegate: [],
  }, 1)
}
```

Mount exactly one `ctx.authorityAcl` Provider and exactly one policy source. This package has no configuration because table names, indexes, and schema identity are owned persistent-format constants rather than deployment tunables. `grant` and `revoke` persist rows only; they do not call `ctx.authority.decide` or `require`.

## Persistence

`dsh_resource_action_grants` stores one row per `(resource_type, resource_id, resource_revision, subject_ref)`. A team subject is the encoded ref `g:team-rd` and stays one row. Adding or kicking members does not insert or delete grant rows. Use and Delegate action arrays are JSON columns. Replacing a grant increments the row revision. Revoke sets `revoked` and increments revision in the same update.

`listGrants` returns active grants for a resource type and id. `listGrantsAt` returns active grants for one resource revision so plugin-100 revision 1 cannot read revision 2 or plugin-200. Connection, SQL, malformed-row, and transaction failures become `provider-unavailable` without exposing SQL or driver diagnostics.

This Provider does not store `principal_roles`, does not compute Effective, and does not call `ctx.teams`. Live membership matching stays in `dsh-authority-acl`.

## Model Experience

### MySQL object grants

#### What the model sees

Nothing. The Provider is Host-only and registers no tool, prompt, message, or Session event. `ctx.authorityAcl.evaluate` remains Host-only after this Provider commits a grant change.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: database reads and mutations do not change a request prefix.

## Known Limitations and Deferred Work

- **Schema version 1 only** - incompatible versions fail activation; a later release must add explicit migrations before persistent compatibility is promised.
- **No role catalog** - role-subject matching still asks a registered fact source; this package does not read `principal_roles`.
- **No Effective computation** - same-team intersection stays in `dsh-authority`.
- **No decide on write** - callers must authorize a grant before calling `grant`; this Provider does not re-check.
- **Single database binding** - this Provider uses the one injected `ctx.mysql` service and does not select a database per request or tenant.
