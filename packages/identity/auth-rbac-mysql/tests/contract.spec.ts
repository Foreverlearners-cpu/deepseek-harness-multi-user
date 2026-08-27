import { afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthenticationRuntime from '@deepseek-ai/dsh-auth'
import Authority, { actionCode } from '@deepseek-ai/dsh-authority'
import AuthRbac, { roleId } from '@deepseek-ai/dsh-auth-rbac'
import { runAuthRbacContract } from '../../auth-rbac/tests/contract.ts'
import { teamId } from '@deepseek-ai/dsh-team'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import AuthRbacMysql from '../src/index.ts'
import { FakeMysql } from './fake-mysql.ts'

const USER = userId('user-red')
const TENANT = tenantId('tenant-1')
const TEAM_RD = teamId('team-rd')
const TEAM_OPS = teamId('team-ops')
const RUNNER = roleId('runner')
const VIEWER = roleId('viewer')
const READ = actionCode('plugin:read')
const EXECUTE = actionCode('plugin:execute')

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => context.fiber.dispose()))
})

runAuthRbacContract('mysql', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('mysql', new FakeMysql().asService())
  await ctx.plugin(AuthenticationRuntime)
  await ctx.plugin(Authority)
  await ctx.plugin(AuthRbac)
  await ctx.plugin(AuthRbacMysql)
  await ctx.authRbacMysql.putRole({ roleId: RUNNER, use: [READ, EXECUTE], delegate: [] })
  await ctx.authRbacMysql.putRole({ roleId: VIEWER, use: [READ], delegate: [] })
  await ctx.authRbacMysql.assign({ userId: USER, tenantId: TENANT, teamId: TEAM_RD, roleId: RUNNER })
  await ctx.authRbacMysql.assign({ userId: USER, tenantId: TENANT, teamId: TEAM_OPS, roleId: VIEWER })
  return { evaluate: query => ctx.authRbac.evaluate(query) }
})
