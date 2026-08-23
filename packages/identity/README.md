# identity/ — shared identity

English | [中文](README.zh.md)

Identity values and authentication contracts shared across product domains. Anonymous identity does not represent an
authenticated account; the auth runtime mints explicit request identity only after a Provider verifies evidence.

| Package | Role | ctx key |
|---|---|---|
| [`anonymous-user-id/`](anonymous-user-id/README.md) | Persists one anonymous Harness-home correlation id for telemetry, feedback, and DeepSeek requests | — |
| [`auth/`](auth/README.md) | Selects authentication Providers, mints current request identity, and routes optional credential lifecycle operations | `auth` |
