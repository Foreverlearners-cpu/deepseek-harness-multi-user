# @deepseek-ai/dsh-authentication-local

English | [中文](README.zh.md)

Explicit local-profile `AuthenticationProvider` for bootstrap and same-process compositions. `LocalAuthenticationProvider` turns configured principal, tenant, and membership ids into an immutable local `AuthenticatedCall` through the shared [`authentication`](../authentication/README.md) service contract. It has no implicit default identity and is intended for a deliberately trusted local Host profile, not for an internet-facing login flow.

## API

- `Config` requires the string fields `principalId`, `tenantId`, and `membershipId`; all three are validated by the base authentication branding rules during activation.
- `LocalAuthenticationProvider` implements the shared `AuthenticationProvider` and returns a local principal, the `local` method, and a tenant scope for every trusted attempt received by the mounted context.
- The package default export is `LocalAuthenticationProvider`; the named export and `Config` type are available from the package root.
- The `./invariant` entry provides the package companion registration for contexts that compose the repository invariant service.

## Authentication contract

The provider is useful when a local composition needs a stable identity before a remote credential backend exists. The configured ids are converted once when the provider activates; each call is still minted by the base service, retains the attempt request id, channel, and cancellation signal, and passes the private issuer check required by authorization.

The provider deliberately does not infer identity from an anonymous user id, hostname, loopback address, or RPC payload. For HTTP attempts it additionally rejects every non-loopback authority; this is a code-level local-only fence, not merely a deployment convention. Its trust boundary is the code that explicitly mounts this Provider and supplies the carrier attempt. Keep that composition boundary local and reviewable.

## Failure semantics

- Missing or non-string configuration fields fail schema validation during activation.
- Empty, malformed, or overlong ids fail the shared branding validation with `TypeError` and the authentication service is not activated.
- Provider verification does not consult credentials or issue an expiry; every accepted attempt receives the configured identity for the lifetime of that call.
- Downstream authorization still rejects forged calls, expired calls issued by another Provider, unknown permissions, and policies that deny the action.

## Composition

Mount this Provider only in an explicit local profile, such as a trusted desktop or test Host. The composition must also mount an authorization Provider; this package alone grants no product action. Remote deployments should replace it with a Provider that verifies credentials and enforces tenant or operator policy. Its invariant companion is available from `./invariant`.

## Model Experience

None, as the configured local ids and tenant scope remain Host-side authorization metadata and never enter a model request.

#### KV Cache effect

None; local authentication does not alter the model request prefix.

## Known Limitations and Deferred Work

- **No credential verification** — the configured identity is not an OIDC subject, session, API key, or operating-system account proof.
- **No expiry or revocation** — calls have no expiry by default, and changing the configuration requires replacing the Provider composition.
- **Local trust only** — non-loopback HTTP attempts are rejected, and Connection refuses to combine this Provider with declared `trustedHosts`. A network deployment still needs a credential-verifying Provider; loopback reachability is not a user identity.
- **One configured identity per Provider** — per-user login, membership selection, operator grants, and dynamic tenant switching require another Provider.
