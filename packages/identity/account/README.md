# @deepseek-ai/dsh-account

English | [中文](README.zh.md)

Host-only account orchestration over [`ctx.users`](../user/README.md), [`ctx.userCredentials`](../user-credential/README.md), and [`ctx.auth`](../auth/README.md). It provides registration, password login followed by JWT issuance, refresh, all-session logout, self-service profile and password changes, and administrator account operations.

This package does not parse HTTP, hash passwords, sign JWTs, persist records, or decide permissions. Trusted transports own request parsing and secret retention. `dsh-user-credential` Providers own password verification, and the JWT Provider owns JOSE and token-family lifecycle.

## Composition

Mount `dsh-user` and `dsh-user-credential` Providers, `dsh-auth`, `dsh-auth-password`, `dsh-auth-jwt`, and this service. `ctx.accounts` is Host-only: transports map its stable `AccountError.code` values to protocol responses and never log request objects or returned credential values.

Administrator methods accept an exact current `AuthenticatedCall` and call `ctx.auth.assertCurrent()` before mutation. They do not implement RBAC because `dsh-authority` is not an account dependency. The trusted caller must authorize the actor for the requested administrator action before invoking any `admin*` method.

## Account Flow

Registration creates the user first, adds the normalized login identifier at credential revision zero, sets the password at revision one, then asks the JWT Provider to issue credentials. Identifier failure disables the new user. Password failure removes the identifier and disables the user. `AccountError.recovery` reports only the user id, committed status, credential-configuration state, and whether compensation completed; it never contains the identifier, password, verifier, token, or Provider diagnostics.

Login routes password evidence through `ctx.auth`, verifies that the resulting call is current, requires the user to remain active, and delegates JWT issuance. Refresh delegates directly to the JWT Provider, whose dual JWT validation verifies JOSE claims and the durable refresh-token family. Logout revokes every JWT family for the authenticated user because an access credential does not expose its family id through the generic authentication API.

Self-service and administrator updates preserve the optimistic revisions owned by `dsh-user` and `dsh-user-credential`. Password changes, administrator password resets, and account disabling revoke all JWT families. If the primary mutation commits but revocation fails, the error code is `session-revocation-incomplete` and its recovery state identifies the committed result.

The `account/changed` event contains operation kind, target user id, optional actor user id, request id, and time. It is emitted only after the represented account-level operation completes and never contains secrets.

## Model Experience

### Account lifecycle

#### What the model sees

Nothing. `ctx.accounts` keeps account records, authentication evidence, credentials, and lifecycle events Host-only.

#### Token effect

Zero. This package registers no prompt section, tool, or Session event.

#### KV Cache effect

Independent. Account orchestration changes no model-visible request prefix.

## Known Limitations and Deferred Work

- **Authorization is caller-owned** - administrator methods require prior authorization by a trusted Consumer until `dsh-authority` is composed with an account administration Consumer.
- **Logout covers all sessions** - the generic authenticated call does not carry a JWT family id, so self-service logout revokes every family for the user.
- **No distributed transaction** - user and credential Providers are separate services; registration uses ordered writes, best-effort compensation, and explicit recovery state.
- **No recovery workflow** - email verification, forgotten-password challenges, lockout, and account recovery require dedicated policy and delivery plugins.
