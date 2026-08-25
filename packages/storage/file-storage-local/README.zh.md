# @deepseek-ai/dsh-file-storage-local

[English](README.md) | 中文

这是 [`@deepseek-ai/dsh-file-storage`](../file-storage/README.md) 的本地文件系统 Provider。配置必须显式指定私有 `root`；插件使用 backend 标识 `local` 注册 `ctx.fileStorage`。

`put()` 把调用方的字节流写入 `root` 下随机命名且仅所有者可访问的 staging 文件，同时计算 SHA-256 和字节数。Provider 刷新文件后，通过原子硬链接把它发布到内容寻址对象 key。staging 树和对象树处于同一文件系统；支持目录 `fsync` 的平台还会刷新对象目录，因此返回的引用在进程重启后仍可立即读取。相同内容的并发写入会汇聚到同一个不可变对象，并返回相同引用。

引用只包含 `objects/sha256/ab/cd/<digest>` 这类不透明相对 key，绝不会包含配置的 root 或其他绝对路径。Provider 会绑定并验证 backend、对象 id、key、摘要和字节数。`stat()` 验证这些字段及文件元数据；`open()` 还会在调用方迭代数据流时重新计算 SHA-256 和长度，如果不一致，会报告对象损坏而不是成功结束读取。

取消操作会原样保留 `AbortSignal` 的原因，并清理本次操作的 staging 文件。发布失败不会返回引用；如果对象已发布后才发生较晚的耐久化故障，可能留下不可达字节。本插件不提供删除、保留策略、租户策略、URL 生成、MinIO 或 S3 支持。

```yaml
- name: file-storage-local
  config:
    root: /var/lib/dsh/file-objects
```

## 模型体验

### 本地文件对象存储

#### 模型看到什么

`无`。领域 Consumer 决定是否把已授权对象写入模型可见的持久记录。

#### Token 影响

每次请求直接增加零个 Token。

#### KV Cache 影响

与模型请求无关。

## 已知限制与后续工作

- 本 Provider 只支持一个已配置的本地 root 和整对象读取，尚未实现范围读取、删除、保留、垃圾回收、静态加密和远程 backend。
- Windows 上 Node 无法打开目录，因此会跳过目录 `fsync`；文件刷新和原子硬链接发布仍然有效。
