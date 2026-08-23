# `@deepseek-ai/dsh-file-storage`

[English](README.md) | 中文

该 Cordis 服务提供与存储提供方无关的 `fileStorage` 文件对象接口。默认实现是本地内容寻址存储；后续可以用 S3 或 MinIO 实现同一个 `FileObjectStore` 接口，而不修改消息表和文件元数据表。

## 服务接口

- `ctx.fileStorage.put(data, expectedSha256?)` 发布文件字节，并返回摘要、提供方 key、后端名称和字节数。
- `ctx.fileStorage.get(storageKey, expectedSha256, signal?)` 读取文件字节，并在返回前校验摘要。
- 对象路径为配置根目录下的 `objects/<sha256 前两位>/<sha256>`。内容相同的文件只写入一次，之后复用同一个对象。

该服务只负责文件字节。会话插件负责用户/会话元数据、权限校验和 MySQL 中的消息关联，并把返回的 `storageBackend` 和 `storageKey` 保存为元数据。

## 配置

| Key | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `root` | string | 必填 | 本地对象存储的持久化根目录；不使用 cwd 回退。 |

## 模型体验

### 文件对象

#### 模型看到的内容

模型不会直接看到该服务。它是持久化和附件插件使用的 Host 侧能力。

#### Token 影响

直接影响为零。是否把文件内容提供给模型由调用方插件决定。

#### KV Cache 影响

无。文件读写不会修改模型提示词前缀。

## 已知限制与暂缓事项

- 当前只提供本地实现。S3 和 MinIO 适配器暂缓实现；替换提供方时可以保持接口和 MySQL 元数据不变。
- 服务本身不执行用户授权。调用方必须在调用 `get()` 前完成文件归属校验。
