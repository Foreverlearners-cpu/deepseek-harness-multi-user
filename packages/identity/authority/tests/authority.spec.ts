import { Context } from '@deepseek-ai/cordis'
import AuthenticationRuntime, {
  authenticationMethod,
  authenticationRequestId,
  serviceAccountId,
} from '@deepseek-ai/dsh-auth'
import { teamId } from '@deepseek-ai/dsh-team'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { describe, expect, it } from 'vitest'
import Authority, {
  AuthorityError,
  actionCode,
  resourceId,
  resourceType,
} from '../src/index.ts'
import { runAuthorityContract, setupAuthority } from './contract.ts'

const ACTION = actionCode('plugin:execute')
const TYPE = resourceType('plugin')
const RESOURCE = resourceId('plugin-100')

runAuthorityContract('memory fixtures', setupAuthority)

describe('authority validation', () => {
  it('rejects invalid ids, purposes, routes, and registrations', async () => {
    const { authority, call } = await setupAuthority()
    expect(() => actionCode('bad action')).toThrow(TypeError)
    expect(() => resourceType('bad type')).toThrow(TypeError)
    expect(() => resourceId('bad id')).toThrow(TypeError)
    await expect(authority.decide({
      call,
      action: ACTION,
      resource: { type: TYPE, id: RESOURCE },
      purpose: 'other' as never,
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authority.decide(null as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authority.decide([] as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authority.decide({
      call,
      action: ACTION,
      resource: 1 as never,
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authority.decide({
      call,
      action: 'nocolon' as never,
      resource: { type: TYPE, id: RESOURCE },
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(authority.decide(Object.create(null) as never)).rejects.toMatchObject({ code: 'invalid-input' })
    expect(() => authority.registerRoute('other' as never, { evaluate: async () => ({ actions: [] }) }))
      .toThrow(AuthorityError)
    expect(() => authority.registerRoute('role', {} as never)).toThrow(AuthorityError)
    expect(() => authority.registerResolver(TYPE, {} as never)).toThrow(AuthorityError)
  })

  it('rejects duplicate registrations and ignores a second dispose', async () => {
    const { authority } = await setupAuthority()
    const disposeAction = authority.registerAction({ action: ACTION, resourceType: TYPE })
    expect(() => authority.registerAction({ action: ACTION, resourceType: TYPE }))
      .toThrow(expect.objectContaining({ code: 'conflict' }))
    const disposeResolver = authority.registerResolver(TYPE, {
      resolve: async () => undefined,
    })
    expect(() => authority.registerResolver(TYPE, { resolve: async () => undefined }))
      .toThrow(expect.objectContaining({ code: 'conflict' }))
    const disposeRoute = authority.registerRoute('role', { evaluate: async () => ({ actions: [] }) })
    expect(() => authority.registerRoute('role', { evaluate: async () => ({ actions: [] }) }))
      .toThrow(expect.objectContaining({ code: 'conflict' }))
    disposeAction()
    disposeAction()
    disposeResolver()
    disposeResolver()
    disposeRoute()
    disposeRoute()
    expect(() => authority.registerAction({ action: ACTION, resourceType: TYPE })).not.toThrow()
  })

  it('denies when the resolver or role route is missing', async () => {
    const { authority, call } = await setupAuthority()
    const request = { call, action: ACTION, resource: { type: TYPE, id: RESOURCE } }
    authority.registerAction({ action: ACTION, resourceType: TYPE })
    authority.registerRoute('role', { evaluate: async () => ({ actions: [ACTION] }) })
    authority.registerRoute('object', { evaluate: async () => ({ actions: [ACTION] }) })
    await expect(authority.decide(request)).resolves.toEqual({ outcome: 'deny', code: 'missing-provider' })

    const { authority: missingRole, call: missingRoleCall } = await setupAuthority()
    missingRole.registerAction({ action: ACTION, resourceType: TYPE })
    missingRole.registerResolver(TYPE, {
      resolve: async () => ({
        type: TYPE,
        id: RESOURCE,
        tenantId: tenantId('tenant-1'),
        teamId: teamId('team-rd'),
        revision: 1,
      }),
    })
    missingRole.registerRoute('object', { evaluate: async () => ({ actions: [ACTION] }) })
    await expect(missingRole.decide({
      call: missingRoleCall,
      action: ACTION,
      resource: { type: TYPE, id: RESOURCE },
    })).resolves.toEqual({ outcome: 'deny', code: 'missing-provider' })
  })

  it('denies copied calls, non-user principals, and unresolved resources', async () => {
    const { authority, call } = await setupAuthority()
    authority.registerAction({ action: ACTION, resourceType: TYPE })
    authority.registerResolver(TYPE, { resolve: async () => undefined })
    authority.registerRoute('role', { evaluate: async () => ({ actions: [ACTION] }) })
    authority.registerRoute('object', { evaluate: async () => ({ actions: [ACTION] }) })

    await expect(authority.decide({
      call: { ...call },
      action: ACTION,
      resource: { type: TYPE, id: RESOURCE },
    })).resolves.toEqual({ outcome: 'deny', code: 'unauthenticated' })
    await expect(authority.decide({
      call,
      action: ACTION,
      resource: { type: TYPE, id: RESOURCE },
    })).resolves.toEqual({ outcome: 'deny', code: 'unresolved-resource' })

    const ctx = new Context()
    await ctx.plugin(AuthenticationRuntime)
    await ctx.plugin(Authority)
    ctx.auth.providers.register('in-process', {
      method: authenticationMethod('service-test'),
      verify: async () => ({
        principal: { kind: 'service-account', id: serviceAccountId('svc-1') },
        authenticatedAt: Date.now(),
      }),
    })
    const serviceCall = await ctx.auth.authenticate({
      requestId: authenticationRequestId('request-svc'),
      channel: 'in-process',
      evidence: { kind: 'in-process' },
      signal: new AbortController().signal,
    })
    ctx.authority.registerAction({ action: ACTION, resourceType: TYPE })
    ctx.authority.registerResolver(TYPE, {
      resolve: async () => ({
        type: TYPE,
        id: RESOURCE,
        tenantId: tenantId('tenant-1'),
        teamId: teamId('team-rd'),
        revision: 1,
      }),
    })
    ctx.authority.registerRoute('role', { evaluate: async () => ({ actions: [ACTION] }) })
    ctx.authority.registerRoute('object', { evaluate: async () => ({ actions: [ACTION] }) })
    await expect(ctx.authority.decide({
      call: serviceCall,
      action: ACTION,
      resource: { type: TYPE, id: RESOURCE },
    })).resolves.toEqual({ outcome: 'deny', code: 'insufficient-permission' })
  })

  it('ignores client-claimed tenant and team fields on the resource pointer', async () => {
    const { authority, call } = await setupAuthority()
    authority.registerAction({ action: ACTION, resourceType: TYPE })
    authority.registerResolver(TYPE, {
      resolve: async ref => ({
        type: ref.type,
        id: resourceId(ref.id),
        tenantId: tenantId('tenant-1'),
        teamId: teamId('team-ops'),
        revision: 1,
      }),
    })
    authority.registerRoute('role', {
      evaluate: async query => ({
        actions: query.teamId === teamId('team-rd') ? [ACTION] : [],
      }),
    })
    authority.registerRoute('object', {
      evaluate: async query => ({
        actions: query.teamId === teamId('team-ops') ? [ACTION] : [],
      }),
    })

    await expect(authority.decide({
      call,
      action: ACTION,
      resource: {
        type: TYPE,
        id: RESOURCE,
        tenantId: tenantId('tenant-1'),
        teamId: teamId('team-rd'),
      } as never,
    })).resolves.toEqual({ outcome: 'deny', code: 'insufficient-permission' })
  })

  it('denies a resolver or route Provider that returns malformed data or throws', async () => {
    const { authority, call } = await setupAuthority()
    authority.registerAction({ action: ACTION, resourceType: TYPE })
    const request = { call, action: ACTION, resource: { type: TYPE, id: RESOURCE } }

    authority.registerResolver(TYPE, {
      resolve: async () => ({
        type: TYPE,
        id: resourceId('other'),
        tenantId: tenantId('tenant-1'),
        teamId: teamId('team-rd'),
        revision: 1,
      }),
    })
    authority.registerRoute('role', { evaluate: async () => ({ actions: [ACTION] }) })
    authority.registerRoute('object', { evaluate: async () => ({ actions: [ACTION] }) })
    await expect(authority.decide(request)).resolves.toEqual({ outcome: 'deny', code: 'provider-unavailable' })

    const { authority: broken, call: brokenCall } = await setupAuthority()
    broken.registerAction({ action: ACTION, resourceType: TYPE })
    broken.registerResolver(TYPE, { resolve: async () => { throw new Error('lookup failed') } })
    broken.registerRoute('role', { evaluate: async () => ({ actions: [ACTION] }) })
    broken.registerRoute('object', { evaluate: async () => ({ actions: [ACTION] }) })
    await expect(broken.decide({
      call: brokenCall,
      action: ACTION,
      resource: { type: TYPE, id: RESOURCE },
    })).resolves.toEqual({ outcome: 'deny', code: 'provider-unavailable' })
  })

  it.each([
    null,
    {},
    Object.create(null),
    { type: TYPE, id: RESOURCE, tenantId: tenantId('tenant-1'), teamId: teamId('team-rd') },
    {
      type: TYPE,
      id: RESOURCE,
      tenantId: 'bad id',
      teamId: teamId('team-rd'),
      revision: 1,
    },
    {
      type: TYPE,
      id: RESOURCE,
      tenantId: tenantId('tenant-1'),
      teamId: teamId('team-rd'),
      revision: 0,
    },
  ])('denies a malformed resolver record %#', async (resolved) => {
    const { authority, call } = await setupAuthority()
    authority.registerAction({ action: ACTION, resourceType: TYPE })
    authority.registerResolver(TYPE, { resolve: async () => resolved as never })
    authority.registerRoute('role', { evaluate: async () => ({ actions: [ACTION] }) })
    authority.registerRoute('object', { evaluate: async () => ({ actions: [ACTION] }) })
    await expect(authority.decide({
      call,
      action: ACTION,
      resource: { type: TYPE, id: RESOURCE },
    })).resolves.toEqual({ outcome: 'deny', code: 'provider-unavailable' })
  })

  it.each([
    null,
    {},
    Object.create(null),
    { actions: 'nope' },
    { actions: [1] },
    { actions: ['bad action'] },
  ])('denies a malformed route result %#', async (result) => {
    const { authority, call } = await setupAuthority()
    authority.registerAction({ action: ACTION, resourceType: TYPE })
    authority.registerResolver(TYPE, {
      resolve: async () => ({
        type: TYPE,
        id: RESOURCE,
        tenantId: tenantId('tenant-1'),
        teamId: teamId('team-rd'),
        revision: 1,
      }),
    })
    authority.registerRoute('role', { evaluate: async () => result as never })
    authority.registerRoute('object', { evaluate: async () => ({ actions: [ACTION] }) })
    await expect(authority.decide({
      call,
      action: ACTION,
      resource: { type: TYPE, id: RESOURCE },
    })).resolves.toEqual({ outcome: 'deny', code: 'provider-unavailable' })
  })

  it('denies an action registered for a different resource class', async () => {
    const { authority, call } = await setupAuthority()
    authority.registerAction({ action: ACTION, resourceType: resourceType('conversation') })
    authority.registerResolver(TYPE, {
      resolve: async () => ({
        type: TYPE,
        id: RESOURCE,
        tenantId: tenantId('tenant-1'),
        teamId: teamId('team-rd'),
        revision: 1,
      }),
    })
    authority.registerRoute('role', { evaluate: async () => ({ actions: [ACTION] }) })
    authority.registerRoute('object', { evaluate: async () => ({ actions: [ACTION] }) })
    await expect(authority.decide({
      call,
      action: ACTION,
      resource: { type: TYPE, id: RESOURCE },
    })).resolves.toEqual({ outcome: 'deny', code: 'unknown-action' })
  })

  it('makes require throw the deny category and preserves error causes', async () => {
    const { authority, call } = await setupAuthority()
    await expect(authority.require({
      call,
      action: ACTION,
      resource: { type: TYPE, id: RESOURCE },
    })).rejects.toMatchObject({ name: 'AuthorityError', code: 'unknown-action' })
    const cause = new Error('cause')
    const error = new AuthorityError('provider-unavailable', 'safe', { cause })
    expect(error).toMatchObject({ name: 'AuthorityError', code: 'provider-unavailable', message: 'safe', cause })
  })

  it('removes the authority service when the Provider fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(AuthenticationRuntime)
    const fiber = ctx.plugin(Authority)
    await fiber
    expect(ctx.get('authority')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('authority')).toBeUndefined()
  })
})
