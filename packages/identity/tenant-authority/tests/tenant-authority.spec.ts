import { Context } from '@deepseek-ai/cordis'
import AuthenticationRuntime, {
  authenticationMethod,
  authenticationRequestId,
  serviceAccountId,
} from '@deepseek-ai/dsh-auth'
import Authority, { actionCode, resourceId, resourceType } from '@deepseek-ai/dsh-authority'
import { describe, expect, it } from 'vitest'
import TenantAuthority, { TenantAuthorityError } from '../src/index.ts'
import {
  EXECUTE,
  RESOURCE,
  TENANT,
  TYPE,
  USER,
  resource,
  runTenantAuthorityContract,
  setupTenantAuthority,
} from './contract.ts'
import { MemoryTenantMembership } from './tenants-stub.ts'

const READ = actionCode('plugin:read')

runTenantAuthorityContract('memory membership', async () => {
  const { tenantAuthority } = await setupTenantAuthority()
  return { match: query => tenantAuthority.match(query) }
})

async function authenticate(ctx: Context, user = USER) {
  ctx.auth.providers.register('in-process', {
    method: authenticationMethod('local-test'),
    verify: async () => ({
      principal: { kind: 'user', id: user },
      authenticatedAt: Date.now(),
    }),
  })
  return ctx.auth.authenticate({
    requestId: authenticationRequestId('request-1'),
    channel: 'in-process',
    evidence: { kind: 'in-process' },
    signal: new AbortController().signal,
  })
}

function tenantRequest(call: Awaited<ReturnType<typeof authenticate>>, id: string = RESOURCE, owner = TENANT) {
  return {
    call,
    action: EXECUTE,
    resource: { type: TYPE, id },
    scope: { kind: 'tenant' as const, tenantId: owner },
  }
}

describe('tenant-authority validation', () => {
  it('rejects invalid resolver registrations', async () => {
    const { tenantAuthority } = await setupTenantAuthority()
    expect(() => tenantAuthority.registerResolver(TYPE, {} as never)).toThrow(TenantAuthorityError)
    expect(() => tenantAuthority.registerResolver(TYPE, {
      resolve: async () => undefined,
    })).toThrow(expect.objectContaining({ code: 'conflict' }))
  })

  it('rejects malformed match queries', async () => {
    const { tenantAuthority } = await setupTenantAuthority()
    await expect(tenantAuthority.match(null as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenantAuthority.match([] as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenantAuthority.match({
      userId: USER,
      resourceTenantId: TENANT,
    } as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenantAuthority.match({
      userId: USER,
      scope: { kind: 'tenant' },
      resourceTenantId: TENANT,
    } as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenantAuthority.match({
      userId: 'bad id',
      scope: { kind: 'tenant', tenantId: TENANT },
      resourceTenantId: TENANT,
    } as never)).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('rejects malformed decide requests', async () => {
    const { ctx, tenantAuthority } = await setupTenantAuthority()
    const call = await authenticate(ctx)
    await expect(tenantAuthority.decide(null as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenantAuthority.decide([] as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenantAuthority.decide(Object.create(null) as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenantAuthority.decide({
      ...tenantRequest(call),
      scope: { kind: 'ghost' },
    } as never)).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenantAuthority.decide({
      ...tenantRequest(call),
      action: 'bad action' as never,
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenantAuthority.decide({
      ...tenantRequest(call),
      resource: { type: TYPE } as never,
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenantAuthority.decide({
      ...tenantRequest(call),
      resource: { type: 'bad type', id: RESOURCE } as never,
    })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(tenantAuthority.decide({
      ...tenantRequest(call),
      resource: { type: TYPE, id: 'bad id *' },
    })).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('allows same-tenant decide and hides a valid cross-tenant id', async () => {
    const { ctx, tenantAuthority } = await setupTenantAuthority()
    const call = await authenticate(ctx)
    const allowed = await tenantAuthority.decide(tenantRequest(call))
    expect(allowed).toEqual({ outcome: 'allow', resource: resource(TENANT) })
    await expect(tenantAuthority.decide(tenantRequest(call, 'plugin-other'))).resolves.toEqual({
      outcome: 'deny',
      code: 'unresolved-resource',
    })
    await expect(tenantAuthority.decide(tenantRequest(call, 'missing'))).resolves.toEqual({
      outcome: 'deny',
      code: 'unresolved-resource',
    })
    await expect(tenantAuthority.require(tenantRequest(call))).resolves.toEqual(resource(TENANT))
    await expect(tenantAuthority.require(tenantRequest(call, 'plugin-other'))).rejects.toMatchObject({
      name: 'TenantAuthorityError',
      code: 'unresolved-resource',
    })
  })

  it('does not treat platform scope as tenant permission', async () => {
    const { ctx, tenantAuthority } = await setupTenantAuthority()
    const call = await authenticate(ctx)
    await expect(tenantAuthority.decide({
      ...tenantRequest(call),
      scope: { kind: 'platform' },
    })).resolves.toEqual({ outcome: 'deny', code: 'unresolved-resource' })
  })

  it('hides a resource after the user is kicked from the claimed tenant', async () => {
    const { ctx, tenantAuthority, tenants } = await setupTenantAuthority()
    const call = await authenticate(ctx)
    tenants.kick(TENANT, USER)
    await expect(tenantAuthority.decide(tenantRequest(call))).resolves.toEqual({
      outcome: 'deny',
      code: 'unresolved-resource',
    })
  })

  it('treats absent membership codes as unresolved and unexpected lookup as unavailable', async () => {
    const { ctx, tenantAuthority, tenants } = await setupTenantAuthority()
    const call = await authenticate(ctx)
    for (const code of [
      'tenant-not-found',
      'tenant-disabled',
      'tenant-deleted',
      'membership-disabled',
      'membership-removed',
    ] as const) {
      tenants.rejectNext(code)
      await expect(tenantAuthority.decide(tenantRequest(call))).resolves.toEqual({
        outcome: 'deny',
        code: 'unresolved-resource',
      })
    }
    tenants.failNext(new Error('lookup failed'))
    await expect(tenantAuthority.decide(tenantRequest(call))).resolves.toEqual({
      outcome: 'deny',
      code: 'provider-unavailable',
    })
    tenants.rejectNext('provider-unavailable')
    await expect(tenantAuthority.match({
      userId: USER,
      scope: { kind: 'tenant', tenantId: TENANT },
      resourceTenantId: TENANT,
    })).resolves.toEqual({ outcome: 'deny', code: 'provider-unavailable' })
  })

  it('fails closed when the resolver is missing or returns invalid data', async () => {
    const { ctx, tenantAuthority } = await setupTenantAuthority()
    const call = await authenticate(ctx)
    const dispose = tenantAuthority.registerResolver(resourceType('doc'), {
      resolve: async () => ({
        type: resourceType('doc'),
        id: resourceId('doc-1'),
        tenantId: TENANT,
        teamId: resource(TENANT).teamId,
        revision: 0,
      }),
    })
    await expect(tenantAuthority.decide({
      ...tenantRequest(call),
      resource: { type: resourceType('doc'), id: 'doc-1' },
    })).resolves.toEqual({ outcome: 'deny', code: 'provider-unavailable' })
    dispose()
    dispose()
    await expect(tenantAuthority.decide({
      ...tenantRequest(call),
      resource: { type: resourceType('doc'), id: 'doc-1' },
    })).resolves.toEqual({ outcome: 'deny', code: 'missing-provider' })
    const other = resourceType('sheet')
    tenantAuthority.registerResolver(other, {
      resolve: async () => ({
        type: TYPE,
        id: RESOURCE,
        tenantId: TENANT,
        teamId: resource(TENANT).teamId,
        revision: 1,
      }),
    })
    await expect(tenantAuthority.decide({
      ...tenantRequest(call),
      resource: { type: other, id: 'sheet-1' },
    })).resolves.toEqual({ outcome: 'deny', code: 'provider-unavailable' })
    tenantAuthority.registerResolver(resourceType('blank'), {
      resolve: async () => null as never,
    })
    await expect(tenantAuthority.decide({
      ...tenantRequest(call),
      resource: { type: resourceType('blank'), id: 'blank-1' },
    })).resolves.toEqual({ outcome: 'deny', code: 'provider-unavailable' })
    tenantAuthority.registerResolver(resourceType('note'), {
      resolve: async () => {
        throw new Error('lookup failed')
      },
    })
    await expect(tenantAuthority.decide({
      ...tenantRequest(call),
      resource: { type: resourceType('note'), id: 'note-1' },
    })).resolves.toEqual({ outcome: 'deny', code: 'provider-unavailable' })
  })

  it('passes purpose through to authority after the tenant check', async () => {
    const { ctx, tenantAuthority } = await setupTenantAuthority()
    const call = await authenticate(ctx)
    ctx.authority.registerAction({ action: READ, resourceType: TYPE })
    await expect(tenantAuthority.decide({
      ...tenantRequest(call),
      action: READ,
      purpose: 'delegate',
    })).resolves.toEqual({ outcome: 'deny', code: 'insufficient-permission' })
  })

  it('hides a non-user principal the same way as a missing resource', async () => {
    const { ctx, tenantAuthority } = await setupTenantAuthority()
    ctx.auth.providers.register('in-process', {
      method: authenticationMethod('local-service'),
      verify: async () => ({
        principal: { kind: 'service-account', id: serviceAccountId('svc-1') },
        authenticatedAt: Date.now(),
      }),
    })
    const call = await ctx.auth.authenticate({
      requestId: authenticationRequestId('request-svc'),
      channel: 'in-process',
      evidence: { kind: 'in-process' },
      signal: new AbortController().signal,
    })
    await expect(tenantAuthority.decide(tenantRequest(call as never))).resolves.toEqual({
      outcome: 'deny',
      code: 'unresolved-resource',
    })
  })

  it('unregisters resolvers when the plugin fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(AuthenticationRuntime)
    await ctx.plugin(Authority)
    await ctx.plugin(MemoryTenantMembership)
    const fiber = ctx.plugin(TenantAuthority)
    await fiber
    expect(ctx.get('tenantAuthority')).toBeDefined()
    ctx.tenantAuthority.registerResolver(TYPE, {
      resolve: async () => undefined,
    })
    await fiber.dispose()
    expect(ctx.get('tenantAuthority')).toBeUndefined()
  })

  it('denies an unauthenticated call without leaking resource existence', async () => {
    const { tenantAuthority } = await setupTenantAuthority()
    await expect(tenantAuthority.decide(tenantRequest({} as never))).resolves.toEqual({
      outcome: 'deny',
      code: 'unauthenticated',
    })
  })

  it('preserves error causes', () => {
    const cause = new Error('cause')
    const error = new TenantAuthorityError('provider-unavailable', 'safe', { cause })
    expect(error).toMatchObject({
      name: 'TenantAuthorityError',
      code: 'provider-unavailable',
      message: 'safe',
      cause,
    })
  })
})
