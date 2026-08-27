# @deepseek-ai/dsh-authority-starter

English | [中文](README.zh.md)

Composition-only authorization suites. The default entry mounts the complete MySQL-backed authority tree; `@deepseek-ai/dsh-authority-starter/minimal` mounts the decide entry and account authorizer over directories and routes supplied by other plugins. The Starter owns no grant, role catalog, default-allow rule, cross-team union switch, or JWT secret.

## Complete MySQL suite

The default function plugin injects `mysql`, `auth`, and `accountAdministration`, then mounts one Fiber in dependency order: `dsh-tenant-mysql`, `dsh-team-mysql`, `dsh-authority`, `dsh-auth-rbac`, `dsh-auth-rbac-mysql`, `dsh-authority-acl`, `dsh-authority-acl-mysql`, `dsh-tenant-authority`, and `dsh-account-authority`. Disposal removes the child tree. The injected MySQL pool is not created here; mount `dsh-mysql` or `dsh-auth-starter` first.

```yaml
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
          secret: !!js env.DSH_JWT_PRIMARY_KEY
- id: authorization
  name: '@deepseek-ai/dsh-authority-starter'
```

An existing owned service, a missing injected service, or a child that does not register rejects startup. The suite does not insert roles or object grants. Same-team Effective stays in `dsh-authority`.

## Custom Provider suite

The `./minimal` entry requires active `auth`, `accountAdministration`, `tenants`, `teams`, `authority`, `authRbac`, and `authorityAcl` services. Their Provider bundle must register the role and object sources and then publish the `authorityProvidersReady` service marker. The marker prevents Loader from starting the consumers merely because the service objects appeared before their registry effects completed.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { RbacPolicySource } from '@deepseek-ai/dsh-auth-rbac'
import type { AclPolicySource } from '@deepseek-ai/dsh-authority-acl'

const AUTHORITY_PROVIDER_READINESS = 'authorityProvidersReady'

function installSources(ctx: Context, rbac: RbacPolicySource, acl: AclPolicySource): void {
  ctx.effect(() => ctx.authRbac.registerSource(rbac))
  ctx.effect(() => ctx.authorityAcl.registerSource(acl))
  ctx.provide(AUTHORITY_PROVIDER_READINESS, true)
}
```

Place that Provider plugin beside the minimal Starter row. The minimal row waits for all eight injections, mounts `dsh-tenant-authority` and `dsh-account-authority`, then checks those services. Publish the readiness marker only after every required registration has committed; disposal of the Provider Fiber must remove it.

## Runtime use

Product callers use [`ctx.tenantAuthority.decide`](../tenant-authority/README.md) and [`ctx.accountAuthority.authorize`](../account-authority/README.md). This package adds no alternate API and no default-allow path.

## Model Experience

### Authorization assembly

#### What the model sees

Nothing. `ctx.tenantAuthority.decide`, `ctx.accountAuthority.authorize`, membership lookups, and startup checks remain Host-only.

#### Token effect

Zero. Authorization assembly does not add, remove, or rewrite model-input tokens.

#### KV Cache effect

Independent. Authorization assembly does not alter a model-visible request prefix and therefore cannot invalidate an otherwise reusable provider cache entry.

## Known Limitations and Deferred Work

- **Not an RBAC engine** - the suite only mounts plugins. Role catalogs and object grants stay in their owners.
- **No cross-team union switch** - Effective remains same-team intersection in `dsh-authority`.
- **Requires an injected MySQL pool** - the default entry does not create `ctx.mysql` or JWT material.
- **A custom Provider bundle owns its readiness marker** and teardown ordering.
