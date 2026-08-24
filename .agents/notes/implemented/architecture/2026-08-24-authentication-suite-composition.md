# Agent Note: Authentication suite composition

Status: implemented

English | [中文](2026-08-24-authentication-suite-composition.zh.md)

## Problem

The authentication packages expose independent services and Providers, but a deployer must order eleven plugins correctly and must not accidentally start consumers after a service appears but before its required registry Provider commits. Repeating that order in each application also encourages production JWT defaults and policy shortcuts in an assembly package.

## Decision

`dsh-auth-starter` is a composition-only package with two function-plugin entries. The default entry owns a complete MySQL child tree. The `./minimal` entry waits for externally supplied user, credential, token, and account services plus an `authProvidersReady` marker, then mounts authentication, Password, JWT, administrator, and Gateway consumers.

The custom Provider bundle publishes the readiness marker only after registering durable account operations. Both entries preflight the explicit JWT keyring and existing owned services, mount children in dependency order, and verify Password, Bearer, and registration Providers before completing startup. The package does not own data, routes, authorization policy, or credential algorithms.

Administrator capability is present without an authorizer. This keeps later policy injection possible while preserving `dsh-account`'s fail-closed behavior; the Starter never treats deployment assembly as RBAC.

## Lifecycle ownership

Every child is mounted through the Starter's scoped Context, so unloading its Fiber disposes the assembly in reverse ownership order. The MySQL service stops admission and drains admitted callbacks. A custom Provider Fiber owns its services, registrations, and readiness marker independently; removing that Fiber makes the minimal Starter injection incomplete on the next Loader settlement.

## Alternatives considered

**One monolithic authentication service.** This would hide ordering but merge storage, token, transport, and account responsibilities, preventing Provider replacement and independent testing.

**Use service presence as Provider readiness.** Cordis publishes a service during construction, before later registry effects necessarily finish. Depending only on `accounts` permits a race in which the Starter observes an empty registration registry, so the explicit marker wins.

**Ship a development signing secret or administrator allow rule.** Either default can reach production silently. Mandatory key material and an empty administrator-authorizer registry fail loudly or fail closed instead.

## Consequences

The complete path becomes one Loader row and has one disposal owner. Custom storage remains possible without importing MySQL into the minimal runtime, at the cost of one readiness marker whose publication timing is part of the Provider bundle contract. Keyless tests boot a real Loader tree and cover registration idempotency, Password login, Access verification, Refresh rotation and replay revocation, logout, conflicts, missing dependencies, and disposal; `DSH_MYSQL_TEST_URL` enables the same public flow over the real database services.
