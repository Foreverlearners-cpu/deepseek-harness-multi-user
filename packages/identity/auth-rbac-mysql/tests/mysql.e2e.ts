import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthenticationRuntime from '@deepseek-ai/dsh-auth'
import Authority, { actionCode, resourceId, resourceType } from '@deepseek-ai/dsh-authority'
import AuthRbac, { roleId } from '@deepseek-ai/dsh-auth-rbac'
import Mysql, { type Config } from '@deepseek-ai/dsh-mysql'
import { teamId } from '@deepseek-ai/dsh-team'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import AuthRbacMysql from '../src/index.ts'

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

describe.skipIf(target === undefined)('real MySQL RBAC policy source', () => {
  it('keeps the same user\'s two team roles isolated and honors revoke', async () => {
    ctx = new Context()
    await ctx.plugin(Mysql, targetConfig())
    await ctx.plugin(AuthenticationRuntime)
    await ctx.plugin(Authority)
    await ctx.plugin(AuthRbac)
    await ctx.plugin(AuthRbacMysql)

    const user = userId('user-rbac-e2e')
    const tenant = tenantId('tenant-rbac-e2e')
    const research = teamId('team-rbac-e2e-rd')
    const operations = teamId('team-rbac-e2e-ops')
    const runner = roleId('e2erunner')
    const viewer = roleId('e2eviewer')
    const read = actionCode('plugin:read')
    const execute = actionCode('plugin:execute')
    const created = await ctx.authRbacMysql.putRole({
      roleId: runner,
      use: [read, execute],
      delegate: [],
    })
    expect(created.revision).toBeGreaterThanOrEqual(1)
    await ctx.authRbacMysql.putRole({ roleId: viewer, use: [read], delegate: [] })
    await ctx.authRbacMysql.assign({ userId: user, tenantId: tenant, teamId: research, roleId: runner })
    await ctx.authRbacMysql.assign({ userId: user, tenantId: tenant, teamId: operations, roleId: viewer })

    const query = (team: ReturnType<typeof teamId>) => ({
      userId: user,
      tenantId: tenant,
      teamId: team,
      action: execute,
      resource: {
        type: resourceType('plugin'),
        id: resourceId('plugin-e2e'),
        tenantId: tenant,
        teamId: team,
        revision: 1,
      },
      set: 'use' as const,
    })

    await expect(ctx.authRbac.evaluate(query(operations))).resolves.toEqual({ actions: [read] })
    await expect(ctx.authRbac.evaluate(query(research))).resolves.toEqual({ actions: [read, execute] })

    const updated = await ctx.authRbacMysql.putRole({ roleId: runner, use: [read], delegate: [] })
    expect(updated.revision).toBe(created.revision + 1)
    await expect(ctx.authRbac.evaluate(query(research))).resolves.toEqual({ actions: [read] })

    const revoked = await ctx.authRbacMysql.revoke({
      userId: user,
      tenantId: tenant,
      teamId: research,
      roleId: runner,
    })
    expect(revoked).toMatchObject({ status: 'revoked' })
    await expect(ctx.authRbac.evaluate(query(research))).resolves.toEqual({ actions: [] })
    await expect(ctx.authRbac.evaluate(query(operations))).resolves.toEqual({ actions: [read] })
  })
})
