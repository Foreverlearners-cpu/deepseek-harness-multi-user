# Agent Note: Host Account Orchestration

Status: implemented

English | [中文](2026-08-24-account-orchestration.zh.md)

## Problem

User records, login identifiers, password verification, authentication Providers, and JWT lifecycle operations have separate owners. A transport that calls them directly must reproduce write ordering, active-user checks, secret handling, administrator actor validation, and partial-failure semantics.

## Decision

`@deepseek-ai/dsh-account` is the Host-only Consumer that coordinates those services. It does not own persistence, password hashing, JOSE, HTTP parsing, or authorization policy.

Registration writes the user, identifier, and password in that order. Identifier failure disables the user. Password failure first removes the identifier and then disables the user. Because the Providers do not share a transaction, a stable `AccountError.recovery` reports the non-secret committed state and whether compensation completed.

Password login uses the registered password Authentication Provider, validates the minted call through `assertCurrent()`, requires the user to remain active, and then uses the JWT credential lifecycle capability. Refresh and revocation remain JWT Provider operations. Password changes, password resets, and disabling revoke every token family belonging to the target user.

Administrator entry points require an exact current user call, keep actor and target identities separate, and record the actor in delegated mutation context and account events. The account service cannot prove RBAC authorization without depending on `dsh-authority`, so trusted Consumers must authorize the actor before invoking an administrator method.

Events contain only operation kind, request id, target user id, optional actor user id, and time. Requests, identifiers, passwords, refresh secrets, and Provider causes are excluded.

## Alternatives considered

**Put orchestration in an HTTP gateway.** This would couple account semantics to one transport and let other Host Consumers bypass the same lifecycle rules.

**Make user and credential storage one transaction.** The Provider-neutral services intentionally evolve independently and may use different storage systems. Requiring a shared transaction would collapse those capability boundaries.

**Implement RBAC inside the account service.** That would invent authorization policy before `dsh-authority` is a dependency and make a valid authenticated call look like proof of administrator permission.

## Consequences

Trusted Consumers have one stable account API and one redacted error taxonomy. Cross-service failures remain observable and recoverable without exposing secrets, but registration compensation is best effort and may require an operator when a Provider fails repeatedly. Self-service logout revokes all user sessions because the generic authenticated call does not expose a JWT family id.
