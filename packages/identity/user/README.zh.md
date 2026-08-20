# @deepseek-ai/dsh-user

[English](README.md) | 中文

面向租户运行时的用户身份 Service Definition。该包定义 `ctx.users` 和稳定的用户记录词汇；`@deepseek-ai/dsh-user-mysql` 等 Provider 负责存储。认证凭据和外部身份映射属于独立能力。

## API

`ctx.users` 负责创建、读取、禁用和列出当前运行时可见的用户。用户 ID 是稳定的内部标识，不是邮箱，也不是请求中直接提供的资源键。禁用用户会保留持久化数据，但不能开始新的工作。

## 模型体验

### 用户身份服务

#### 模型看到的内容

没有直接内容。该服务不注册工具、提示词、消息或 session 事件；可信 Host 消费者使用 `ctx.users` capability 完成产品操作授权。

#### Token 影响

每次请求都不会直接增加 token。

#### KV Cache 影响

与模型请求相互独立：用户记录不会改变请求前缀。

## 已知限制与暂缓事项

- 认证、密码存储、外部身份映射、token 撤销和 membership policy 属于后续独立工作。
- 第一版 Provider 按租户运行时绑定；在共享进程服务互不信任的用户前，还需要接入请求级认证上下文。
