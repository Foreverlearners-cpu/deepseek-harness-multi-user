# identity/ — 共享身份

[English](README.md) | 中文

跨产品领域共享的身份值与认证契约。匿名身份不表示已认证账户；只有 Provider 验证证据后，认证运行时才会生成明确的请求身份。

| 包 | 职责 | ctx key |
|---|---|---|
| [`anonymous-user-id/`](anonymous-user-id/README.md) | 为遥测、反馈和 DeepSeek 请求持久化一个限定于 Harness home 的匿名关联 id | — |
| [`auth/`](auth/README.md) | 选择认证 Provider、生成当前请求身份，并路由可选的凭证生命周期操作 | `auth` |
