# 与 Provider 无关的文件对象存储

[English](2026-08-25-provider-neutral-file-object-storage.md) | 中文

## 背景

Conversation 持久化需要为生成文件和过大的语义记录保存持久引用。现有 attachment 存储为通过校验的图片提供可靠的本地持久性，而 spill 存储有意提供临时的 session-scoped 文本，并且没有读取或保留期契约。若不扩大现有职责，两个服务都不能表示任意永久文件对象。

## 决策

`@deepseek-ai/dsh-file-storage` 定义独立于物理存储和业务所有权的不可变对象服务。`put` 消费异步字节流，并且只在确认完整对象的 SHA-256、字节长度、持久发布和立即可读之后返回。`open` 返回异步字节流，`stat` 只为 ready 对象解析规范元数据。

可序列化引用包含不透明的品牌化 object、backend 和 key 标识，以及 SHA-256 与字节长度。Provider 决定所有标识的含义。消费方原样持久化这些字段，并独立实施 tenant、user、Conversation、message、保留期和下载授权。

稳定的 `FileStorageError` 分类让消费方区分无效输入与引用、对象不存在或损坏、Provider 不可用和操作失败，同时不披露物理位置或 Provider 诊断。取消操作保留调用方的 abort 原因。

Service Definition 与每个 Provider 是独立插件。第一个 Provider 使用私有本地内容寻址存储，并且必须复用 attachment backend 的持久发布属性。共享一致性测试套件要求每个 Provider 遵守流式、不可变、ready 状态、完整性、取消和错误分类语义。

## 备选方案

扩展 `ctx.attachments` 会把通用文件与图片准入、尺寸、媒体 allowlist 和模型图片解析耦合。使用 `ctx.spillStore` 会持久化默认存储是临时的引用，并且其契约没有读取操作。把字节存入 MySQL 会扩大高频关系事务并重复对象存储行为。把本地 Provider 与 Service Definition 合并会让物理策略进入每个消费方的依赖图。

## 结果

领域插件需要在对象发布后通过额外事务记录所有权。数据库失败可能留下无法访问的不可变对象，因此仍需要感知引用的垃圾回收。最小 API 延后删除、范围读取、可恢复分段上传和多 backend 注册表，直到真实消费方需要这些能力。

## 验证

Service Definition 运行聚焦单元覆盖和导出的 Provider 一致性测试套件。本地 Provider 必须运行该套件，以及崩溃持久性、并发发布、损坏、路径逃逸、重启和大流测试。
