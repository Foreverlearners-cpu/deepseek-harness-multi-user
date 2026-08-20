# identity/ — identity and authorization foundation

English | [中文](README.zh.md)

Identity and authorization contracts shared across product domains. Authentication and authorization are separate services: a verified call establishes who made a request, while a Provider decides what that call may do.

| Package | Role | ctx key |
|---|---|---|
| [`authentication/`](authentication/README.md) | Mints immutable, Host-verified `AuthenticatedCall` values | `ctx.authentication` |
| [`authentication-local/`](authentication-local/README.md) | Explicit local-profile Authentication Provider | `ctx.authentication` |
| [`authorization/`](authorization/README.md) | Default-deny action authorization and live permission catalog | `ctx.authorization` |
| [`authorization-static/`](authorization-static/README.md) | Explicit `deny-all` or `trusted-local` bootstrap policy | `ctx.authorization` |
| [`anonymous-user-id/`](anonymous-user-id/README.md) | Persists one anonymous Harness-home correlation id for telemetry, feedback, and DeepSeek requests | — |

The authentication and authorization packages form the enforcement foundation for protected Remote methods, plugin discovery, visible content, legacy API routes, and future resource projections. Connection's legacy route adapter assigns stable `api:*` permissions to unary methods, `/api/respond`, session export, and both event streams; it authenticates before parsing or opening a source, checks freshness before consuming an allow, and authenticates WebSocket upgrades. UI visibility is only a convenience: the Host Gateway and domain method remain the security boundary.

Route authorization is an action gate, not a resource filter. A successful route decision does not grant access to every session, plugin, workspace, or content row. Domain code must still apply tenant, membership, ownership, resource-level obligations, and output projection before returning data.
