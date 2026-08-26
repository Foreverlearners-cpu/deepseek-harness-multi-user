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
import AuthRbac, { AuthRbacError, MemoryRbacPolicySource, roleId } from '../src/index.ts'
import { runAuthRbacContract, setupAuthRbac } from './contract.ts'

const USER = userId('user-red')
const TENANT = tenantId('tenant-1')
const TEAM_RD = teamId('team-rd')
const TEAM_OPS = teamId('team-ops')
const RUNNER = roleId('runner')
const READ = actionCode('plugin:read')
const EXECUTE = actionCode('plugin:execute')
const TYPE = resourceType('plugin')
const RESOURCE = resourceId('plugin-100')

runAuthRbacContract('memory source', async () => {
  const { authRbac } = await setupAuthRbac()
  return { evaluate: query => authRbac.evaluate(query) }
})

describe('auth-rbac validation', () => {
  it('rejects invalid memory-source seeds and no-ops a missing revoke', () => {
    const source = new MemoryRbacPolicySource()
    expect(() => {
      source.putRole({ roleId: 'bad role' as never, use: [], delegate: [] })
    }).toThrow(TypeError)
    expect(() => {
      source.putRole({ roleId: RUNNER, use: ['bad action' as never], delegate: [] })
    }).toThrow(TypeError)
    expect(() => {
      source.assign({
        userId: 'bad id' as never,
        tenantId: TENANT,
        teamId: TEAM_OPS,
        roleId: RUNNER,
      })
    }).toThrow(TypeError)
    expect(() => {
      source.revoke({
        userId: USER,
        tenantId: TENANT,
        teamId: TEAM_OPS,
        roleId: 'bad role' as never,
      })
    }).toThrow(TypeError)
    expect(() => {
      source.revoke({
        userId: USER,
        tenantId: TENANT,
        teamId: TEAM_OPS,
        roleId: RUNNER,
      })
    }).not.toThrow()
  })

  it('rejects invalid role ids and source registrations', async () => {
    const { authRbac } = await setupAuthRbac()
    expect(() => roleId('bad role')).toThrow(TypeError)
    expect(() => authRbac.registerSource({} as never)).toThrow(AuthRbacError)
    expect(() => authRbac.registerSource({
      listPrincipalRoles: async () => [],
    } as never)).toThrow(AuthRbacError)
    await expect(authRbac.evaluate({
      set: 'use',
    } as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authRbac.evaluate({
      userId: USER,
      tenantId: TENANT,
      set: 'use',
    } as never)).rejects.toMatchObject({ code: 'invalid-input' })
    expect(() => authRbac.registerSource({
      listPrincipalRoles: async () => [],
      listRoleActions: async () => ({ use: [], delegate: [] }),
    })).toThrow(expect.objectContaining({ code: 'conflict' }))
  })

  it('ignores a second source dispose and restores fail-closed', async () => {
    const { authRbac, disposeSource } = await setupAuthRbac()
    disposeSource()
    disposeSource()
    await expect(authRbac.evaluate({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_OPS,
      action: EXECUTE,
      resource: {
        type: TYPE,
        id: RESOURCE,
        tenantId: TENANT,
        teamId: TEAM_OPS,
        revision: 1,
      },
      set: 'use',
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
    const source = new MemoryRbacPolicySource()
    expect(() => authRbac.registerSource(source)).not.toThrow()
  })

  it('rejects malformed queries', async () => {
    const { authRbac } = await setupAuthRbac()
    await expect(authRbac.evaluate(null as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authRbac.evaluate([] as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authRbac.evaluate(Object.create(null) as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authRbac.evaluate({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_OPS,
      action: EXECUTE,
      resource: {
        type: TYPE,
        id: RESOURCE,
        tenantId: TENANT,
        teamId: TEAM_OPS,
        revision: 1,
      },
      set: 'other' as never,
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authRbac.evaluate({
      userId: 'bad id',
      tenantId: TENANT,
      teamId: TEAM_OPS,
      action: EXECUTE,
      resource: {
        type: TYPE,
        id: RESOURCE,
        tenantId: TENANT,
        teamId: TEAM_OPS,
        revision: 1,
      },
      set: 'use',
    } as never)).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('applies live source changes without remounting', async () => {
    const { authRbac, source } = await setupAuthRbac()
    const ops = {
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_OPS,
      action: EXECUTE,
      resource: {
        type: TYPE,
        id: RESOURCE,
        tenantId: TENANT,
        teamId: TEAM_OPS,
        revision: 1,
      },
      set: 'use' as const,
    }
    await expect(authRbac.evaluate(ops)).resolves.toEqual({ actions: [READ] })
    source.assign({ userId: USER, tenantId: TENANT, teamId: TEAM_OPS, roleId: RUNNER })
    await expect(authRbac.evaluate(ops)).resolves.toEqual({ actions: [READ, EXECUTE] })
    source.revoke({ userId: USER, tenantId: TENANT, teamId: TEAM_OPS, roleId: RUNNER })
    await expect(authRbac.evaluate(ops)).resolves.toEqual({ actions: [READ] })
    source.putRole({
      roleId: RUNNER,
      use: [READ],
      delegate: [EXECUTE],
    })
    await expect(authRbac.evaluate({ ...ops, teamId: TEAM_RD, resource: {
      type: TYPE,
      id: RESOURCE,
      tenantId: TENANT,
      teamId: TEAM_RD,
      revision: 1,
    } })).resolves.toEqual({ actions: [READ] })
    await expect(authRbac.evaluate({
      ...ops,
      teamId: TEAM_RD,
      set: 'delegate',
      resource: {
        type: TYPE,
        id: RESOURCE,
        tenantId: TENANT,
        teamId: TEAM_RD,
        revision: 1,
      },
    })).resolves.toEqual({ actions: [EXECUTE] })
  })

  it('denies through authority when the operations team lacks execute on the role route', async () => {
    const { ctx } = await setupAuthRbac()
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
    ctx.authority.registerRoute('object', { evaluate: async () => ({ actions: [EXECUTE] }) })
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

  it('unregisters the role route when the plugin fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(AuthenticationRuntime)
    await ctx.plugin(Authority)
    const fiber = ctx.plugin(AuthRbac)
    await fiber
    expect(ctx.get('authRbac')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('authRbac')).toBeUndefined()
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
    ctx.authority.registerRoute('object', { evaluate: async () => ({ actions: [EXECUTE] }) })
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
    { roles: 'nope', actions: { use: [READ], delegate: [] } },
    { roles: [1], actions: { use: [READ], delegate: [] } },
    { roles: ['bad role'], actions: { use: [READ], delegate: [] } },
    { roles: [RUNNER], actions: null },
    { roles: [RUNNER], actions: { use: 'nope', delegate: [] } },
    { roles: [RUNNER], actions: { use: [1], delegate: [] } },
    { roles: [RUNNER], actions: { use: ['bad action'], delegate: [] } },
    { roles: [RUNNER], actions: { use: [READ], delegate: 'nope' } },
    { roles: [RUNNER], actions: { use: [READ], delegate: [1] } },
    { roles: [RUNNER], actions: { use: [READ], delegate: ['bad action'] } },
    { roles: [RUNNER], actions: Object.create(null) as Record<string, never> },
  ])('rejects a malformed policy-source result %#', async (fixture) => {
    const ctx = new Context()
    await ctx.plugin(AuthenticationRuntime)
    await ctx.plugin(Authority)
    await ctx.plugin(AuthRbac)
    ctx.authRbac.registerSource({
      listPrincipalRoles: async () => fixture.roles as never,
      listRoleActions: async () => fixture.actions as never,
    })
    await expect(ctx.authRbac.evaluate({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_OPS,
      action: EXECUTE,
      resource: {
        type: TYPE,
        id: RESOURCE,
        tenantId: TENANT,
        teamId: TEAM_OPS,
        revision: 1,
      },
      set: 'use',
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('wraps an unexpected policy-source throw and preserves error causes', async () => {
    const ctx = new Context()
    await ctx.plugin(AuthenticationRuntime)
    await ctx.plugin(Authority)
    await ctx.plugin(AuthRbac)
    ctx.authRbac.registerSource({
      listPrincipalRoles: async () => {
        throw new Error('lookup failed')
      },
      listRoleActions: async () => ({ use: [], delegate: [] }),
    })
    await expect(ctx.authRbac.evaluate({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_OPS,
      action: EXECUTE,
      resource: {
        type: TYPE,
        id: RESOURCE,
        tenantId: TENANT,
        teamId: TEAM_OPS,
        revision: 1,
      },
      set: 'use',
    })).rejects.toMatchObject({ name: 'AuthRbacError', code: 'provider-unavailable' })
    const cause = new Error('cause')
    const error = new AuthRbacError('provider-unavailable', 'safe', { cause })
    expect(error).toMatchObject({ name: 'AuthRbacError', code: 'provider-unavailable', message: 'safe', cause })
  })

  it('rejects an unknown bound role and ignores other-tenant bindings', async () => {
    const { authRbac, source } = await setupAuthRbac()
    source.assign({
      userId: USER,
      tenantId: tenantId('tenant-2'),
      teamId: TEAM_OPS,
      roleId: RUNNER,
    })
    await expect(authRbac.evaluate({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_OPS,
      action: EXECUTE,
      resource: {
        type: TYPE,
        id: RESOURCE,
        tenantId: TENANT,
        teamId: TEAM_OPS,
        revision: 1,
      },
      set: 'use',
    })).resolves.toEqual({ actions: [READ] })
    source.assign({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_OPS,
      roleId: roleId('ghost'),
    })
    await expect(authRbac.evaluate({
      userId: USER,
      tenantId: TENANT,
      teamId: TEAM_OPS,
      action: EXECUTE,
      resource: {
        type: TYPE,
        id: RESOURCE,
        tenantId: TENANT,
        teamId: TEAM_OPS,
        revision: 1,
      },
      set: 'use',
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })
})
