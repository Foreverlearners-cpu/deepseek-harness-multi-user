# Agent Note: Transport-neutral authentication gateway

Status: implemented

English | [中文](2026-08-24-transport-neutral-authentication-gateway.zh.md)

## Problem

Authentication Providers and account orchestration intentionally do not know HTTP or WebSocket carrier rules. Direct adapters would otherwise repeat credential extraction, conflict handling, CSRF policy, error redaction, and current-call checks, allowing security behavior to drift between transports.

## Decision

`dsh-auth-gateway` owns a Host-only service that accepts structured transport fields instead of framework request objects. It preserves duplicate header, cookie, query, and subprotocol entries long enough to reject ambiguous credentials, then forwards only one bounded evidence value and the original request lifecycle to `ctx.auth` or `ctx.accounts`.

HTTP business authentication accepts only one Authorization Bearer. Passwords exist only in bounded login and registration body fields. Browser refresh uses exact `__Host-` Secure cookies with no Domain and `Path=/`, and requires an exact configured Origin plus a matching readable CSRF cookie and header. WebSocket authentication happens only during the handshake; Authorization is the default, while Query and Subprotocol carriers require separate explicit options and return mandatory adapter redaction instructions. Refresh and password material in URL-like carriers is rejected.

The gateway returns fixed error codes and suggested HTTP statuses without causes. It returns refresh material only as an HttpOnly cookie instruction and keeps `AuthenticatedCall` inside the Host. Protected handlers use `guard()`, which calls `ctx.auth.assertCurrent()` immediately before identity use. This second check covers Host provenance, current Provider registration, cancellation, and expiry; it does not repeat JWT signature verification. Access and refresh JWTs are independently verified by their own flows.

The service delegates only `ctx.accounts` public methods. Administrator account methods remain outside the gateway and require an independently authorized administration adapter.

## Alternatives considered

**Bind the plugin directly to the existing web server.** This would make the authentication policy depend on one router and force WebSocket or SDK adapters either to import that server or reimplement policy. Structured adapter input preserves one policy implementation without inventing a new server abstraction.

**Put transport carriers in `dsh-auth`.** The authentication service selects Providers by evidence kind and mints current calls for every Host channel. HTTP cookies, Origin, CSRF, query strings, and WebSocket subprotocols are Consumer policy and would make the Provider contract transport-specific.

**Return refresh tokens in response bodies.** This simplifies non-browser clients but exposes long-lived bearer material to JavaScript and general response handling. Browser refresh stays in an HttpOnly cookie; a future non-browser Consumer can call the credential lifecycle through its own trusted channel.

**Trust the call for the entire request after entry verification.** Provider replacement, cancellation, or expiry can occur between middleware and business use. A second current-call check is cheap and preserves the process-local provenance guarantee at the point of authority use.

## Consequences

HTTP and WebSocket frameworks need small adapters that retain duplicate security fields and parse cookies with maintained framework APIs. The gateway is independently testable and does not constrain router selection.

Secure defaults reject refresh until exact origins are configured and reject WebSocket access tokens in Query or Subprotocol fields unless explicitly enabled. Deployments must configure origins, preserve the `__Host-` Cookie attributes, serialize cookie directives correctly, and apply returned WebSocket redaction instructions.

The package does not provide rate limiting, lockout, recovery, or long-lived WebSocket disconnection policy. Those controls remain separately composable instead of becoming hidden behavior in credential parsing.
