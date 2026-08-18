# Agent Note: MySQL connection service lifecycle

Status: implemented

English | [中文](2026-08-18-mysql-connection-service.zh.md)

## Problem

Trusted Host domain plugins need shared MySQL connectivity without independently creating pools, retaining credentials, or defining incompatible teardown behavior. The first implementation needs working connections for later authentication and persistence Consumers, but those future domains do not yet provide evidence for a transaction, migration, query, or schema API.

## Decision

`@deepseek-ai/dsh-mysql` provides `ctx.mysql` as a Host-only Cordis service backed by one `mysql2/promise` pool. Validated plugin configuration selects one TCP host, port, user, password, database, connection limit, and connection-establishment timeout. The timeout cannot exceed Node's maximum timer delay, preventing the runtime from clamping an overflow to one millisecond. The service acquires a connection and calls `ping()` during activation, so an unreachable or rejected database prevents the plugin from becoming ready.

The public API is `connection(callback)`. Admission occurs before pool acquisition, and each admitted operation remains tracked while it waits for, uses, and cleans a connection. The callback receives a `MysqlConnection` façade without pool lifecycle methods or raw driver state. The façade and prepared statements obtained through it expire when the callback settles; later operations fail, and returning either object rejects the lease instead of publishing an escaped connection. The service then awaits `COM_RESET_CONNECTION`, which rolls back an open transaction and clears session variables and temporary state, reselects the configured database, and releases the lease. A reset or database-restore failure destroys the connection instead of returning uncertain state to the pool, without replacing the callback's result or error.

Disposal stops new admission, waits for every admitted operation, and then closes the pool. This gives accepted work quiescent teardown, including callers queued for pool capacity. The first implementation has no shutdown deadline, so every admitted callback must eventually settle.

The package owns connection infrastructure only. Domain Consumers own tables, SQL, migrations, transaction policy, tenant scoping, and persistence semantics. The service registers no model-facing tool, prompt, message, or event and does not log configuration or connection errors. Its API remains in maintainer subsystem documentation but is excluded from the model-facing Cordis API catalog and live-service inspection. The generated runtime catalog carries the hidden service keys consumed by every inspection path. The dynamic Host sandbox accepts only primitive-string service names and denies `mysql` before resolving declared property access, optional `ctx.get()` lookup, or `ctx.provide()` registration.

## Alternatives considered

**Expose the `mysql2` pool directly.** Direct pool access would let callers retain connections and admit work during teardown, preventing the service from enforcing release and quiescence.

**Implement authentication or session persistence in the infrastructure package.** Those domains have distinct schemas, authorization rules, and service APIs. Coupling them to the driver package would make database connectivity own domain policy.

**Start with transactions, migrations, and classified errors.** No current Consumer establishes their exact API or defaults. Adding them before the first domain implementation would create public choices without usage evidence.

**Route all relational data through the existing KV storage form.** The KV form remains useful for simple records, but it cannot express the cross-table transactions and relational queries required by authentication and session persistence.

## Delivery lessons

The connection-only scope kept the core implementation small. Existing Cordis service and package patterns supplied the lifecycle structure, `mysql2/promise` supplied maintained pooling behavior, focused pool mocks covered failure and disposal paths, and a reusable Docker image made the real-server check deterministic. A release-only mock was insufficient because pool release does not prove clean server session state; the real-server test deliberately leaves an open transaction, a session variable, and a changed database, then verifies that the next lease sees none of them. On this workstation, focused unit tests took about 1–3 seconds, the e2e test took about 5 seconds after the image was available, and the package build took about 16 seconds. These measurements describe development feedback time, not runtime performance guarantees.

Most elapsed time came from repository and environment integration rather than the connection service. Concurrent work required an isolated worktree; the first MySQL 8.0 image pull took several minutes; optional package-manager binary resolution and incomplete filtered dependency installation required retries. Host TypeScript aggregation, path mappings, generated catalog classifications, capability graphs, and bilingual pairing also had to agree before repository gates could pass. The complete `doc-sync` run took about 98 seconds and reached 27 of 28 checks; its remaining failure was Windows denying the documentation test permission to create a symlink.

A repeatable sequence is to create the isolated worktree before editing, add Host aggregate and path-map entries when the package is introduced, use the official npm registry when generating the lockfile, run real-server tests through `vitest.e2e.config.ts`, classify service and type ownership before running catalog generators, and finish by recording translation pairing before `doc-sync`. This order exposes structural omissions early and leaves slow environment-dependent checks until the package feedback loop is green.

## Consequences

Domain plugins receive one consistent connection lifecycle and fail startup when MySQL is unavailable. Callback-scoped leasing narrows ownership, prevents server session state from crossing callbacks, and makes plugin disposal wait for accepted work and connection reset. The initial API deliberately lacks transactions, migrations, TLS policy, query timeouts, cancellation, error classification, health reporting, observability, named bindings, replicas, and bounded shutdown; each addition requires a current Consumer and corresponding real-MySQL coverage.

Unit tests pin configuration bounds, startup failure, lease façade restrictions and expiration, reset-before-release behavior, reset-failure destruction, callback outcome preservation, admission during disposal, invariant re-registration, and pool closure. `mysql.e2e.ts` uses `DSH_MYSQL_TEST_URL` to verify activation, server-session cleanup between leases, and queued-work drainage during disposal against a real MySQL server. Sandbox tests cover dynamic reads, name coercion, and provider impersonation; inspection and catalog tests prove that maintainer documentation retains `ctx.mysql` while every model report omits it.
