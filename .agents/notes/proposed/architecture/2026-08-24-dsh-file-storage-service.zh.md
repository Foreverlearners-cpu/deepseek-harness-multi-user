# Agent Note：dsh-file-storage 服务

Status: proposed

[English](2026-08-24-dsh-file-storage-service.md) | 中文

## 问题

解耦 MySQL 交付方案需要为用户拥有的附件提供持久化文件对象，但耦合候选实现把文件契约留在同时修改 Host 路由的组合改动里。提供方无关的文件对象服务必须作为独立插件存在，让会话内容持久化和未来的 webserver 路由共享同一契约，而不修改 core、Host 或默认组合包。

## 提案

在 `packages/storage/file-storage` 新增 `@deepseek-ai/dsh-file-storage` 作为提供方无关的文件对象 Service Definition，并附带本地内容寻址实现。`ctx.fileStorage.put(data, expectedSha256?)` 按 SHA-256 发布不可变字节并返回提供方本地的 `FileObjectRef`；`get(storageKey, expectedSha256, signal?)` 读取并校验字节。默认 Provider 把对象存放在配置的本地根目录下，并且在首次写入前不会创建根目录。

### 内容寻址与安全

对象存放在 `objects/<sha256 前两位>/<sha256>`；发布幂等，并通过临时文件重命名保证并发安全。读取时校验摘要，并拒绝任何逃逸出配置根目录的 key。

### Provider 接缝

消费方依赖 `FileObjectStore` 契约而不是文件系统路径，因此 S3 或 MinIO Provider 可以在不改变会话或消息表的情况下替换本地实现。

## 考虑过的替代方案

**把文件存储并入会话内容持久化 Provider。** 不采用：文件有独立的生命周期和存储后端，且交付方案要求一个能力对应一个插件。

**在本分支给 Host API 添加文件路由。** 不采用：传输路由属于独立的 webserver 扩展插件；本分支只交付存储契约和本地 Provider。

## 验收标准

- `ctx.fileStorage` 在配置的本地根目录下发布、去重并校验内容寻址字节。
- 读取拒绝路径穿越和摘要损坏；并发重复发布幂等。
- 该包只依赖上游包，不修改任何既有包。
- 单元测试覆盖往返、摘要不匹配、篡改、根目录惰性创建和 invariant 注册。

## 风险

本地内容寻址只适用于单主机：多主机部署需要共享对象存储，这是未来 Provider 而不是本分支。root 是刻意显式的配置；配置错误可能把对象放到预期持久卷之外。
