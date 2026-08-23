# @deepseek-ai/dsh-user-mysql

[English](README.md) | 中文

[`dsh-user`](../user) 人类用户目录的 MySQL Service Provider。它通过共享的 `dsh-mysql` 连接服务提供 `ctx.users`，并且只拥有用户目录 schema 和 SQL。

## 组合

先挂载一个 [`dsh-mysql`](../../multi/mysql) 服务，再挂载本插件。插件激活时会创建或验证 `dsh_user_schema` metadata 表与 `dsh_users` 数据表。已有 schema version 若不等于 `USER_MYSQL_SCHEMA_VERSION`，激活会失败；这个预发布 Provider 不迁移不兼容数据。

```yaml
- name: mysql
  package: '@deepseek-ai/dsh-mysql'
  config:
    host: mysql.internal
    user: dsh
    password: secret
    database: harness
- name: users
  package: '@deepseek-ai/dsh-user-mysql'
```

Consumer 使用与 Provider 无关的 API：

```ts
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-user'

export async function disableNewUser(ctx: Context): Promise<void> {
  const created = await ctx.users.create({ displayName: 'Alice' })
  const current = await ctx.users.requireActive(created.userId)
  await ctx.users.disable({ userId: current.userId, expectedRevision: current.revision })
}
```

只能挂载一个 `ctx.users` Provider。本包没有配置项，因为表名、索引和 schema identity 是由本包拥有的持久格式常量，不是部署调节项。

## 持久化

`dsh_users` 保存稳定 UUID `user_id`、可选 display name、生命周期状态、epoch 毫秒时间戳、单调递增 revision 和 JSON extensions。它具有二进制主键和 `(status, user_id)` 索引。用户名、password verifier、外部身份、角色、租户成员关系、token 和 session 仍由各自插件拥有。

每次修改会租用一个连接，用 `SELECT ... FOR UPDATE` 锁定目标行，验证 expected revision 和生命周期转换，使用 revision predicate 更新数据，读取已提交记录，然后提交事务。预期内的不存在和冲突保留 `dsh-user` 的错误码。连接、SQL、异常数据库行和事务故障统一变成 `provider-unavailable`，不会暴露 SQL 或 driver diagnostics。

列表操作按 `user_id` 升序执行 keyset pagination。不透明 cursor 携带最后返回的 id 和选定状态；格式错误或改用不同状态的 cursor 会以 `invalid-input` 失败。

## 模型体验

### MySQL 用户记录

#### 模型看到什么

什么也看不到。该 Provider 仅在 Host 中运行，不注册工具、prompt、消息或 Session event。此 Provider 提交后，`dsh-user` 服务发出已有的脱敏进程内变更事件。

#### Token 影响

每次请求直接增加零个 token。

#### KV Cache 影响

与模型请求无关：数据库读取和修改不会改变请求前缀。

## 已知限制和延后工作

- **仅支持 schema version 1** - 不兼容版本会导致激活失败；承诺持久兼容性前，后续版本必须增加显式 migration。
- **没有 transactional outbox** - `user/changed` 仍是提交后发出的进程内事件；持久 audit 投递需要独立拥有的 outbox 和 relay。
- **没有物理擦除** - 按照 `dsh-user` 的要求，目录删除是终态软删除。
- **单 database binding** - 本 Provider 使用唯一注入的 `ctx.mysql` 服务，不按 request 或 tenant 选择数据库。
