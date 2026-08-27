# identity/ — shared identity

English | [中文](README.zh.md)

Identity values and authentication contracts shared across product domains. Anonymous identity does not represent an authenticated account; the auth runtime mints explicit request identity only after a Provider verifies evidence.

| Package | Role | ctx key |
|---|---|---|
| [`anonymous-user-id/`](anonymous-user-id/README.md) | Persists one anonymous Harness-home correlation id for telemetry, feedback, and DeepSeek requests | — |
| [`auth/`](auth/README.md) | Selects authentication Providers, mints current request identity, and routes optional credential lifecycle operations | `auth` |
| [`auth-gateway/`](auth-gateway/README.md) | Enforces HTTP and WebSocket carrier, CSRF, redaction, and current-call policy before delegating public account flows | `authGateway` |
| [`auth-starter/`](auth-starter/README.md) | Composes the complete MySQL authentication suite or its transport layer over custom storage Providers | — |
| [`auth-token/`](auth-token/README.md) | Defines opaque refresh-token families, atomic rotation, reuse detection, inspection, and revocation | `authTokens` |
| [`user/`](user/README.md) | Defines stable human users, profile records, lifecycle state, and Provider-independent management operations | `users` |
| [`user-mysql/`](user-mysql/README.md) | Persists the human user directory in MySQL | `users` |
| [`user-credential/`](user-credential/README.md) | Defines login identifiers, password verification, and credential lifecycle operations | `userCredentials` |
| [`user-credential-mysql/`](user-credential-mysql/README.md) | Persists login identifiers and scrypt password verifiers in MySQL | `userCredentials` |
| [`tenant/`](tenant/README.md) | Defines stable tenants, user membership records, lifecycle state, and Provider-independent management operations | `tenants` |
| [`team/`](team/README.md) | Defines stable teams under one tenant, user membership records, lifecycle state, and Provider-independent management operations | `teams` |
| [`authority/`](authority/README.md) | Decides allow or deny by intersecting same-team role and object action sets | `authority` |
| [`auth-rbac/`](auth-rbac/README.md) | Unions team-scoped role actions and registers the authority role route | `authRbac` |
| [`authority-acl/`](authority-acl/README.md) | Unions object-grant actions and registers the authority object route | `authorityAcl` |
