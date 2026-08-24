# @deepseek-ai/dsh-auth-gateway

English | [中文](README.zh.md)

Transport-neutral Host authentication entry points for HTTP and WebSocket adapters. The service extracts one bounded credential carrier, delegates verification to [`ctx.auth`](../auth/README.md), delegates public account flows to [`ctx.accounts`](../account/README.md), and returns fixed `AuthGatewayError.code` and `status` values without Provider diagnostics or secrets.

This package is not an HTTP server or router. A framework adapter converts its native request into the structured header, parsed-cookie, decoded-query, and subprotocol entries accepted here. Keeping repeated entries visible lets the gateway reject duplicate security fields. Header names are matched case-insensitively; Cookie and Query names use exact case. Adapters must use their framework's maintained cookie parser instead of splitting a Cookie header themselves.

## Configuration

`allowedOrigins` is empty by default, so browser refresh fails closed until the deployment lists exact serialized origins such as `https://app.example`. Refresh cookies default to `__Host-dsh_refresh`, the readable CSRF cookie defaults to `__Host-dsh_csrf`, and both use `Secure`, `SameSite=Strict`, no Domain, and `Path=/`. The refresh cookie is also `HttpOnly`. Configured Cookie names must retain the exact `__Host-` prefix; startup rejects every less restrictive name.

HTTP access authentication accepts only an Authorization Bearer; access Cookie authentication is not supported. WebSocket access through Authorization is also the default and works for SDK clients. `allowWebSocketQueryAccessToken` and `allowWebSocketBearerSubprotocol` both default to `false` because those values commonly enter URLs, logs, or protocol negotiation. Enable either only when a client cannot set Authorization and its adapter obeys the returned redaction metadata; a credential-bearing subprotocol must never be echoed in the upgrade response.

## Adapter use

Mount `dsh-auth`, its bearer JWT Provider, `dsh-account`, and this service. An HTTP adapter calls `authenticateHttp()` for a protected request, then passes the returned Host-only call to `guard()` immediately before the protected handler reads it:

```ts
import type { AuthenticatedCall, GatewayHttpAuthenticationRequest } from '@deepseek-ai/dsh-auth-gateway'
import type { Context } from '@deepseek-ai/cordis'

async function protectedUserId(ctx: Context, request: GatewayHttpAuthenticationRequest): Promise<string> {
  const call: AuthenticatedCall = await ctx.authGateway.authenticateHttp(request)
  return ctx.authGateway.guard(call, current => current.principal.id)
}
```

The first check verifies the access JWT signature, claims, Token type, persistent Token Family state, and current user state through `dsh-auth-jwt`. `guard()` then calls `ctx.auth.assertCurrent()` immediately before use, rejecting a cancelled or expired call and a call minted by a Provider that has since been replaced. It validates Host provenance and current state; it does not verify the JWT a second time. The system's dual JWT verification means the access JWT and refresh JWT are each verified in their own flow. An `AuthenticatedCall` never crosses the process or transport response.

`login()` and `register()` accept passwords only as bounded body fields. Login returns the access token and Set-Cookie instructions; the refresh token exists only in the HttpOnly cookie instruction. `refresh()` reads that cookie and requires both an exact allowed Origin and matching CSRF header/readable cookie values before delegating rotation. `logout()` authenticates a bearer, revalidates it, revokes the user's sessions through `ctx.accounts`, and returns cookie-clearing instructions. The gateway never exposes `ctx.accountAdministration` methods.

WebSocket authentication happens only during the handshake through an Authorization Bearer, explicitly enabled `dsh-auth-bearer.<JWT>` subprotocol, or explicitly enabled `access_token` Query entry. Exactly one may be present. The result tells adapters which URL-like field must be redacted and always forbids echoing a credential subprotocol. Password and refresh values in Query entries or Subprotocols are always rejected; refresh and password operations remain HTTP Body/Cookie flows.

## Error mapping

Adapters map `AuthGatewayError.status` directly and may expose `code`: `invalid-request` (400), `unauthenticated` (401), `forbidden` (403), `conflict` (409), or `unavailable` (503). Messages are fixed and errors never retain `cause`. Do not log structured requests, cookie directives, login inputs, or session results because they contain credentials.

## Model Experience

### Authentication transport

#### What the model sees

Nothing. `ctx.authGateway` inputs, calls, credentials, and errors remain Host-only.

#### Token effect

Zero. The package registers no prompt section, tool, or Session event.

#### KV Cache effect

Independent. Authentication transport does not change a model request prefix.

## Known Limitations and Deferred Work

- The package returns adapter-neutral cookie instructions; each HTTP framework adapter owns header serialization and response delivery.
- Registration and login rate limiting, account lockout, CAPTCHA, and recovery belong to dedicated policy plugins.
- WebSocket calls are checked at handshake and again before a guarded handler; long-lived connections need a separate expiry/disconnection policy if they retain authority across messages.
