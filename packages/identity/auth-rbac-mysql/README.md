# @deepseek-ai/dsh-auth-rbac-mysql

English | [中文](README.zh.md)

MySQL Service Provider for the [`dsh-auth-rbac`](../auth-rbac) `RbacPolicySource`. It supplies `ctx.authRbacMysql` through the shared `dsh-mysql` connection service, registers itself on `ctx.authRbac`, and owns only the RBAC schema and SQL.

## Composition

Mount `ctx.auth`, `ctx.authority`, `ctx.authRbac`, and one [`dsh-mysql`](../../multi/mysql) service before this plugin. Plugin activation creates or verifies the `dsh_rbac_schema` metadata table and the `dsh_role_action_grants` and `dsh_principal_roles` data tables, then registers this instance as the sole policy source. An existing schema version other than `AUTH_RBAC_MYSQL_SCHEMA_VERSION` rejects activation; this pre-release Provider does not migrate incompatible data.

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
- name: authRbac
  package: '@deepseek-ai/dsh-auth-rbac'
- name: authRbacMysql
  package: '@deepseek-ai/dsh-auth-rbac-mysql'
```

Consumers write roles and bindings through `ctx.authRbacMysql` and evaluate through `ctx.authRbac`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-auth-rbac'
import '@deepseek-ai/dsh-auth-rbac-mysql'
import { roleId } from '@deepseek-ai/dsh-auth-rbac'
import { actionCode } from '@deepseek-ai/dsh-authority'
import { teamId } from '@deepseek-ai/dsh-team'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'

export async function grantResearchRunner(ctx: Context): Promise<void> {
  await ctx.authRbacMysql.putRole({
    roleId: roleId('runner'),
    use: [actionCode('plugin:read'), actionCode('plugin:execute')],
    delegate: [],
  })
  await ctx.authRbacMysql.assign({
    userId: userId('user-1'),
    tenantId: tenantId('tenant-1'),
    teamId: teamId('team-rd'),
    roleId: roleId('runner'),
  })
}
```

Mount exactly one `ctx.authRbac` Provider and exactly one policy source. This package has no configuration because table names, indexes, and schema identity are owned persistent-format constants rather than deployment tunables.

## Persistence

`dsh_role_action_grants` stores one row per role id with JSON Use and Delegate action arrays, a monotonic revision, and an updated-at timestamp. Replacing a role's action sets increments revision so later `listRoleActions` and `evaluate` results cannot reuse the previous set.

`dsh_principal_roles` stores one current slot per `(user_id, tenant_id, team_id, role_id)` with `active`/`revoked` status and a monotonic revision. `team_id` is part of the primary key, so the same user can hold different roles on different teams without those sets mixing. `listPrincipalRoles` filters `userId`, `tenantId`, `teamId`, and `active` together. Revoke sets `revoked` and increments revision in the same update. Re-assigning a revoked slot restores `active` at revision 1.

This Provider does not store object grants, does not compute Effective, and does not call `ctx.tenants` or `ctx.teams`. Connection, SQL, malformed-row, and transaction failures become `provider-unavailable` without exposing SQL or driver diagnostics.

## Model Experience

### MySQL role grants

#### What the model sees

Nothing. The Provider is Host-only and registers no tool, prompt, message, or Session event. `ctx.authRbac.evaluate` remains Host-only after this Provider commits a role or binding change.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: database reads and mutations do not change a request prefix.

## Known Limitations and Deferred Work

- **Schema version 1 only** - incompatible versions fail activation; a later release must add explicit migrations before persistent compatibility is promised.
- **No object grants** - resource ACL rows belong to `dsh-authority-acl`.
- **No Effective computation** - same-team intersection stays in `dsh-authority`.
- **No team-membership join** - revoke is a principal-role status change; this Provider does not read `ctx.teams`.
- **Single database binding** - this Provider uses the one injected `ctx.mysql` service and does not select a database per request or tenant.
