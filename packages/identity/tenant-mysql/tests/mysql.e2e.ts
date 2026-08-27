import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Mysql, { type Config } from '@deepseek-ai/dsh-mysql'
import { userId } from '@deepseek-ai/dsh-user'
import TenantMysqlDirectory from '../src/index.ts'

const target = process.env.DSH_MYSQL_TEST_URL
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

function targetConfig(): Config {
  const url = new URL(target!)
  if (url.protocol !== 'mysql:') throw new Error('DSH_MYSQL_TEST_URL must use the mysql: scheme')
  const database = decodeURIComponent(url.pathname.slice(1))
  if (database.length === 0) throw new Error('DSH_MYSQL_TEST_URL must name a database')
  return {
    host: url.hostname,
    ...(url.port === '' ? {} : { port: Number(url.port) }),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    connectionLimit: 2,
  }
}

describe.skipIf(target === undefined)('real MySQL tenant directory', () => {
  it('persists Unicode tenants and serializes stale concurrent membership revisions', async () => {
    ctx = new Context()
    await ctx.plugin(Mysql, targetConfig())
    await ctx.plugin(TenantMysqlDirectory)

    const created = await ctx.tenants.create({ displayName: '\u79df\u6237\u76ee\u5f55' })
    const added = await ctx.tenants.addMember({
      tenantId: created.tenantId,
      userId: userId('user-concurrent'),
    })
    const competing = await Promise.allSettled(['disabled', 'removed'].map(async () => ctx!.tenants.disableMembership({
      tenantId: created.tenantId,
      userId: added.userId,
      expectedRevision: added.revision,
    })))
    const successes = competing.filter(result => result.status === 'fulfilled')
    const failures = competing.filter(result => result.status === 'rejected')
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ reason: { code: 'revision-conflict' } })
    const updated = successes[0]!.value
    const removed = await ctx.tenants.removeMembership({
      tenantId: created.tenantId,
      userId: added.userId,
      expectedRevision: updated.revision,
    })

    expect(await ctx.tenants.getMembership(created.tenantId, added.userId)).toEqual(removed)
    expect(removed).toMatchObject({ status: 'removed', revision: 3 })
  })
})
