# Agent Note: MySQL refresh-token family Provider

Status: implemented

[English](2026-08-24-dsh-auth-token-mysql-provider.md) | 中文

## 问题

提供方无关的 [`dsh-auth-token` 生命周期](../../proposed/architecture/2026-08-23-dsh-auth-token-family-service.md) 需要持久的多进程存储，以保持 refresh token 严格一次轮换和 family 范围的重用吊销。数据库 Provider 不得持久化 bearer secret，不得返回其他检查目标的状态，也不能在轮换与吊销之间引入相互冲突的锁顺序。

## 决策

`@deepseek-ai/dsh-auth-token-mysql` 基于仅在 Host 中运行的 `ctx.mysql` 连接服务实现 `AuthTokenService`。它拥有 version 表、一个 token-family 表、一个 refresh-credential 表、对应索引和外键、全部 SQL、数据库行解码、事务策略与存储错误映射。它不修改 `dsh-auth-token`，也不向 `dsh-mysql` 添加 token 行为。

Schema version 1 保存 principal kind 和 id、family 生命周期状态、绝对过期时间、单调递增 revision 与可选吊销 metadata。每个 credential 数据行保存 id、family id、唯一 SHA-256 digest、生命周期状态、过期时间以及轮换或吊销 metadata。只有因为 `dsh-auth-token` 生成至少 256 位随机熵的 refresh secret，SHA-256 才适合此处；该 schema 不通过此 API 接收密码。

创建 family 时在一个事务中插入 family 与初始 credential。轮换先读取 digest 来确定不可变的 family id，锁定该 family，然后锁定 credential 并再次验证两者关系。每条吊销路径都按确定的 id 顺序锁定 family，再锁定或更新它们的 credential。统一的 family-first 顺序防止轮换与吊销形成应用层锁循环。

针对同一个 active digest 的两次轮换会在 family 锁上串行执行。第一个事务将提交的 credential 标记为 rotated，插入沿用已锁定 family 绝对过期时间的 replacement，并推进 family revision。第二个事务发现 rotated credential 后吊销 family 及其所有 active credential，再次推进 revision，提交，并返回 `dsh-auth-token` 要求的重用结果。过期状态和 family 已吊销状态也在相同锁内完成检查，不发生修改。

检查操作只加载按 credential、family 或精确 principal 目标选出的 family，然后加载这些 family id 对应的 credential。按 credential 吊销时，先锁定其 family，再重新读取并锁定指定 credential，并将该记录作为 `matchedCredential` 返回，使 `dsh-auth-token` 能在发出事件前证明目标关系。Provider 错误不会包含 driver diagnostics、SQL、digest 或 bearer secret。

Schema 激活会拒绝不兼容版本、任何未记录版本的自有表，以及有版本记录但缺少任一自有表的状态。MySQL DDL 独立提交，因此建表与写入版本之间的故障可能留下未记录版本的状态；下次激活会快速失败，不猜测表所有权，也不补全只观察到一部分的 schema。

## 考虑过的替代方案

**保存 bearer refresh token。** 拒绝，因为数据库泄露会立即产生可用 credential。唯一 digest 能够完成精确查找与重放检测，同时不保留 bearer value。

**使用不带行锁的乐观更新。** 拒绝，因为 compare-and-set 失败可以识别竞争，但本身无法区分合法轮换与重用，也无法原子吊销 family 中每个 active credential。

**先锁定 credential，再锁定 family。** 拒绝，因为按 principal 和 family 吊销自然从一个或多个 family 开始。相反的顺序会在轮换与吊销之间产生可重复的死锁循环。

**删除已消费 credential。** 拒绝，因为已消费 digest 必须继续被识别为重用，Provider 才能吊销完整 family。

**共享用户目录的 schema metadata 表。** 拒绝，因为 token Provider 必须独立于用户资料和登录 credential 来拥有并版本化自己的持久格式。

## 后果

该 Provider 为多个 Host 进程提供一个持久的 refresh token 轮换与吊销串行点，同时让 bearer secret 保持短暂存在。重用检测会保留已消费 digest，直到后续 retention policy 删除 family。按 principal 吊销时会依照 id 顺序锁定所有选中的 family，持锁数量可能多于单 family 操作。Schema version 不匹配或未记录版本的部分 DDL 会导致启动失败，因为目前不存在已发布的持久兼容承诺。

无密钥测试针对串行的有状态 MySQL 测试服务运行共享 Provider suite，并固定 schema 所有权、精确目标绑定、回滚行为、错误脱敏、持久数据行验证、并发轮换、重用和幂等吊销。由 `DSH_MYSQL_TEST_URL` 控制的测试会创建真实 schema、验证只保存 digest、让两次轮换并发竞争、观察 family 吊销，并执行按 principal 吊销。
