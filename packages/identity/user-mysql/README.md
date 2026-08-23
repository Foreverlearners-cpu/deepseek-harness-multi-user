# @deepseek-ai/dsh-user-mysql

English | [中文](README.zh.md)

User-scoped MySQL provider for `@deepseek-ai/dsh-user`. It owns the `dsh_users` table, keeps user lifecycle state separate from authentication credentials, leases connections through `@deepseek-ai/dsh-mysql`, and owns its transaction sequence inside each lease.

## Configuration

| Key | Required | Meaning |
| --- | --- | --- |
| `bootstrapUserId` | no | Optional user id created as `active` during startup for local development. |
| `bootstrapDisplayName` | no | Display name for the optional bootstrap user. |

The provider requires `ctx.mysql`. It creates the schema before exposing `ctx.users`. A bootstrap user is a local-development convenience, not an authentication mechanism.

## Lifecycle and ownership

The active application scope is `user_id`. New databases contain no `tenant_id` column. `disable()` changes lifecycle state while retaining the row and owned data. This provider does not store passwords, tokens, or external identity claims.

## Model Experience

### MySQL user directory

#### What the model sees

Nothing. The provider adds no tools, prompts, messages, or session events; it only owns the `dsh_users` table behind `ctx.users`.

#### Token effect

Zero direct tokens on every request.

#### KV Cache effect

Independent of model requests: user directory operations do not change a request prefix.

## Known Limitations and Deferred Work

- Authentication, external identity mappings, revocation, membership, and authorization policy are not implemented.
- Session persistence currently binds one provider instance to one `ownerUserId`; request-level authentication and tenant scoping remain deferred.
- A legacy schema containing `tenant_id` is rejected at startup; recreate this unreleased database or run an explicit user-id-only migration.
