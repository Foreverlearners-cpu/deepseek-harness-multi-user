# Agent Note: dsh-user MySQL provider

Status: proposed

English | [中文](2026-08-24-dsh-user-mysql-provider.zh.md)

## Problem

The decoupled delivery plan requires each plugin to consume unmodified upstream packages. The coupled candidate added a `transaction()` convenience method to `packages/multi/mysql` so providers could wrap work in one unit; keeping that shape would patch the upstream MySQL service on every provider branch. The user identity Service Definition also needs a concrete provider so `ctx.users` has durable storage.

## Proposal

Add `@deepseek-ai/dsh-user-mysql` under `packages/identity/user-mysql` as the MySQL Service Provider for `ctx.users`. The provider owns the `dsh_users` table, exposes an idempotent versioned schema, and supports create, get, require-active, disable, and list operations with an optional bootstrap user for local development.

### Transaction ownership

The provider leases one connection through the upstream `ctx.mysql.connection(callback)` and runs `beginTransaction`, `commit`, and `rollback` itself inside that lease. No convenience method is added to `packages/multi/mysql`; callback failure, commit failure, and connection restoration remain governed by the upstream lease contract.

### Schema and ownership

The schema is versioned through a singleton state table and created idempotently. New databases carry no `tenant_id`; ownership is scoped by `user_id` only. A legacy table with `tenant_id` is rejected at startup rather than silently migrated.

### Bootstrap user

An optional `bootstrapUserId` creates a local-development user at activation. It is not an authentication mechanism; credentials and external identity mappings remain separate capabilities.

## Alternatives considered

**Add `transaction()` to the upstream MySQL service.** Not adopted: every optional provider would then require a locally patched DSH release, inverting the dependency direction and forcing core-package changes.

**Delegate ownership to a global tenant field.** Not adopted: shared-process multi-tenant serving needs a request-level identity mechanism first; this provider keeps a one-user-per-runtime posture until that exists.

## Acceptance criteria

- No change to `packages/multi/mysql` or any other existing package.
- The provider owns its transaction sequence inside a single upstream connection lease.
- Schema creation is idempotent and version-checked; legacy `tenant_id` tables are rejected.
- Create, get, require-active, disable, list, duplicate rejection, and bootstrap behavior are covered by unit tests plus MySQL integration tests.

## Risks

Transaction correctness depends on the upstream lease contract: a failed commit or rollback must still leave the leased connection restorable, which the upstream service guarantees. Concurrent duplicate creation relies on the unique key and `ER_DUP_ENTRY` mapping; a misconfigured database could surface driver-specific errors.
