# Agent Note: Password authentication adapter

Status: implemented

English | [中文](2026-08-24-password-authentication-adapter.zh.md)

## Problem

The authentication runtime selects Providers and mints trusted calls, while the user credential service owns identifier normalization and password verification. A human login needs to compose those services without moving password storage into authentication, teaching a transport about credential Provider APIs, or exposing account existence through different failures and execution paths.

## Decision

`@deepseek-ai/dsh-auth-password` is a single-purpose authentication Provider plugin. It extends `AuthenticationEvidenceMap` with `password`, containing one extensible login identifier and candidate password, and registers authentication method `password`. Trusted transport Consumers create this evidence; the plugin does not parse a protocol request.

The Provider resolves the identifier through `ctx.userCredentials`, then calls `verifyPassword()` exactly once. A missing resolution is passed as an omitted `userId`, so the credential Provider performs its dummy verifier instead of the authentication adapter returning early. Only a successful resolution and password match produces verified user identity facts. `ctx.auth` remains the sole component that mints and validates `AuthenticatedCall` provenance.

## Failure semantics

Credential rejection, unknown identifiers, and malformed login values become the same fixed `unauthenticated` error. Credential Provider storage or hashing failures become one fixed `authentication-unavailable` error. The adapter attaches no cause, identifier, password, SQL, hash, or verifier diagnostic to either error.

The authentication runtime owns the sanitized `auth/result` event. The password adapter emits no additional event and returns no `credentialId`, because the candidate password is neither a persistent public credential identifier nor lifecycle state.

## Provider selection and lifetime

The plugin uses the authentication registry's existing exact-key rules. Evidence kind `password` selects this Provider directly; no Provider chain or fallback runs. A duplicate evidence kind or duplicate method fails at registration. The registry disposer belongs to the plugin fiber, so unload removes the route and invalidates calls minted through it.

## Alternatives considered

**Add password methods to `dsh-auth`.** Rejected because the authentication foundation would then depend on human account storage and one credential family. API keys, JWTs, local identities, and future evidence do not need login identifier lookup.

**Resolve identifiers in the gateway.** Rejected because each transport would have to reproduce enumeration resistance and call the dummy verifier correctly. The gateway owns carrier extraction, ambiguity rejection, rate limits, and protocol mapping; the Provider owns evidence verification.

**Return immediately for an unknown identifier.** Rejected because it skips password-verifier work and creates an account enumeration signal. The credential Provider owns comparable real and dummy work, while this adapter guarantees both paths invoke it.

**Issue JWTs from password verification.** Rejected because evidence verification and credential lifecycle have different failure and storage semantics. A token Provider issues credentials after the password-authenticated identity has been established.

## Consequences

Every transport reaches the same password verification flow and receives only the authentication runtime's stable categories. Passwords remain transient inputs to the credential Provider and never become authenticated-call fields, audit records, or token implementation state.

The concrete credential Provider remains responsible for strong hashing and comparable dummy work, and the gateway remains responsible for rate limits and ambiguous carriers. Account active-state policy, authorization, token issuance, registration, recovery, MFA, and lockout stay outside this narrowly scoped plugin.
