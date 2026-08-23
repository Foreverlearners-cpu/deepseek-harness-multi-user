# Agent Note: dsh-user service definition

Status: proposed

English | [中文](2026-08-24-dsh-user-service-definition.zh.md)

## Problem

The decoupled MySQL multi-user delivery plan splits the coupled candidate implementation into independently reviewable plugins. Before any provider can persist user-owned sessions, files, or conversations, the product needs a stable user identity vocabulary. The candidate commit left the user contract inside a combined change that also patched core packages; keeping that shape would make each provider invent its own user types and re-introduce core patches.

## Proposal

Add `@deepseek-ai/dsh-user` under `packages/identity/user` as the user identity Service Definition. The package defines `ctx.users` with create, get, require-active, disable, and list operations, plus the stable `UserId` brand, user status lifecycle, and user record shape. Providers such as `@deepseek-ai/dsh-user-mysql` own durable storage; authentication credentials and external identity mappings remain separate capabilities in `dsh-auth`.

### Tenant ownership

Ownership lives in provider storage, not in core session or agent types. Providers keep a `sessionId → userId` mapping in their own schema and apply the configured or authenticated principal to every storage operation. Core session, agent, and agent-loop packages are not modified.

### Runtime scope

The first provider is tenant-runtime scoped: one configured user per DSH Host deployment. A shared process serving mutually untrusted users requires a request-level identity mechanism first; until that exists, concurrent multi-user serving is out of scope rather than emulated through global mutable state or core patches.

## Dependencies

The package depends only on `@deepseek-ai/cordis`, `@deepseek-ai/dsh-brand`, and `@deepseek-ai/dsh-invariants`. It adds no external dependencies and no bundled runtime behavior.

## Downstream use

`plugin/user-mysql` implements this Service Definition. Session and conversation persistence providers depend on the merged user convention only when they need identity-aware ownership. Consumers use `ctx.users` and never probe provider-specific services.

## Alternatives considered

**Add user identity fields to core session and agent types.** Not adopted: optional persistence would impose its identity model on every DSH deployment and make core packages depend on an optional plugin convention. Ownership stays in provider storage.

**Let each provider define its own user vocabulary.** Not adopted: structurally similar local types would not form an owned capability contract and could drift at runtime; providers need one merged convention to build on.

## Acceptance criteria

- Core session, agent, and agent-loop public types carry no user identity fields from this package.
- Providers implement the service vocabulary without modifying upstream packages.
- User records and ownership checks are covered by provider tests, including cross-user rejection.

## Risks

Tenant ownership strength depends on the identity source given to providers. A configured single user per Host deployment is safe for one-user-per-Host deployments but does not claim request-level isolation; serving mutually untrusted users in one process needs the deferred request-level identity mechanism first.
