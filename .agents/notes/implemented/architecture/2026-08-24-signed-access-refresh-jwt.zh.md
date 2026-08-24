# Agent Note：签名 access 与 refresh JWT

Status: implemented

[English](2026-08-24-signed-access-refresh-jwt.md) | 中文

## 问题

HTTP 和 SDK 传输需要紧凑的 access Credential 与已签名 refresh Credential，同时不能在 JWT 专用存储中重复身份、撤销和重放状态。仅靠签名无法禁用用户、撤销 family 或检测复用。把 refresh 当作无状态 JWT 会让仍然有效的旧 Token 绕过原子 family 状态机。

Credential 签发与刷新还会跨越事务边界：JWT Provider 返回签名封装之前，`ctx.authTokens` 已经提交新的不透明 secret。提交后的签名失败不能留下一个仍然 active、但唯一 refresh secret 从未交付的 family。

## 决策

`@deepseek-ai/dsh-auth-jwt` 注册一个使用 `jwt` method 的 `bearer` Authentication Provider。它通过 JOSE 使用固定 HS256 profile 签名 access 与 refresh JWT。受保护的 `typ=access` 和 `typ=refresh` 区分两种用途。验证固定 `alg`、`kid`、`iss`、`aud`、`typ`、`iat`、`nbf`、`exp` 与 `jti`，限制 carrier 大小，并且只接受已配置 key id。

Refresh JWT 携带 `ctx.authTokens` 返回的随机不透明 secret 与 id；持久化 Provider 仍然只接收并存储其 digest。刷新先验证签名封装，再把该 secret 交给原子轮换。因此重放旧的已签名 refresh JWT 会命中 rotated digest 并撤销 family。每次 access 验证都会检查同一 family，对于 user principal 还会检查 `ctx.users.requireActive()`。

Provider 构造时会解码并验证 keyring 中的每个 secret。签发与刷新在提交 family 状态前捕获 active key。JWT 构造与签名位于提交后补偿块内。任何失败都会使用新的、未取消 signal 同步撤销已提交 family，然后 Provider 才返回 unavailable 失败。轮换结果不一致时，补偿使用已验证 refresh JWT 中的 family id，而不是不可信的返回 id。

## 结果

Key 轮换会添加新 key、把它选为 active、在旧 Token 的最长生命周期内保留旧验证 key，然后移除旧 key。Access JWT id 保持自包含，不出现在生命周期检查中；family 或 principal 撤销仍然立即有效，因为验证会查询持久 family 状态。

HS256 让该 Provider 的部署模型保持简单，但每个验证方都共享签名权限。非对称或远程签名属于另一个 Provider；该 Provider 必须保证准备之后的提交后操作不会失败，或者实现相同的同步补偿义务。

## 考虑过的替代方案

**使用无状态 refresh JWT。** 拒绝，因为轮换、重放检测、principal 撤销与 family 泄露处理需要权威的服务端状态。

**直接返回不透明 refresh secret。** 对该 Provider 拒绝，因为选定的产品契约要求两类 Token 都经过签名并按类型隔离；内部随机 secret 仍提供一次性服务端绑定。

**存储每个 access JWT。** 拒绝，因为 family 检查已提供即时撤销，短 access 过期时间也限制暴露；持久 access 索引会增加写入与清理，却没有当前 Consumer。

**签名失败后不补偿直接返回。** 拒绝，因为调用方会丢失唯一的新 refresh 值，而持久状态仍然 active。

## 验证

包测试覆盖签发、access 验证、refresh 轮换、旧 refresh 重放、access/refresh 混淆、refresh 篡改、显式撤销、禁用用户、key 轮换、Provider 故障、畸形 claim、超长输入，以及签名补偿成功与失败。该包源码通过公开 Authentication 与 Credential 生命周期路径达到 statement、branch、function 和 line 四项 100% 覆盖率。
