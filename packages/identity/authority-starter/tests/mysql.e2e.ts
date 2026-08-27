import { Context } from '@deepseek-ai/cordis'
import AuthenticationRuntime from '@deepseek-ai/dsh-auth'
import Mysql, { type Config as MysqlConfig } from '@deepseek-ai/dsh-mysql'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Starter from '../src/index.ts'
import { AccountAdministrationStub } from './account-admin-stub.ts'

const target = process.env.DSH_MYSQL_TEST_URL
let ctx: Context | undefined

function mysqlConfig(): MysqlConfig {
  const url = new URL(target!)
  const database = decodeURIComponent(url.pathname.slice(1))
  if (url.protocol !== 'mysql:' || database.length === 0) throw new Error('DSH_MYSQL_TEST_URL must name a mysql database')
  return {
    host: url.hostname,
    ...(url.port === '' ? {} : { port: Number(url.port) }),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    connectionLimit: 4,
  }
}

async function dropOwnedTables(context: Context): Promise<void> {
  await context.mysql.connection(async (connection) => {
    for (const table of [
      'dsh_resource_action_grants',
      'dsh_principal_roles',
      'dsh_role_action_grants',
      'dsh_team_memberships',
      'dsh_teams',
      'dsh_tenant_memberships',
      'dsh_tenants',
      'dsh_acl_schema',
      'dsh_rbac_schema',
      'dsh_team_schema',
      'dsh_tenant_schema',
    ]) {
      await connection.query(`DROP TABLE IF EXISTS ${table}`)
    }
  })
}

beforeEach(async () => {
  if (target === undefined) return
  const cleanup = new Context()
  await cleanup.plugin(Mysql, mysqlConfig())
  await dropOwnedTables(cleanup)
  await cleanup.fiber.dispose()

  ctx = new Context()
  await ctx.plugin(Mysql, mysqlConfig())
  await ctx.plugin(AuthenticationRuntime)
  await ctx.plugin(AccountAdministrationStub)
  await ctx.plugin(Starter)
})

afterEach(async () => {
  if (ctx === undefined) return
  await dropOwnedTables(ctx)
  await ctx.fiber.dispose()
  ctx = undefined
})

describe.skipIf(target === undefined)('complete authorization suite over real MySQL', () => {
  it('mounts directories and keeps administration fail-closed until grants exist', async () => {
    expect(ctx!.tenants).toBeDefined()
    expect(ctx!.teams).toBeDefined()
    expect(ctx!.authRbacMysql).toBeDefined()
    expect(ctx!.authorityAclMysql).toBeDefined()
    expect(ctx!.tenantAuthority).toBeDefined()
    expect(ctx!.accountAuthority).toBeDefined()
    await expect(ctx!.accountAdministration.authorizers.authorize({} as never, 'create'))
      .rejects.toMatchObject({ code: 'forbidden' })
  })
})
