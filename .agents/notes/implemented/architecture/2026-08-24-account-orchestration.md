# Agent Note: Host Account Orchestration

Status: implemented

English | [中文](2026-08-24-account-orchestration.zh.md)

## Problem

User records, login identifiers, password verification, authentication Providers, and JWT lifecycle operations have separate owners. A transport that calls them directly must reproduce write ordering, active-user checks, secret handling, administrator actor validation, and partial-failure semantics.

## Decision

`@deepseek-ai/dsh-account` is the Host-only Consumer that coordinates those services. It does not own persistence, password hashing, JOSE, HTTP parsing, or authorization policy.

Registration requires one durable `RegistrationOperationProvider`, registered through `ctx.accounts.registrationOperations`. Its request-id-keyed `begin`, compare-and-swap `advance`, `complete`, and recovery `read` operations persist the non-secret `begun`, `user-created`, `identifier-added`, `password-set`, `completed`, or `failed` stage. Retries resume from persisted progress, reconcile ambiguous credential mutations against their committed state, and return the same stored `UserRecord` after completion. Registration does not issue JWTs; a separate login does, so access and refresh secrets never become idempotency records.

Registration writes the user, identifier, and password in that order. Recovery disables the user and removes configured credentials where possible. Because the Providers do not share a transaction, a stable `AccountError.recovery` reports the non-secret committed state and whether compensation completed. Durable progress survives a process crash, while a missing registration-operation Provider fails closed rather than allowing untracked writes.

Password login resolves the normalized identifier and captures its credential revision before using the registered password Authentication Provider. It validates the minted call through `assertCurrent()`, requires the principal to match the resolved active user, issues JWT credentials, and rereads credential state. A changed user, revision, or password-enabled state, or a failed reread, causes the newly issued JWTs to be revoked and the login to fail. This fence closes password-change and administrator-reset races. Refresh and revocation remain JWT Provider operations. Password changes, password resets, and disabling revoke every token family belonging to the target user.

Self-service profile mutation on `ctx.accounts` changes only `displayName`; extensions remain administrator-controlled. Administrator entry points exist only on `ctx.accountAdministration`, require an exact current user call, keep actor and target identities separate, and record the actor in delegated mutation context and account events. The service admits exactly one `AccountAdminAuthorizer` through `ctx.accountAdministration.authorizers`. Missing, rejecting, or throwing authorization fails closed with `forbidden`; a later policy plugin such as an RBAC integration owns the decision.

Events contain only operation kind, request id, target user id, optional actor user id, and time. Requests, identifiers, passwords, refresh secrets, and Provider causes are excluded.

## Alternatives considered

**Put orchestration in an HTTP gateway.** This would couple account semantics to one transport and let other Host Consumers bypass the same lifecycle rules.

**Make user and credential storage one transaction.** The Provider-neutral services intentionally evolve independently and may use different storage systems. Requiring a shared transaction would collapse those capability boundaries.

**Let trusted callers pre-authorize administrator methods.** That would make a valid authenticated call look like proof of administrator permission and leave direct Host callers able to bypass policy. A mandatory authorizer preserves the dependency boundary while enforcing one fail-closed decision point.

## Consequences

Trusted Consumers have one self-service account API, one explicitly guarded administration API, and one redacted error taxonomy. Cross-service failures remain observable and recoverable without exposing secrets, but compositions must provide durable registration-operation storage and administrator policy. Registration compensation is best effort and may require an operator when a Provider fails repeatedly. Self-service logout revokes all user sessions because the generic authenticated call does not expose a JWT family id.
