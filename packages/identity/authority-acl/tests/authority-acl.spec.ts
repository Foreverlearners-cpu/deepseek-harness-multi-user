import { Context } from '@deepseek-ai/cordis'
import AuthenticationRuntime, {
  authenticationMethod,
  authenticationRequestId,
} from '@deepseek-ai/dsh-auth'
import Authority, { actionCode, resourceId, resourceType } from '@deepseek-ai/dsh-authority'
import { teamId } from '@deepseek-ai/dsh-team'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import { describe, expect, it } from 'vitest'
import AuthorityAcl, {
  aclSubjectFromRef,
  aclSubjectRef,
  AuthorityAclError,
  MemoryAclPolicySource,
  MemoryAclRoleFactSource,
  roleId,
} from '../src/index.ts'
import { runAuthorityAclContract, setupAuthorityAcl } from './contract.ts'
import { MemoryTeamMembership } from './teams-stub.ts'

const USER = userId('user-red')
const OTHER = userId('user-blue')
const TENANT = tenantId('tenant-1')
const OTHER_TENANT = tenantId('tenant-2')
const TEAM_RD = teamId('team-rd')
const TEAM_OPS = teamId('team-ops')
const RUNNER = roleId('runner')
const READ = actionCode('plugin:read')
const EXECUTE = actionCode('plugin:execute')
const TYPE = resourceType('plugin')
const RESOURCE = resourceId('plugin-100')
const OTHER_RESOURCE = resourceId('plugin-200')

function useQuery(team = TEAM_RD, set: 'use' | 'delegate' = 'use') {
  return {
    userId: USER,
    tenantId: TENANT,
    teamId: team,
    action: EXECUTE,
    resource: {
      type: TYPE,
      id: RESOURCE,
      tenantId: TENANT,
      teamId: team,
      revision: 1,
    },
    set,
  }
}

runAuthorityAclContract('memory source', async () => {
  const { authorityAcl } = await setupAuthorityAcl()
  return { evaluate: query => authorityAcl.evaluate(query) }
})

describe('authority-acl validation', () => {
  it('encodes subjects as stable refs and rejects malformed refs', () => {
    expect(aclSubjectRef({ kind: 'everyone' })).toBe('everyone')
    expect(aclSubjectRef({ kind: 'user', id: USER })).toBe('u:user-red')
    expect(aclSubjectRef({ kind: 'role', id: RUNNER })).toBe('r:runner')
    expect(aclSubjectRef({ kind: 'team', id: TEAM_RD })).toBe('g:team-rd')
    expect(aclSubjectRef({ kind: 'tenant', id: TENANT })).toBe('t:tenant-1')
    expect(aclSubjectFromRef('everyone')).toEqual({ kind: 'everyone' })
    expect(aclSubjectFromRef('u:user-red')).toEqual({ kind: 'user', id: USER })
    expect(aclSubjectFromRef('r:runner')).toEqual({ kind: 'role', id: RUNNER })
    expect(aclSubjectFromRef('g:team-rd')).toEqual({ kind: 'team', id: TEAM_RD })
    expect(aclSubjectFromRef('t:tenant-1')).toEqual({ kind: 'tenant', id: TENANT })
    expect(() => aclSubjectFromRef('x:nope')).toThrow(TypeError)
    expect(() => aclSubjectRef({ kind: 'ghost' } as never)).toThrow(TypeError)
    expect(() => roleId('bad role')).toThrow(TypeError)
  })

  it('rejects invalid memory-source seeds and no-ops a missing revoke', () => {
    const source = new MemoryAclPolicySource()
    const roles = new MemoryAclRoleFactSource()
    expect(() => {
      source.grant({
        resource: { type: 'bad type' as never, id: RESOURCE },
        subject: { kind: 'everyone' },
        use: [],
        delegate: [],
      })
    }).toThrow(TypeError)
    expect(() => {
      source.grant({
        resource: { type: TYPE, id: 'bad id *' as never },
        subject: { kind: 'everyone' },
        use: [],
        delegate: [],
      })
    }).toThrow(TypeError)
    expect(() => {
      source.grant({
        resource: { type: TYPE, id: RESOURCE },
        subject: { kind: 'role', id: 'bad role' as never },
        use: [],
        delegate: [],
      })
    }).toThrow(TypeError)
    expect(() => {
      source.grant({
        resource: { type: TYPE, id: RESOURCE },
        subject: { kind: 'everyone' },
        use: ['bad action' as never],
        delegate: [],
      })
    }).toThrow(TypeError)
    expect(() => {
      source.revoke({ type: TYPE, id: RESOURCE }, { kind: 'team', id: 'bad id *' as never })
    }).toThrow(TypeError)
    expect(() => {
      source.revoke({ type: TYPE, id: RESOURCE }, { kind: 'team', id: TEAM_RD })
    }).not.toThrow()
    expect(() => {
      roles.assign({ userId: 'bad id' as never, tenantId: TENANT, teamId: TEAM_RD }, RUNNER)
    }).toThrow(TypeError)
    expect(() => {
      roles.revoke({ userId: USER, tenantId: TENANT, teamId: TEAM_RD }, 'bad role' as never)
    }).toThrow(TypeError)
    expect(() => {
      roles.revoke({ userId: USER, tenantId: TENANT, teamId: TEAM_RD }, RUNNER)
    }).not.toThrow()
  })

  it('rejects invalid source registrations', async () => {
    const { authorityAcl } = await setupAuthorityAcl()
    expect(() => authorityAcl.registerSource({} as never)).toThrow(AuthorityAclError)
    expect(() => authorityAcl.registerRoleFacts({} as never)).toThrow(AuthorityAclError)
    expect(() => authorityAcl.registerSource({
      listGrants: async () => [],
    })).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(() => authorityAcl.registerRoleFacts({
      listRolesOnTeam: async () => [],
    })).toThrow(expect.objectContaining({ code: 'conflict' }))
  })

  it('ignores a second dispose and restores fail-closed', async () => {
    const { authorityAcl, disposeSource, disposeRoles } = await setupAuthorityAcl()
    disposeSource()
    disposeSource()
    await expect(authorityAcl.evaluate(useQuery())).rejects.toMatchObject({ code: 'provider-unavailable' })
    const source = new MemoryAclPolicySource()
    expect(() => authorityAcl.registerSource(source)).not.toThrow()
    disposeRoles()
    disposeRoles()
    source.grant({
      resource: { type: TYPE, id: RESOURCE },
      subject: { kind: 'role', id: RUNNER },
      use: [EXECUTE],
      delegate: [],
    })
    await expect(authorityAcl.evaluate(useQuery())).rejects.toMatchObject({ code: 'provider-unavailable' })
    expect(() => authorityAcl.registerRoleFacts(new MemoryAclRoleFactSource())).not.toThrow()
  })

  it('rejects malformed queries', async () => {
    const { authorityAcl } = await setupAuthorityAcl()
    await expect(authorityAcl.evaluate(null as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authorityAcl.evaluate([] as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authorityAcl.evaluate(Object.create(null) as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authorityAcl.evaluate({ set: 'use' } as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authorityAcl.evaluate({
      userId: USER,
      tenantId: TENANT,
      set: 'use',
    } as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authorityAcl.evaluate({
      ...useQuery(),
      set: 'other' as never,
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authorityAcl.evaluate({
      ...useQuery(),
      userId: 'bad id',
    } as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authorityAcl.evaluate({
      ...useQuery(),
      resource: null as never,
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authorityAcl.evaluate({
      ...useQuery(),
      resource: { type: TYPE } as never,
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authorityAcl.evaluate({
      ...useQuery(),
      resource: {
        type: 'bad type',
        id: RESOURCE,
        tenantId: TENANT,
        teamId: TEAM_RD,
        revision: 1,
      } as never,
    })).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('stops matching a team grant after kick without rewriting the grant row', async () => {
    const { authorityAcl, source, teams } = await setupAuthorityAcl()
    await expect(authorityAcl.evaluate(useQuery(TEAM_RD))).resolves.toEqual({ actions: [EXECUTE] })
    await expect(authorityAcl.evaluate(useQuery(TEAM_OPS))).resolves.toEqual({ actions: [] })
    teams.kick(TEAM_RD, USER)
    await expect(authorityAcl.evaluate(useQuery(TEAM_RD))).resolves.toEqual({ actions: [] })
    expect(await source.listGrants({ type: TYPE, id: RESOURCE })).toEqual([
      {
        resource: { type: TYPE, id: RESOURCE },
        subject: { kind: 'team', id: TEAM_RD },
        use: [EXECUTE],
        delegate: [],
      },
    ])
    expect(aclSubjectRef((await source.listGrants({ type: TYPE, id: RESOURCE }))[0]!.subject)).toBe('g:team-rd')
  })

  it('matches user, tenant, everyone, and role subjects without expanding team rows', async () => {
    const { authorityAcl, source, roles } = await setupAuthorityAcl()
    source.revoke({ type: TYPE, id: RESOURCE }, { kind: 'team', id: TEAM_RD })
    source.grant({
      resource: { type: TYPE, id: RESOURCE },
      subject: { kind: 'user', id: OTHER },
      use: [READ],
      delegate: [],
    })
    await expect(authorityAcl.evaluate(useQuery())).resolves.toEqual({ actions: [] })
    source.grant({
      resource: { type: TYPE, id: RESOURCE },
      subject: { kind: 'user', id: USER },
      use: [READ],
      delegate: [],
    })
    await expect(authorityAcl.evaluate(useQuery())).resolves.toEqual({ actions: [READ] })
    source.grant({
      resource: { type: TYPE, id: RESOURCE },
      subject: { kind: 'tenant', id: OTHER_TENANT },
      use: [EXECUTE],
      delegate: [],
    })
    await expect(authorityAcl.evaluate(useQuery())).resolves.toEqual({ actions: [READ] })
    source.grant({
      resource: { type: TYPE, id: RESOURCE },
      subject: { kind: 'tenant', id: TENANT },
      use: [EXECUTE],
      delegate: [],
    })
    await expect(authorityAcl.evaluate(useQuery())).resolves.toEqual({ actions: [READ, EXECUTE] })
    source.grant({
      resource: { type: TYPE, id: RESOURCE },
      subject: { kind: 'everyone' },
      use: [],
      delegate: [READ],
    })
    await expect(authorityAcl.evaluate(useQuery(TEAM_RD, 'delegate'))).resolves.toEqual({ actions: [READ] })
    source.grant({
      resource: { type: TYPE, id: RESOURCE },
      subject: { kind: 'role', id: RUNNER },
      use: [EXECUTE],
      delegate: [],
    })
    await expect(authorityAcl.evaluate(useQuery())).resolves.toEqual({ actions: [READ, EXECUTE] })
    roles.assign({ userId: USER, tenantId: TENANT, teamId: TEAM_OPS }, RUNNER)
    await expect(authorityAcl.evaluate(useQuery())).resolves.toEqual({ actions: [READ, EXECUTE] })
    roles.assign({ userId: USER, tenantId: TENANT, teamId: TEAM_RD }, RUNNER)
    await expect(authorityAcl.evaluate(useQuery())).resolves.toEqual({ actions: [READ, EXECUTE] })
    roles.revoke({ userId: USER, tenantId: TENANT, teamId: TEAM_RD }, RUNNER)
    await expect(authorityAcl.evaluate(useQuery())).resolves.toEqual({ actions: [READ, EXECUTE] })
  })

  it('applies live source changes without remounting', async () => {
    const { authorityAcl, source } = await setupAuthorityAcl()
    await expect(authorityAcl.evaluate(useQuery(TEAM_RD))).resolves.toEqual({ actions: [EXECUTE] })
    source.grant({
      resource: { type: TYPE, id: RESOURCE },
      subject: { kind: 'team', id: TEAM_RD },
      use: [READ],
      delegate: [EXECUTE],
    })
    await expect(authorityAcl.evaluate(useQuery(TEAM_RD))).resolves.toEqual({ actions: [READ] })
    await expect(authorityAcl.evaluate(useQuery(TEAM_RD, 'delegate'))).resolves.toEqual({ actions: [EXECUTE] })
    source.revoke({ type: TYPE, id: RESOURCE }, { kind: 'team', id: TEAM_RD })
    await expect(authorityAcl.evaluate(useQuery(TEAM_RD))).resolves.toEqual({ actions: [] })
  })

  it('skips grants for other resources and treats absent membership as no match', async () => {
    const { authorityAcl, source, teams } = await setupAuthorityAcl()
    source.grant({
      resource: { type: TYPE, id: OTHER_RESOURCE },
      subject: { kind: 'everyone' },
      use: [READ],
      delegate: [],
    })
    await expect(authorityAcl.evaluate(useQuery())).resolves.toEqual({ actions: [EXECUTE] })
    teams.rejectNext('membership-disabled')
    await expect(authorityAcl.evaluate(useQuery())).resolves.toEqual({ actions: [] })
    for (const code of [
      'team-not-found',
      'team-disabled',
      'team-deleted',
      'membership-removed',
    ] as const) {
      teams.rejectNext(code)
      await expect(authorityAcl.evaluate(useQuery())).resolves.toEqual({ actions: [] })
    }
  })

  it('fails closed when team membership lookup is unavailable', async () => {
    const { authorityAcl, teams } = await setupAuthorityAcl()
    teams.rejectNext('provider-unavailable')
    await expect(authorityAcl.evaluate(useQuery())).rejects.toMatchObject({ code: 'provider-unavailable' })
    teams.failNext(new Error('lookup failed'))
    await expect(authorityAcl.evaluate(useQuery())).rejects.toMatchObject({
      name: 'AuthorityAclError',
      code: 'provider-unavailable',
    })
  })

  it('denies through authority when the operations team lacks the object grant', async () => {
    const { ctx } = await setupAuthorityAcl()
    ctx.authority.registerAction({ action: EXECUTE, resourceType: TYPE })
    ctx.authority.registerResolver(TYPE, {
      resolve: async () => ({
        type: TYPE,
        id: RESOURCE,
        tenantId: TENANT,
        teamId: TEAM_OPS,
        revision: 1,
      }),
    })
    ctx.authority.registerRoute('role', { evaluate: async () => ({ actions: [EXECUTE] }) })
    ctx.auth.providers.register('in-process', {
      method: authenticationMethod('local-test'),
      verify: async () => ({
        principal: { kind: 'user', id: USER },
        authenticatedAt: Date.now(),
      }),
    })
    const call = await ctx.auth.authenticate({
      requestId: authenticationRequestId('request-1'),
      channel: 'in-process',
      evidence: { kind: 'in-process' },
      signal: new AbortController().signal,
    })
    await expect(ctx.authority.decide({
      call,
      action: EXECUTE,
      resource: { type: TYPE, id: RESOURCE },
    })).resolves.toEqual({ outcome: 'deny', code: 'insufficient-permission' })
  })

  it('unregisters the object route when the plugin fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(AuthenticationRuntime)
    await ctx.plugin(Authority)
    await ctx.plugin(MemoryTeamMembership)
    const fiber = ctx.plugin(AuthorityAcl)
    await fiber
    expect(ctx.get('authorityAcl')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('authorityAcl')).toBeUndefined()
    ctx.authority.registerAction({ action: EXECUTE, resourceType: TYPE })
    ctx.authority.registerResolver(TYPE, {
      resolve: async () => ({
        type: TYPE,
        id: RESOURCE,
        tenantId: TENANT,
        teamId: TEAM_OPS,
        revision: 1,
      }),
    })
    ctx.authority.registerRoute('role', { evaluate: async () => ({ actions: [EXECUTE] }) })
    ctx.auth.providers.register('in-process', {
      method: authenticationMethod('local-test'),
      verify: async () => ({
        principal: { kind: 'user', id: USER },
        authenticatedAt: Date.now(),
      }),
    })
    const call = await ctx.auth.authenticate({
      requestId: authenticationRequestId('request-2'),
      channel: 'in-process',
      evidence: { kind: 'in-process' },
      signal: new AbortController().signal,
    })
    await expect(ctx.authority.decide({
      call,
      action: EXECUTE,
      resource: { type: TYPE, id: RESOURCE },
    })).resolves.toEqual({ outcome: 'deny', code: 'missing-provider' })
  })

  it.each([
    { grants: 'nope' },
    { grants: [1] },
    { grants: [{ resource: null, subject: { kind: 'everyone' }, use: [], delegate: [] }] },
    { grants: [{ resource: { type: TYPE }, subject: { kind: 'everyone' }, use: [], delegate: [] }] },
    { grants: [{ resource: { type: 'bad type', id: RESOURCE }, subject: { kind: 'everyone' }, use: [], delegate: [] }] },
    { grants: [{ resource: { type: TYPE, id: RESOURCE }, subject: null, use: [], delegate: [] }] },
    { grants: [{ resource: { type: TYPE, id: RESOURCE }, subject: { kind: 'ghost' }, use: [], delegate: [] }] },
    { grants: [{ resource: { type: TYPE, id: RESOURCE }, subject: { kind: 'user' }, use: [], delegate: [] }] },
    { grants: [{ resource: { type: TYPE, id: RESOURCE }, subject: { kind: 'role' }, use: [], delegate: [] }] },
    { grants: [{ resource: { type: TYPE, id: RESOURCE }, subject: { kind: 'team' }, use: [], delegate: [] }] },
    { grants: [{ resource: { type: TYPE, id: RESOURCE }, subject: { kind: 'tenant' }, use: [], delegate: [] }] },
    { grants: [{ resource: { type: TYPE, id: RESOURCE }, subject: { kind: 'user', id: 'bad id' }, use: [], delegate: [] }] },
    { grants: [{ resource: { type: TYPE, id: RESOURCE }, subject: { kind: 'everyone' }, use: 'nope', delegate: [] }] },
    { grants: [{ resource: { type: TYPE, id: RESOURCE }, subject: { kind: 'everyone' }, use: [1], delegate: [] }] },
    { grants: [{ resource: { type: TYPE, id: RESOURCE }, subject: { kind: 'everyone' }, use: ['bad action'], delegate: [] }] },
    { grants: [{ resource: { type: TYPE, id: RESOURCE }, subject: { kind: 'everyone' }, use: [], delegate: 'nope' }] },
    { grants: [{ resource: { type: TYPE, id: RESOURCE }, subject: { kind: 'everyone' }, use: [], delegate: [1] }] },
    { grants: [{ resource: { type: TYPE, id: RESOURCE }, subject: { kind: 'everyone' }, use: [], delegate: ['bad action'] }] },
  ])('rejects a malformed policy-source result %#', async (fixture) => {
    const ctx = new Context()
    await ctx.plugin(AuthenticationRuntime)
    await ctx.plugin(Authority)
    await ctx.plugin(MemoryTeamMembership)
    await ctx.plugin(AuthorityAcl)
    ctx.authorityAcl.registerSource({
      listGrants: async () => fixture.grants as never,
    })
    await expect(ctx.authorityAcl.evaluate(useQuery())).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it.each([
    { roles: 'nope' },
    { roles: [1] },
    { roles: ['bad role'] },
  ])('rejects a malformed role-fact result %#', async (fixture) => {
    const ctx = new Context()
    await ctx.plugin(AuthenticationRuntime)
    await ctx.plugin(Authority)
    await ctx.plugin(MemoryTeamMembership)
    await ctx.plugin(AuthorityAcl)
    ctx.authorityAcl.registerSource({
      listGrants: async () => [{
        resource: { type: TYPE, id: RESOURCE },
        subject: { kind: 'role', id: RUNNER },
        use: [EXECUTE],
        delegate: [],
      }],
    })
    ctx.authorityAcl.registerRoleFacts({
      listRolesOnTeam: async () => fixture.roles as never,
    })
    await expect(ctx.authorityAcl.evaluate(useQuery())).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('wraps an unexpected policy-source throw and preserves error causes', async () => {
    const ctx = new Context()
    await ctx.plugin(AuthenticationRuntime)
    await ctx.plugin(Authority)
    await ctx.plugin(MemoryTeamMembership)
    await ctx.plugin(AuthorityAcl)
    ctx.authorityAcl.registerSource({
      listGrants: async () => {
        throw new Error('lookup failed')
      },
    })
    await expect(ctx.authorityAcl.evaluate(useQuery())).rejects.toMatchObject({
      name: 'AuthorityAclError',
      code: 'provider-unavailable',
    })
    const cause = new Error('cause')
    const error = new AuthorityAclError('provider-unavailable', 'safe', { cause })
    expect(error).toMatchObject({
      name: 'AuthorityAclError',
      code: 'provider-unavailable',
      message: 'safe',
      cause,
    })
  })

  it('ignores grants returned for a different resource and keeps team grants unexpanded', async () => {
    const ctx = new Context()
    await ctx.plugin(AuthenticationRuntime)
    await ctx.plugin(Authority)
    await ctx.plugin(MemoryTeamMembership)
    await ctx.plugin(AuthorityAcl)
    const teams = ctx.get('teams') as unknown as MemoryTeamMembership
    teams.add(TEAM_RD, USER)
    ctx.authorityAcl.registerSource({
      listGrants: async () => [
        {
          resource: { type: TYPE, id: OTHER_RESOURCE },
          subject: { kind: 'everyone' },
          use: [READ],
          delegate: [],
        },
        {
          resource: { type: TYPE, id: RESOURCE },
          subject: { kind: 'team', id: TEAM_RD },
          use: [EXECUTE],
          delegate: [],
        },
      ],
    })
    await expect(ctx.authorityAcl.evaluate(useQuery())).resolves.toEqual({ actions: [EXECUTE] })
  })
})
