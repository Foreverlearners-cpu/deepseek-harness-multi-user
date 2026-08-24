# @deepseek-ai/dsh-auth-starter

English | [中文](README.zh.md)

Composition-only authentication suites. The default entry mounts the complete MySQL-backed account flow; `@deepseek-ai/dsh-auth-starter/minimal` mounts authentication consumers over storage services supplied by other plugins. The Starter owns no user data, route, authorization rule, signing default, or administrator policy.

## Complete MySQL suite

The default function plugin mounts one Fiber in dependency order: `dsh-mysql`, `dsh-user-mysql`, `dsh-user-credential-mysql`, `dsh-auth-token-mysql`, `dsh-account`, `dsh-account-mysql`, `dsh-auth`, `dsh-auth-password`, `dsh-auth-jwt`, `AccountAdministrationService`, and `dsh-auth-gateway`. Disposal removes the complete child tree and drains MySQL through the connection service.

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
    gateway:
      allowedOrigins: [https://app.example]
```

JWT secrets are canonical Base64url values containing 32-128 bytes. MySQL credentials and the JWT keyring are required; the Starter supplies no production secret. Invalid key material, an unavailable database, an existing owned service, a Provider conflict, or a missing registration-operation Provider rejects startup. JWT issuance and verification retain the dual-token behavior owned by `dsh-auth-jwt`: Access and Refresh JWTs are distinct signed artifacts, each accepted only by its own flow, while Refresh rotation also checks server-side family state.

`AccountAdministrationService` is mounted so an authorization plugin can register later. The Starter never registers an administrator authorizer; every administrator operation therefore fails closed until one explicit policy Provider is active. It does not substitute RBAC.

## Custom Provider suite

The `./minimal` entry requires active `users`, `userCredentials`, `authTokens`, and `accounts` services. Their Provider bundle must register the durable account registration-operation Provider and then publish the `authProvidersReady` service marker. The marker prevents Loader from starting the consumers merely because the service objects appeared before their registry effects completed.

```ts
import type { Context } from '@deepseek-ai/cordis'

declare const myOperations: Parameters<Context['accounts']['registrationOperations']['register']>[0]
const AUTH_PROVIDER_READINESS = 'authProvidersReady'

export async function apply(ctx: Context): Promise<void> {
  const accounts = ctx.get('accounts') as Context['accounts']
  ctx.effect(() => accounts.registrationOperations.register(myOperations))
  ctx.provide(AUTH_PROVIDER_READINESS, true)
}
```

Place that Provider plugin beside the minimal Starter row. The minimal row waits for all five injections, mounts `dsh-auth`, Password and JWT Providers, administrator service, and Gateway, then checks the Provider registrations. Publish the readiness marker only after every required registration has committed; disposal of the Provider Fiber must remove it.

## Runtime use

Adapters call [`ctx.authGateway`](../auth-gateway/README.md) for registration, password login, Access Bearer authentication, Refresh Cookie plus CSRF rotation, and logout. `dsh-account` coordinates users and credentials; the Starter adds no alternate API. Rate limiting, lockout, recovery, RBAC, tenant derivation, and HTTP route serialization remain separate plugins.

## Model Experience

### Authentication assembly

#### What the model sees

Nothing. `ctx.authGateway`, credentials, identity calls, and startup checks remain Host-only.

#### Token effect

`0`. The package registers no prompt section, tool, or Session event.

#### KV Cache effect

`0` prefix change. Authentication assembly does not alter a model request prefix.

## Known Limitations and Deferred Work

- The default suite supports one MySQL pool and the built-in Password/JWT flow; API Key and other authentication methods remain separate compositions.
- The package returns a transport-neutral Gateway service, not HTTP routes or framework middleware.
- A custom Provider bundle owns its readiness marker accuracy and teardown ordering.
