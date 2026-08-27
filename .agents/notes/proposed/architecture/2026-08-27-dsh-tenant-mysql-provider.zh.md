# Agent Note: MySQL tenant-directory Provider

Status: proposed

[English](2026-08-27-dsh-tenant-mysql-provider.md) | 中文

## 问题

与 Provider 无关的 [`dsh-tenant` 目录](2026-08-26-dsh-tenant-directory-service.md)需要持久化多进程存储，同时不能把角色、团队、对象授权或连接池所有权转移进租户服务。它的乐观 revision 以及「一对一对应当前槽位」的成员保证，要求数据库操作在并发进程下仍保持原子性。

## 提案

增加 `@deepseek-ai/dsh-tenant-mysql`，作为基于 Host-only `ctx.mysql` 连接服务的具体 `TenantDirectory` 子类。Provider 拥有 `dsh_tenant_schema`、`dsh_tenants`、`dsh_tenant_memberships`、索引、SQL、schema version、cursor 编码和存储错误映射。它既不修改 `dsh-tenant`，也不扩展 `dsh-mysql`。

Schema version 1 为每个由 Provider 生成的稳定 UUID 保存一行租户，并为每个 `(tenant_id, user_id)` 保存一个当前成员槽位。租户主键和成员唯一 `membership_id` 采用 binary ASCII 比较。`(tenant_id, status, membership_id)` 与 `(user_id, status, membership_id)` 支持有状态过滤和无过滤的升序 keyset scan。对已 removed 的配对再次加入会用新的 `membership_id` 和 revision 1 更新同一唯一槽位。

租户修改开启事务并用 `SELECT ... FOR UPDATE` 锁定租户行。创建成员时先锁租户行再锁成员槽位，因此并发的租户禁用与加人共享同一锁顺序。成员状态修改只锁定成员槽位。更新前检查记录不存在、expected revision 和请求的状态转换，再使用 revision predicate 写入，重新读取并提交，随后基础服务才发出事件。回滚失败和结果不确定的数据库故障变成 `provider-unavailable`；只有回滚成功后，预期内目录冲突才保留稳定错误码。

列表 cursor 编码 version、排他的 `membership_id` 下界、可选状态过滤，以及租户或用户范围 id。Cursor 对 Consumer 不透明，不能在不同过滤条件或范围下复用。无效 cursor 数据产生 `invalid-input`；driver 和行解码故障产生 `provider-unavailable`。

## 备选方案

**把 SQL 放进 `dsh-tenant`。** 拒绝，因为 Service Definition 必须可与其他存储 Provider 配合使用，并且不能要求 Host 数据库连接。

**先给 `dsh-mysql` 增加事务和 migration。** 当前阶段拒绝，因为现有 callback-scoped connection 已经公开 driver transaction。重复 Consumer 证明存在有用的基础设施抽象之前，领域表和 migration policy 归本 Provider 所有。

**使用 offset pagination。** 拒绝，因为并发插入和生命周期变化会使 offset 跳过或重复无关行，而且较大 offset 需要扫描被丢弃的行。

**把团队或用户授权展开成按用户一行的成员记录。** 拒绝，因为本包是租户目录，不是 ACL 存储。一个 `(tenant_id, user_id)` 槽位就是当前成员事实；后续 ACL 包不得在此把团队主体展开。

**在事务内发布 live event。** 拒绝，因为 listener 可能在持锁期间阻塞或失败，live callback 也不能原子参与 MySQL commit。持久投递需要后续 transactional outbox。

## 后果

该 Provider 为一个 MySQL-backed 部署提供持久租户与成员生命周期和 revision 语义，同时角色、团队和对象授权保持独立。UUID 顺序稳定，但不是创建顺序。软删除租户和已 removed 的成员槽位保持可寻址并继续占用 keyspace。由于仓库尚未承诺已发布持久兼容性，schema version 不匹配会使启动失败。

## 验收标准

- 插件通过 `ctx.mysql` 提供未改变的 `ctx.tenants` API，并且不拥有角色、团队或对象授权数据。
- 并发租户和成员修改在锁定行上串行执行，强制检查 expected revision 和生命周期转换，基础服务在提交前不发出事件。
- 有状态过滤和无过滤的租户范围与用户范围页面使用绑定 keyset cursor；格式错误或不匹配的 cursor 以 `invalid-input` 失败。
- 意外 schema、连接、SQL、行解码、提交和回滚故障只以 `provider-unavailable` 跨越目录 API。
- 聚焦无密钥测试满足仓库逐文件覆盖率门禁；真实 MySQL 验证继续由 `DSH_MYSQL_TEST_URL` 控制。

## 风险

- MySQL DDL 独立提交，因此后续 schema 初始化失败时，启动可能留下 version metadata 或表。再次激活会确定性验证并补全相同的 version-1 schema。
- Commit 失败可能使调用方无法确定结果。Provider 报告 `provider-unavailable`，并且不会重试可能已经到达服务器的修改。
- UUID key 顺序分散插入，但不保留租户或成员创建顺序。需要按时间管理的 Consumer 必须另行定义 cursor 和索引，不能从该 API 推断顺序。

## 验证

共享 Provider suite 在有状态 MySQL test double 上执行。Provider 测试固定 schema compatibility、keyset/filter/scope cursor 验证、锁顺序、rollback 保留、存储错误脱敏和异常数据库行拒绝。使用 `DSH_MYSQL_TEST_URL` 的环境门控测试覆盖真实 schema 创建与并发成员 revision 冲突。
