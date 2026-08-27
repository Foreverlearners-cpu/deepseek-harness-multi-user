import { afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthenticationRuntime from '@deepseek-ai/dsh-auth'
import Authority, { actionCode, resourceId, resourceType } from '@deepseek-ai/dsh-authority'
import AuthorityAcl from '@deepseek-ai/dsh-authority-acl'
import { runAuthorityAclContract } from '../../authority-acl/tests/contract.ts'
import { MemoryTeamMembership } from '../../authority-acl/tests/teams-stub.ts'
import { teamId } from '@deepseek-ai/dsh-team'
import { userId } from '@deepseek-ai/dsh-user'
import AuthorityAclMysql from '../src/index.ts'
import { FakeMysql } from './fake-mysql.ts'

const USER = userId('user-red')
const TEAM_RD = teamId('team-rd')
const TEAM_OPS = teamId('team-ops')
const EXECUTE = actionCode('plugin:execute')
const TYPE = resourceType('plugin')
const RESOURCE = resourceId('plugin-100')

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => context.fiber.dispose()))
})

runAuthorityAclContract('mysql', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('mysql', new FakeMysql().asService())
  await ctx.plugin(AuthenticationRuntime)
  await ctx.plugin(Authority)
  await ctx.plugin(MemoryTeamMembership)
  await ctx.plugin(AuthorityAcl)
  await ctx.plugin(AuthorityAclMysql)
  const teams = ctx.get('teams') as unknown as MemoryTeamMembership
  await ctx.authorityAclMysql.grant({
    resource: { type: TYPE, id: RESOURCE },
    subject: { kind: 'team', id: TEAM_RD },
    use: [EXECUTE],
    delegate: [],
  }, 1)
  teams.add(TEAM_RD, USER)
  teams.add(TEAM_OPS, USER)
  return { evaluate: query => ctx.authorityAcl.evaluate(query) }
})
