# @deepseek-ai/dsh-account

English | [中文](README.zh.md)

Host-only account orchestration over [`ctx.users`](../user/README.md), [`ctx.userCredentials`](../user-credential/README.md), and [`ctx.auth`](../auth/README.md). It provides durable registration, password login followed by JWT issuance, refresh, all-session logout, self-service profile and password changes, and separately authorized administrator account operations.

This package does not parse HTTP, hash passwords, sign JWTs, persist records, or decide permissions. Trusted transports own request parsing and secret retention. `dsh-user-credential` Providers own password verification, and the JWT Provider owns JOSE and token-family lifecycle.

## Composition

Mount `dsh-user` and `dsh-user-credential` Providers, `dsh-auth`, `dsh-auth-password`, `dsh-auth-jwt`, and this service. `ctx.accounts` is Host-only: transports map its stable `AccountError.code` values to protocol responses and never log request objects or returned credential values.

Before registration can write, install exactly one durable `RegistrationOperationProvider`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { RegistrationOperationProvider } from '@deepseek-ai/dsh-account'

function installRegistrationOperations(ctx: Context, provider: RegistrationOperationProvider): () => void {
  return ctx.accounts.registrationOperations.register(provider)
}
```

The Provider owns request-id uniqueness and persistence. `begin(requestId)` atomically creates the `begun` record or returns its existing record, `advance(request)` compares the expected stage and revision before recording progress, `complete(requestId, expectedRevision, user)` atomically stores the non-secret `UserRecord`, and `read(requestId)` exposes persisted state to recovery tooling. A composition without this Provider fails closed with `unavailable`; a second Provider is rejected. Dispose the registration when its plugin is unloaded.

Administrator methods exist only on `ctx.accountAdministration`. Install exactly one `AccountAdminAuthorizer` with `ctx.accountAdministration.authorizers.register(authorizer)`. Each method first requires an exact current `AuthenticatedCall`, then asks the authorizer about the explicit action and target. A missing, rejecting, or throwing authorizer fails closed with `forbidden`; the account package does not implement RBAC policy itself.

## Account Flow

`ctx.accounts.register()` validates the request id, normalizes the login identifier, creates the user, adds the identifier, and sets the password. It advances the durable operation after each committed stage. A retry resumes from the persisted stage, reconciles user and credential state after an ambiguous Provider failure, and returns the same stored `UserRecord` after completion. It does not issue JWTs; the caller invokes `login()` separately. This avoids storing or replaying access and refresh secrets as idempotency results.

If registration cannot continue, compensation disables the new user and removes configured credentials where possible. The durable failed stage and `AccountError.recovery` report only the user id, committed status, credential-configuration state, and whether compensation completed; they never contain the identifier, password, verifier, token, or Provider diagnostics. Persistence makes progress survive a process crash, but it does not create a distributed transaction across the user and credential Providers.

Login resolves the normalized identifier and reads its credential revision before routing password evidence through `ctx.auth`. It verifies that the resulting call is current and names the resolved user, requires the user to remain active, and delegates JWT issuance. It then rereads the credential record. If the user, revision, or password-enabled state changed during issuance, or the reread fails, it revokes the newly issued JWTs and rejects the login. This credential revision fence prevents a concurrent password change or administrator reset from leaving a freshly issued session alive. Refresh delegates directly to the JWT Provider, whose dual JWT validation verifies JOSE claims and the durable refresh-token family. Logout revokes every JWT family for the authenticated user because an access credential does not expose its family id through the generic authentication API.

Self-service profile updates can change only `displayName`; extension mutation remains an administrator capability. Self-service and administrator updates preserve the optimistic revisions owned by `dsh-user` and `dsh-user-credential`. Password changes, administrator password resets, and account disabling revoke all JWT families. If the primary mutation commits but revocation fails, the error code is `session-revocation-incomplete` and its recovery state identifies the committed result.

The `account/changed` event contains operation kind, target user id, optional actor user id, request id, and time. It is emitted only after the represented account-level operation completes and never contains secrets.

## Model Experience

### Account lifecycle

#### What the model sees

Nothing. `ctx.accounts` and `ctx.accountAdministration` keep account records, authentication evidence, credentials, authorization decisions, and lifecycle events Host-only.

#### Token effect

Zero. This package registers no prompt section, tool, or Session event.

#### KV Cache effect

Independent. Account orchestration changes no model-visible request prefix.

## Known Limitations and Deferred Work

- **Authorization policy is external** - the package requires one `AccountAdminAuthorizer`; [`dsh-account-authority`](../account-authority/README.md) wires that Provider to `ctx.authority.require`.
- **Logout covers all sessions** - the generic authenticated call does not carry a JWT family id, so self-service logout revokes every family for the user.
- **No distributed transaction** - user, credential, and registration-operation Providers are separate services; registration uses durable staged progress, state reconciliation, best-effort compensation, and explicit recovery state.
- **No recovery workflow** - email verification, forgotten-password challenges, lockout, and account recovery require dedicated policy and delivery plugins.
