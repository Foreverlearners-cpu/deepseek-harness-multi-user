# @deepseek-ai/dsh-auth-gateway

English | [中文](README.zh.md)

Transport-neutral Host authentication entry points for HTTP and WebSocket adapters. The service extracts one bounded credential carrier, delegates verification to [`ctx.auth`](../auth/README.md), delegates public account flows to [`ctx.accounts`](../account/README.md), and returns fixed `AuthGatewayError.code` and `status` values without Provider diagnostics or secrets.

This package is not an HTTP server or router. A framework adapter converts its native request into the structured header, parsed-cookie, decoded-query, and subprotocol entries accepted here. Keeping repeated entries visible lets the gateway reject duplicate security fields after case folding; adapters must use their framework's maintained cookie parser instead of splitting a Cookie header themselves.

## Configuration

`allowedOrigins` is empty by default, so browser refresh fails closed until the deployment lists exact serialized origins such as `https://app.example`. Refresh cookies default to `__Secure-dsh_refresh`, the readable CSRF cookie defaults to `__Secure-dsh_csrf`, and both use `Secure`, `SameSite=Strict`, and `Path=/auth/refresh`. The refresh cookie is also `HttpOnly`. Cookie names, CSRF header name, refresh path, and origins are configurable.

`allowWebSocketQueryAccessToken` defaults to `false` because query values commonly enter URLs and logs. Enable it only for a WebSocket client that cannot set an Authorization header or subprotocol and after its surrounding infrastructure redacts query strings.

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

The first check verifies JWT signature, claims, token kind, persistent token-family state, and current user state through `dsh-auth-jwt`. `guard()` then calls `ctx.auth.assertCurrent()` immediately before use, rejecting a cancelled or expired call and a call minted by a Provider that has since been replaced. An `AuthenticatedCall` never crosses the process or transport response.

`login()` and `register()` accept passwords only as bounded body fields. Login returns the access token and Set-Cookie instructions; the refresh token exists only in the HttpOnly cookie instruction. `refresh()` reads that cookie and requires both an exact allowed Origin and matching CSRF header/readable cookie values before delegating rotation. `logout()` authenticates a bearer, revalidates it, revokes the user's sessions through `ctx.accounts`, and returns cookie-clearing instructions. The gateway never exposes `ctx.accountAdministration` methods.

WebSocket authentication happens only during the handshake through an Authorization bearer, access cookie, `dsh-auth-bearer.<JWT>` subprotocol, or explicitly enabled `access_token` query entry. Exactly one may be present. Password and refresh values in query entries or subprotocols are always rejected; refresh and password operations remain HTTP body/Cookie flows.

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
