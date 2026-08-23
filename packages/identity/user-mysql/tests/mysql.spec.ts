import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Mysql from '@deepseek-ai/dsh-mysql'
import MysqlUserService from '../src/index.ts'
import { UserId } from '@deepseek-ai/dsh-user'
import type { Config as MysqlConfig } from '@deepseek-ai/dsh-mysql'

const target = process.env.DSH_MYSQL_TEST_URL
let ctx: Context | undefined
let userFiber: Awaited<ReturnType<Context['plugin']>> | undefined

afterEach(async () => {
  await userFiber?.dispose()
  await ctx?.fiber.dispose()
  userFiber = undefined
  ctx = undefined
})

function targetConfig(): MysqlConfig {
  const url = new URL(target!)
  if (url.protocol !== 'mysql:') throw new Error('DSH_MYSQL_TEST_URL must use the mysql: scheme')
  const database = decodeURIComponent(url.pathname.slice(1))
  return {
    host: url.hostname,
    ...(url.port === '' ? {} : { port: Number(url.port) }),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    connectionLimit: 2,
  }
}

async function boot(): Promise<void> {
  ctx = new Context()
  await ctx.plugin(Mysql, targetConfig())
  userFiber = await ctx.plugin(MysqlUserService)
}

describe.skipIf(target === undefined)('MySQL user provider', () => {
  it('creates, reads, lists, and disables a user', async () => {
    await boot()
    const id = UserId(`user-${Date.now()}-${Math.random().toString(16).slice(2)}`)

    const created = await ctx!.users.create({ id, displayName: 'Alice' })
    expect(created).toMatchObject({ id, displayName: 'Alice', status: 'active', revision: 0 })
    await expect(ctx!.users.requireActive(id)).resolves.toMatchObject({ id })
    expect(await ctx!.users.list()).toHaveLength(1)

    await ctx!.users.disable(id)
    await expect(ctx!.users.requireActive(id)).rejects.toThrow(/not active/)
    await expect(ctx!.users.get(id)).resolves.toMatchObject({ status: 'disabled' })
  })

  it('rejects duplicate users and shares user records across runtimes', async () => {
    const id = UserId(`duplicate-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    await boot()
    await ctx!.users.create({ id })
    await expect(ctx!.users.create({ id })).rejects.toThrow(/already exists/)

    const other = new Context()
    await other.plugin(Mysql, targetConfig())
    const otherFiber = await other.plugin(MysqlUserService)
    try {
      await expect(other.users.get(id)).resolves.toMatchObject({ id, status: 'active' })
      await expect(other.users.requireActive(id)).resolves.toMatchObject({ id })
    } finally {
      await otherFiber.dispose()
      await other.fiber.dispose()
    }
  })
})
