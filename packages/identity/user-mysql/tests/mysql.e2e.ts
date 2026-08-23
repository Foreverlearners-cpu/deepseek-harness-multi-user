import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Mysql, { type Config } from '@deepseek-ai/dsh-mysql'
import UserMysqlDirectory from '../src/index.ts'

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

describe.skipIf(target === undefined)('real MySQL user directory', () => {
  it('persists profile and lifecycle revisions across Provider calls', async () => {
    ctx = new Context()
    await ctx.plugin(Mysql, targetConfig())
    await ctx.plugin(UserMysqlDirectory)

    const created = await ctx.users.create({
      displayName: 'MySQL E2E',
      extensions: { 'dsh-user-mysql/test': true },
    })
    const updated = await ctx.users.update({
      userId: created.userId,
      expectedRevision: created.revision,
      patch: { displayName: 'MySQL E2E updated' },
    })
    const deleted = await ctx.users.delete({
      userId: updated.userId,
      expectedRevision: updated.revision,
    })

    expect(await ctx.users.get(created.userId)).toEqual(deleted)
    expect(deleted).toMatchObject({ status: 'deleted', revision: 3 })
  })
})
