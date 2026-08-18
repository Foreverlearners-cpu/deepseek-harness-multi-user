# Cookbook: adding a Host connection service

English | [中文](adding-a-host-connection-service.zh.md)

This guide covers the work specific to a Host-only network connection service and explains why its implementation can be small while repository delivery still takes substantial time. The [workspace package checklist](adding-a-package.md) owns the generic package files and registration rules; [`dsh-redis`](../infrastructure/dsh-redis.md) is the concrete connection-service example.

## Scope

A connection service owns validated client configuration, startup connectivity, callback admission, and client teardown. Domain Consumers own keys, records, serialization, authorization, retries, and outage policy. Preserve that split before writing code; adding domain operations to the connection package changes its security and lifecycle responsibilities.

Read the [architecture](../architecture.md), [defensive patterns](../defensive-patterns.md), and package checklist first. Use an independent git worktree when another process is changing the same repository so branch switches and generated files remain isolated.

## 1. Bound the service

Define the smallest useful API around the maintained protocol client. A callback-scoped method such as `withClient(callback)` keeps ownership of the live client in the service and makes admission and shutdown observable. Configuration resolves once before connection work starts, and deployment-varying timeouts remain validated plugin fields.

Activation connects and performs a cheap protocol probe before exposing the service. Disposal stops new admission, waits for admitted callbacks, keeps required connection-error handling attached while closing the client, and then removes package-owned listeners. Startup, callback, and close failures remain explicit.

Choose reconnect behavior as part of lifecycle ownership. If the maintained client can schedule retry timers that the service cannot cancel and await, disable automatic reconnect until the service owns explicit retry state. The service must have a documented recovery mechanism, such as plugin remount, while reconnect is unsupported.

### Why this phase is fast

The package does not implement Redis commands, pooling, caching, tenant authorization, or durable storage. A maintained client dependency owns the wire protocol and socket implementation, while established Cordis `Service`, `ctx.effect()`, configuration, and invariant patterns supply the lifecycle structure. Most source work is therefore one configuration resolver, one service class, and one small invariant companion.

This speed depends on scope discipline. Adding cache policy, key construction, Pub/Sub, leases, or transactions introduces separate correctness rules and should occur in domain Consumers or dedicated clients.

## 2. Test lifecycle without an external service

Mock the client constructor and cover configuration forwarding, connection and probe order, callback results and failures, readiness rejection, startup cleanup, admission during disposal, operation draining, close failure, and listener removal. Use controllable promises for startup deadlines and in-flight callbacks so tests observe lifecycle ordering directly.

Add keyless loopback TCP fixtures that exercise the maintained client against a silent peer, immediate close, valid protocol responses, and an established connection loss. These tests expose dependency-owned reconnect and socket-event behavior that constructor mocks cannot represent, while requiring no Redis process or credential.

Add one opt-in real-service test for client and server compatibility. The test boots the actual Cordis service, runs the protocol probe through its public callback API, and disposes the context. It skips when its environment variable is absent.

### Why iteration is fast

Mock tests are deterministic and exercise failures that are awkward to reproduce against a live server. Loopback fixtures add the real client event sequence without a container. The real-service test stays narrow because it validates server compatibility rather than duplicating lifecycle coverage. This division keeps the normal edit-test loop short without treating a mock or protocol fixture as proof of deployment compatibility.

## 3. Integrate the complete workspace package

Follow the [package checklist](adding-a-package.md) for the manifest, TypeScript project reference, Host aggregate, package index, invariant registration, README, and published files. Update generated capability, configuration, subsystem, and dependency documentation through their generators rather than editing generated regions by hand.

Review the lockfile and third-party notices after dependency installation. The diff must contain the intended dependency graph change, not registry-mirror URL rewrites or unrelated metadata churn.

### Why this phase takes longer

- A small source package still joins the repository compiler graph, package constraints, runtime-closure checks, dependency analysis, build, and publication checks.
- Public JSDoc and package metadata feed generated catalogs and graphs, so one API can update several reviewed artifacts.
- Every documentation page in scope needs a Chinese counterpart and a recorded pairing file; public pages also need a documentation-site manifest entry and projection test coverage.
- A fresh worktree isolates concurrent changes but owns its own workspace links and build outputs, so dependency installation and the first build cost more than later focused runs.
- Generators can depend on built artifacts from another workspace package. A missing producer artifact blocks generation even when the new package itself is correct.

Treat this as integration work, not evidence that the service implementation is complex. Estimate behavior work and repository integration work separately.

## 4. Verify in layers

Run the smallest check after each local change, then widen coverage once the API and documentation settle:

1. Run focused unit and loopback-client tests plus package coverage for the changed service and invariant companion.
2. Run the opt-in real-service test when a disposable endpoint is available.
3. Run type checking and linting for source and public JSDoc.
4. Run build, hygiene, constraints, dependency, license, notice, and generator checks selected by the outgoing diff.
5. Re-record every edited bilingual pair, then run `doc-sync` and the website build for a published page.

The Redis example uses this focused real-service entry point on PowerShell:

```powershell
$env:DSH_REDIS_TEST_URL = 'redis://localhost:6379/15'
pnpm exec vitest run packages/multi/redis/tests/redis.e2e.ts
```

Finish with the repository checks selected by the [pre-push workflow](../../.agents/skills/dsh-pre-push-checks/SKILL.md) and inspect the complete diff:

```sh
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run hygiene
pnpm run doc-sync
git diff --check
```

Do not repeat broad passing checks merely for a commit. CI owns exhaustive coverage and the platform matrix.

## 5. Separate product failures from host limitations

- A package test failure is product evidence and must be fixed before broader checks continue.
- Registry mirrors can rewrite resolved tarball URLs during installation. Inspect and remove unrelated lockfile churn before accepting the dependency diff.
- A generator that imports built output needs that producer built first. Restore the required artifact through the owning build instead of hand-writing generated output.
- Windows can reject repository tests that create symbolic links with `EPERM`. Confirm the host restriction with a minimal direct symlink probe, report the exact blocked checks, and leave the product check unresolved rather than weakening it.
- An absent `DSH_REDIS_TEST_URL` means the opt-in compatibility test is unexecuted, not passing. Report the skip separately from deterministic unit coverage.

This classification keeps environmental delay visible without disguising a code defect, and it makes the remaining verification work explicit for another host or CI.
