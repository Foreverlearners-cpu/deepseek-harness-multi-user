import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthenticationRuntime from '@deepseek-ai/dsh-auth'
import Authority, { actionCode, resourceId, resourceType } from '@deepseek-ai/dsh-authority'
import AuthorityAcl, { aclSubjectRef } from '@deepseek-ai/dsh-authority-acl'
import Mysql, { type Config } from '@deepseek-ai/dsh-mysql'
import { teamId } from '@deepseek-ai/dsh-team'
import { userId } from '@deepseek-ai/dsh-user'
import { MemoryTeamMembership } from '../../authority-acl/tests/teams-stub.ts'
import AuthorityAclMysql from '../src/index.ts'

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

describe.skipIf(target === undefined)('real MySQL ACL policy source', () => {
  it('keeps a team grant as one row and isolates resource revisions', async () => {
    ctx = new Context()
    await ctx.plugin(Mysql, targetConfig())
    await ctx.plugin(AuthenticationRuntime)
    await ctx.plugin(Authority)
    await ctx.plugin(MemoryTeamMembership)
    await ctx.plugin(AuthorityAcl)
    await ctx.plugin(AuthorityAclMysql)

    const type = resourceType('plugin')
    const first = resourceId('plugin-acl-e2e-1')
    const second = resourceId('plugin-acl-e2e-2')
    const research = teamId('team-acl-e2e-rd')
    const execute = actionCode('plugin:execute')
    const read = actionCode('plugin:read')
    const teamGrant = {
      resource: { type, id: first },
      subject: { kind: 'team' as const, id: research },
      use: [execute],
      delegate: [],
    }
    const created = await ctx.authorityAclMysql.grant(teamGrant, 1)
    expect(created.subject).toEqual({ kind: 'team', id: research })
    expect(aclSubjectRef(created.subject)).toBe(`g:${research}`)
    expect(created.resourceRevision).toBe(1)
    await ctx.authorityAclMysql.grant({ ...teamGrant, use: [read] }, 2)
    await ctx.authorityAclMysql.grant({
      resource: { type, id: second },
      subject: { kind: 'everyone' },
      use: [execute],
      delegate: [],
    }, 1)

    const atFirst = await ctx.authorityAclMysql.listGrantsAt({ type, id: first }, 1)
    expect(atFirst).toHaveLength(1)
    expect(atFirst[0]).toMatchObject({
      resourceRevision: 1,
      use: [execute],
      subject: { kind: 'team', id: research },
    })
    await expect(ctx.authorityAclMysql.listGrantsAt({ type, id: first }, 2))
      .resolves.toMatchObject([{ resourceRevision: 2, use: [read] }])
    await expect(ctx.authorityAclMysql.listGrantsAt({ type, id: second }, 1))
      .resolves.toMatchObject([{ subject: { kind: 'everyone' }, use: [execute] }])

    const teams = ctx.get('teams') as unknown as MemoryTeamMembership
    teams.add(research, userId('user-acl-e2e'))
    expect(await ctx.authorityAclMysql.listGrants({ type, id: first })).toHaveLength(2)
  })
})
