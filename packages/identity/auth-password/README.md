# @deepseek-ai/dsh-auth-password

English | [中文](README.zh.md)

Password authentication Consumer and Provider adapter. It registers the exact `password` evidence kind with [`ctx.auth`](../auth/README.md), resolves a login identifier through [`ctx.userCredentials`](../user-credential/README.md), verifies the candidate password, and returns verified user identity facts for `dsh-auth` to mint as an `AuthenticatedCall`.

This package does not parse HTTP, store passwords, hash secrets, issue JWTs, check permissions, or implement account registration and recovery. A trusted transport constructs the password evidence; a concrete `dsh-user-credential` Provider owns normalization, lookup, verifier storage, hashing, and dummy verification.

## Composition

Mount `dsh-auth`, one `dsh-user-credential` Provider, and this plugin. The plugin requires `ctx.auth` and `ctx.userCredentials`, then installs its registry disposer through `ctx.effect()`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import AuthenticationRuntime, { authenticationRequestId } from '@deepseek-ai/dsh-auth'
import PasswordAuthentication from '@deepseek-ai/dsh-auth-password'

declare function installCredentialProvider(ctx: Context): Promise<void>

export async function authenticatePassword(ctx: Context): Promise<void> {
  await ctx.plugin(AuthenticationRuntime)
  await installCredentialProvider(ctx)
  await ctx.plugin(PasswordAuthentication)
  await ctx.auth.authenticate({
    requestId: authenticationRequestId('login-1'),
    channel: 'http',
    evidence: {
      kind: 'password',
      identifier: { kind: 'username', value: 'alice' },
      password: 'candidate-password',
    },
    signal: new AbortController().signal,
  })
}
```

The transport remains responsible for accepting exactly one credential carrier, applying rate limits, and mapping safe `AuthenticationError` categories to its protocol. It must not log or retain the evidence object.

## Data Flow

`ctx.auth.authenticate()` selects this Provider only when `evidence.kind` is `password`. The Provider calls `ctx.userCredentials.resolve(identifier)`, then always calls `verifyPassword()`. When resolution misses, it omits `userId`, requiring the credential Provider to run its dummy verifier. A successful match returns `{ principal: { kind: 'user', id }, authenticatedAt }`; only `dsh-auth` can turn those facts into a current `AuthenticatedCall`.

The registry admits one Provider per evidence kind and one Provider per authentication method. A second password Provider or another Provider claiming method `password` fails immediately with `provider-conflict`; Providers are never tried in sequence.

## Failure and Secret Handling

Unknown identifiers, wrong passwords, malformed login evidence, and expected credential rejection all become `AuthenticationError` code `unauthenticated` with the same message. Credential storage or hashing failures become `authentication-unavailable`. Both messages are fixed and discard Provider causes, identifier values, passwords, SQL, and verifier diagnostics.

The `auth/result` event is emitted by `dsh-auth`, not this package. It contains the password evidence kind, method, outcome, and safe category, but never the identifier or password. This package returns no `credentialId` because a password is not a durable public credential identity.

## Model Experience

### Password authentication

#### What the model sees

Nothing. `password` evidence, credential lookup, verification results, and authenticated identity are Host-only.

#### Token effect

Zero. This plugin registers no prompt section, tool, or Session event.

#### KV Cache effect

Independent. Password authentication changes no model-visible request prefix and cannot invalidate an otherwise reusable Provider cache entry.

## Known Limitations and Deferred Work

- **No account lifecycle check** - a later account Consumer composes user status policy before issuing credentials or admitting a request.
- **No brute-force policy** - rate limiting, lockout, challenge escalation, and risk signals belong to gateway and policy plugins.
- **No token issuance** - JWT access and refresh credentials are issued by dedicated lifecycle Providers after password authentication succeeds.
- **Timing depends on the credential Provider** - this package guarantees the dummy path is invoked, but only the concrete Provider can make real and dummy verifier work comparable.
