# @deepseek-ai/dsh-tenant-authority

[English](README.md) | 中文

用于授权决策的跨租户拒绝守卫。该服务把可信的操作者 scope 与解析后的资源租户比较，把 resolver 注册到 `ctx.authority`，并在两者不一致时返回与资源不存在相同的公开拒绝。它不保存授权，不计算 Effective，也不读取 MySQL。

该包是 Service Definition 和 decide 入口 Consumer。部署时在 `ctx.auth`、`ctx.authority` 和 `ctx.tenants` 之后把它挂载为 `ctx.tenantAuthority`。产品调用方使用 `ctx.tenantAuthority.decide`，而不是 `ctx.authority.decide`。没有本插件时，authority 不会应用这条 not-found 规则。

## 公共 API

| API | 用途 |
|---|---|
| `ctx.tenantAuthority.registerResolver(type, resolver)` | 在本守卫和 `ctx.authority` 上注册该类资源的唯一 resolver |
| `ctx.tenantAuthority.match(query)` | 返回操作者 scope 是否匹配已解析的租户 |
| `ctx.tenantAuthority.decide(request)` | 在租户检查之后决定允许或拒绝 |
| `ctx.tenantAuthority.require(request)` | 要求允许，否则抛出对应的拒绝分类 |

请求携带可信的 `scope`。租户 scope 点名所选 `tenantId`。平台 scope 绝不会被当成租户成员。

调用方出示另一租户的有效 id 时，得到 `unresolved-resource`，与不存在的 id 公开结果相同。拒绝不会点名另一租户，也不会说该资源存在。

## 管理员操作

先挂载 `ctx.auth`、`ctx.authority` 和 `ctx.tenants`。在这里注册资源 resolver，在 authority 上注册角色和对象路线，再通过本服务做决定：

```text
trusted scope + resource pointer
  -> ctx.tenantAuthority.decide
  -> same-tenant membership check
  -> ctx.authority.decide
```

卸载 `tenantAuthority` fiber 会注销它转发到 authority 的 resolver。

## 失败语义

| Code | 含义 |
|---|---|
| `invalid-input` | 请求、scope 或 resolver 注册值格式无效 |
| `conflict` | 该类资源已经注册了 resolver |
| `unresolved-resource` | 资源缺失、操作者不在所选租户、租户不一致，或 scope 是平台 |
| `missing-provider` | 该类资源没有注册 resolver |
| `provider-unavailable` | 成员查询或 resolver 意外失败 |

传输适配器决定哪些内部分类应折叠成同一种公开响应。跨租户与 not-found 必须保持同一公开分类。

## 模型体验

### 租户守卫求值

#### 模型看到什么

什么也看不到。`ctx.tenantAuthority.decide` 的结果、成员查询和跨租户拒绝只存在于 Host；该包不注册可能向模型暴露这些数据的 prompt section、工具或 Session event。

#### Token 影响

为零。租户守卫求值不会增加、删除或改写模型输入 Token。

#### KV Cache 影响

相互独立。租户守卫求值不会改变模型可见的请求前缀，因此不会使原本可复用的 Provider cache entry 失效。

## 已知限制与延期工作

- **必须挂载** - `ctx.authority.decide` 不会做这项检查。需要 not-found 规则的组合必须调用 `ctx.tenantAuthority.decide`。
- **没有角色或授权存储** - Effective 仍由 `dsh-authority` 负责。
- **没有平台租户绕过** - 平台 scope 不能通过本包打开租户资源。
- **没有持久化审计投递** - 决策是进程内返回值。
