import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Mysql, { type Config } from '@deepseek-ai/dsh-mysql'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import TeamMysqlDirectory from '../src/index.ts'

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

describe.skipIf(target === undefined)('real MySQL team directory', () => {
  it('persists Unicode teams and serializes stale concurrent kicks', async () => {
    ctx = new Context()
    await ctx.plugin(Mysql, targetConfig())
    await ctx.plugin(TeamMysqlDirectory)

    const owner = tenantId('tenant-concurrent')
    const created = await ctx.teams.create({ tenantId: owner, displayName: '\u56e2\u961f\u76ee\u5f55' })
    const added = await ctx.teams.addMember({
      teamId: created.teamId,
      tenantId: owner,
      userId: userId('user-concurrent'),
    })
    const competing = await Promise.allSettled([1, 2].map(async () => ctx!.teams.removeMembership({
      teamId: created.teamId,
      userId: added.userId,
      expectedRevision: added.revision,
    })))
    const successes = competing.filter(result => result.status === 'fulfilled')
    const failures = competing.filter(result => result.status === 'rejected')
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ reason: { code: 'revision-conflict' } })
    const removed = successes[0]!.value
    expect(await ctx.teams.getMembership(created.teamId, added.userId)).toEqual(removed)
    expect(removed).toMatchObject({ status: 'removed', revision: 2 })
  })
})
