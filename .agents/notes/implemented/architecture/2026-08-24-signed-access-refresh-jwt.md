# Agent Note: signed access and refresh JWTs

Status: implemented

English | [中文](2026-08-24-signed-access-refresh-jwt.zh.md)

## Problem

HTTP and SDK transports need a compact access Credential and a signed refresh Credential without duplicating identity, revocation, and replay state in JWT-specific storage. A signature alone cannot disable a user, revoke a family, or detect reuse. Treating refresh as a stateless JWT would let a valid old token bypass the atomic family state machine.

Credential issue and refresh also cross a transaction boundary: the durable Provider must not commit a new opaque secret before the JWT Provider has prepared both signed envelopes. A signing failure must leave no live family whose only refresh secret was never delivered, and a failed rotation must leave the old Credential usable.

## Decision

`@deepseek-ai/dsh-auth-jwt` registers one `bearer` Authentication Provider with the `jwt` method. It signs both access and refresh JWTs through JOSE using a fixed HS256 profile. Protected `typ=access` and `typ=refresh` values separate their uses. Verification fixes `alg`, `kid`, `iss`, `aud`, `typ`, `iat`, `nbf`, `exp`, and `jti`, bounds carrier size, and accepts only configured key ids.

The refresh JWT carries the random opaque secret and ids returned by `ctx.authTokens`; persistent Providers continue to receive and store only its digest. Refresh verifies the signed envelope before passing that secret to atomic rotation. Replaying an old signed refresh JWT therefore reaches the rotated digest and revokes the family. Access verification inspects the same family on every call and checks `ctx.users.requireActive()` for user principals.

The keyring decodes and validates every secret when the Provider is constructed. The refresh lifetime must be greater than or equal to the access lifetime. Issue and refresh capture the active key before family mutation, then use `issueFamilyWithPreparation()` or `rotateWithPreparation()` to construct and sign both JWTs while the durable Provider holds its transaction lock. The Provider commits only after the callback succeeds. A signing failure creates no family; a rotation signing or candidate-consistency failure leaves the old Credential active and reusable. Public authentication errors retain only stable code and message fields, never the underlying Provider or JOSE cause.

## Consequences

Key rotation adds a new key, selects it as active, retains old verification keys through their maximum token lifetime, and then removes them. Access JWT ids remain self-contained and do not appear in lifecycle inspection; family or principal revocation remains effective because verification consults durable family state.

HS256 keeps this Provider's deployment model small but shares signing authority with every verifier. Asymmetric or remote signing belongs in a separate Provider that can complete signing inside the same transactional preparation contract.

## Alternatives considered

**Use a stateless refresh JWT.** Rejected because rotation, replay detection, principal revocation, and family compromise require authoritative server-side state.

**Return the opaque refresh secret directly.** Rejected for this Provider because the selected product contract requires both Token classes to be signed and type-separated; the inner random secret still supplies the one-time server-side binding.

**Store every access JWT.** Rejected because family inspection already provides immediate revocation while short access expiry bounds exposure; a durable access index would add writes and cleanup without a current Consumer.

**Commit and compensate after a signing failure.** Rejected because compensation introduces a second failure path and temporarily exposes state that can never be delivered. Transactional preparation prevents that state from being committed.

## Verification

The package tests exercise issue, access verification, refresh rotation, old refresh replay, access/refresh confusion, refresh tampering, explicit revocation, disabled users, key rotation, Provider outages, forged access and refresh claims, oversized input, failed issue and rotation preparation, and retry after a failed rotation signature. The package's source reaches 100% statement, branch, function, and line coverage through the public authentication and credential lifecycle paths.
