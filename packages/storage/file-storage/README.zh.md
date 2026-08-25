# @deepseek-ai/dsh-file-storage

[English](README.md) | 中文

与 Provider 无关的不可变文件对象存储。`ctx.fileStorage` 允许领域插件以流式方式写入任意字节并持久化返回的 `FileObjectRef`，而不需要知道文件系统路径、远端 URL、bucket 或 Provider 内部 key 格式。

`put()` 消费 `AsyncIterable<Uint8Array>`。Provider 消费完整数据流、校验可选的 `expectedSha256` 和 `expectedByteSize`、持久发布不可变字节，并保证 `open()` 与 `stat()` 可以立即访问对象之后，该方法才会完成。空对象有效。相同内容可以去重为同一个引用。失败写入不会返回引用，但 Provider 中无法访问的字节可以留待后续垃圾回收。

每个引用携带不透明的品牌化 `objectId`、`storageBackend` 和 `storageKey`，以及小写 SHA-256 和准确字节长度。消费方原样持久化所有字段，并把引用路由回指定 Provider；消费方绝不把 key 解析为路径或 URL。`open()` 把 ready 对象解析为异步字节流，并校验引用、digest 和长度。`stat()` 只返回 `status: 'ready'` 和规范引用元数据。Provider 拒绝属于其他 backend 的引用。

`FileStorageError` 提供稳定的操作和分类字段，其消息不包含对象 key、路径、URL、内容或 Provider 诊断。分类区分无效引用、调用方提供的 checksum 或 size 不匹配、对象不存在或损坏、Provider 不可用，以及读取、写入或元数据失败。Provider 保留 `AbortSignal` 原因，不把取消转换为 `FileStorageError`。

本包不负责 tenant、user、Conversation、message、保留期、路径、下载授权或数据库策略。领域插件围绕不透明 ready 引用建立所有权和生命周期。Provider 负责物理存储，并运行 `tests/contract.ts` 中的共享测试套件。

## Model Experience

### File-object storage

#### What the model sees

`None`。消费方可以通过自己的已记录消息或工具公开经过授权的文件引用。

#### Token effect

每次请求直接产生零 token。

#### KV Cache effect

与模型请求无关。

## Known Limitations and Deferred Work

- 服务提供 `put`、`open` 和 `stat`；删除、保留期、垃圾回收、范围读取和分段续传协议仍是后续领域与 Provider 工作。
- 第一个 Provider 是本地存储；S3-compatible 和 MinIO Provider 延后。
- 当前契约没有在同一个 Cordis context 中同时注册多个 backend 的注册表。
