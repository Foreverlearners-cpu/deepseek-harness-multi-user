# Agent Note: signed access and refresh JWTs

Status: implemented

English | [中文](2026-08-24-signed-access-refresh-jwt.zh.md)

## Problem

HTTP and SDK transports need a compact access Credential and a signed refresh Credential without duplicating identity, revocation, and replay state in JWT-specific storage. A signature alone cannot disable a user, revoke a family, or detect reuse. Treating refresh as a stateless JWT would let a valid old token bypass the atomic family state machine.

Credential issue and refresh also cross a transaction boundary: `ctx.authTokens` commits a new opaque secret before the JWT Provider can return its signed envelopes. A signing failure after that commit must not leave a live family whose only refresh secret was never delivered.

## Decision

`@deepseek-ai/dsh-auth-jwt` registers one `bearer` Authentication Provider with the `jwt` method. It signs both access and refresh JWTs through JOSE using a fixed HS256 profile. Protected `typ=access` and `typ=refresh` values separate their uses. Verification fixes `alg`, `kid`, `iss`, `aud`, `typ`, `iat`, `nbf`, `exp`, and `jti`, bounds carrier size, and accepts only configured key ids.

The refresh JWT carries the random opaque secret and ids returned by `ctx.authTokens`; persistent Providers continue to receive and store only its digest. Refresh verifies the signed envelope before passing that secret to atomic rotation. Replaying an old signed refresh JWT therefore reaches the rotated digest and revokes the family. Access verification inspects the same family on every call and checks `ctx.users.requireActive()` for user principals.

The keyring decodes and validates every secret when the Provider is constructed. Issue and refresh capture the active key before committing family state. JWT construction and signing remain inside a post-commit compensation block. Any failure synchronously revokes the committed family with a fresh, non-cancelled signal before the Provider returns an unavailable failure. An inconsistent rotation result compensates using the family id from the verified refresh JWT rather than an untrusted returned id.

## Consequences

Key rotation adds a new key, selects it as active, retains old verification keys through their maximum token lifetime, and then removes them. Access JWT ids remain self-contained and do not appear in lifecycle inspection; family or principal revocation remains effective because verification consults durable family state.

HS256 keeps this Provider's deployment model small but shares signing authority with every verifier. Asymmetric or remote signing belongs in a separate Provider whose post-commit operation either cannot fail after preparation or implements the same synchronous compensation obligation.

## Alternatives considered

**Use a stateless refresh JWT.** Rejected because rotation, replay detection, principal revocation, and family compromise require authoritative server-side state.

**Return the opaque refresh secret directly.** Rejected for this Provider because the selected product contract requires both Token classes to be signed and type-separated; the inner random secret still supplies the one-time server-side binding.

**Store every access JWT.** Rejected because family inspection already provides immediate revocation while short access expiry bounds exposure; a durable access index would add writes and cleanup without a current Consumer.

**Return a signing failure without compensation.** Rejected because the caller loses the only new refresh value while durable state remains active.

## Verification

The package tests exercise issue, access verification, refresh rotation, old refresh replay, access/refresh confusion, refresh tampering, explicit revocation, disabled users, key rotation, Provider outages, malformed claims, oversized input, and both successful and failed signing compensation. The package's source reaches 100% statement, branch, function, and line coverage through the public authentication and credential lifecycle paths.
