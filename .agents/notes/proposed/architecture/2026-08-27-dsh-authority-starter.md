# Agent Note: Authorization suite composition

Status: proposed

English | [中文](2026-08-27-dsh-authority-starter.zh.md)

## Problem

The tenant, team, authority, RBAC, ACL, tenant-guard, MySQL Provider, and account-authorizer plugins are separate packages. A deployment needs one ordered Fiber that mounts the MySQL tree and the account wiring without turning that composition into an RBAC engine, a default-allow policy, a cross-team union switch, or a second JWT keyring.

## Proposal

Add `@deepseek-ai/dsh-authority-starter` as a composition-only function plugin, modeled on `dsh-auth-starter`. The default entry injects `mysql`, `auth`, and `accountAdministration`, then mounts `dsh-tenant-mysql`, `dsh-team-mysql`, `dsh-authority`, `dsh-auth-rbac`, `dsh-auth-rbac-mysql`, `dsh-authority-acl`, `dsh-authority-acl-mysql`, `dsh-tenant-authority`, and `dsh-account-authority`. It does not create the MySQL pool or JWT material.

The `./minimal` entry waits for directories, routes, and the `authorityProvidersReady` marker, then mounts only `dsh-tenant-authority` and `dsh-account-authority`. Disposing the starter Fiber removes the children it mounted.

The package inserts no roles or grants. Effective stays same-team intersection in `dsh-authority`.

## Alternatives considered

**Put the mount list inside `dsh-auth-starter`.** Rejected because authentication composition must stay policy-free and must not own tenant, team, or grant plugins.

**Default-allow when sources are empty.** Rejected because missing policy is deny. The suite fails closed.

**Add a config switch that unions every team.** Rejected because cross-team mix is deny. There is no union flag.

**Embed JWT keys so the suite can boot alone.** Rejected because signing material belongs to `dsh-auth-starter`. This package injects `auth` and does not invent secrets.

**Mount `dsh-mysql` again.** Rejected when `dsh-auth-starter` already owns the pool. The default entry injects `mysql`.

## Acceptance criteria

- The default entry mounts the MySQL authority tree plus account-authority in dependency order.
- `./minimal` waits for the readiness marker before mounting consumers.
- A missing injected service or an already-owned service rejects startup.
- Decide and administrator authorization stay fail-closed without grants.
- A test-only `cordis.yml` boots through the vendored Loader.
- Disposing the starter Fiber unregisters the consumers and leaves injected storage in place.

## Risks

- A custom Provider bundle that publishes the readiness marker before sources register lets consumers start against an empty catalog. The bundle owns that marker.
- Two starters sharing one MySQL pool must agree on schema initialization order; each MySQL Provider still verifies its own schema on init.

## Verification

Focused tests cover mount order, missing injections, already-active services, incomplete child registration, memory decide and administration fail-closed, Fiber disposal, and Loader-booted `cordis.yml`. Real MySQL verification remains gated by `DSH_MYSQL_TEST_URL`.
