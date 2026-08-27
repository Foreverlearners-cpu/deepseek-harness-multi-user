import { Context } from '@deepseek-ai/cordis'
import AuthenticationRuntime, {
  authenticationMethod,
  authenticationRequestId,
} from '@deepseek-ai/dsh-auth'
import AuthRbac, { MemoryRbacPolicySource } from '@deepseek-ai/dsh-auth-rbac'
import AuthRbacMysql from '@deepseek-ai/dsh-auth-rbac-mysql'
import Authority, { actionCode, resourceType } from '@deepseek-ai/dsh-authority'
import AuthorityAcl, { MemoryAclPolicySource } from '@deepseek-ai/dsh-authority-acl'
import AuthorityAclMysql from '@deepseek-ai/dsh-authority-acl-mysql'
import TeamMysqlDirectory from '@deepseek-ai/dsh-team-mysql'
import TenantAuthority from '@deepseek-ai/dsh-tenant-authority'
import TenantMysqlDirectory from '@deepseek-ai/dsh-tenant-mysql'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import { afterEach, describe, expect, it } from 'vitest'
import AccountAuthority from '@deepseek-ai/dsh-account-authority'
import * as FullStarter from '../src/index.ts'
import * as MinimalStarter from '../src/minimal.ts'
import {
  AUTHORITY_CONSUMER_PLUGINS,
  AUTHORITY_MYSQL_PLUGINS,
  AUTHORITY_PROVIDER_READINESS,
  assertAuthorityAssembly,
  prepareAuthorityAssembly,
} from '../src/assembly.ts'
import { MemoryTeamDirectory } from '../../team/tests/memory.ts'
import { MemoryTenantDirectory } from '../../tenant/tests/memory.ts'
import { AccountAdministrationStub } from './account-admin-stub.ts'

const USER = userId('user-red')
const TENANT = tenantId('tenant-1')
const EXECUTE = actionCode('plugin:execute')
const TYPE = resourceType('plugin')

const roots: Context[] = []
afterEach(async () => {
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
})

async function provideMemoryAuthority(ctx: Context, ready = true): Promise<void> {
  await ctx.plugin(AuthenticationRuntime)
  await ctx.plugin(AccountAdministrationStub)
  await ctx.plugin(MemoryTenantDirectory)
  await ctx.plugin(MemoryTeamDirectory)
  await ctx.plugin(Authority)
  await ctx.plugin(AuthRbac)
  await ctx.plugin(AuthorityAcl)
  ctx.authRbac.registerSource(new MemoryRbacPolicySource())
  ctx.authorityAcl.registerSource(new MemoryAclPolicySource())
  ctx.auth.providers.register('in-process', {
    method: authenticationMethod('local-test'),
    verify: async () => ({
      principal: { kind: 'user', id: USER },
      authenticatedAt: Date.now(),
    }),
  })
  if (ready) ctx.provide(AUTHORITY_PROVIDER_READINESS, true)
}

async function authenticate(ctx: Context) {
  return ctx.auth.authenticate({
    requestId: authenticationRequestId('request-1'),
    channel: 'in-process',
    evidence: { kind: 'in-process' },
    signal: new AbortController().signal,
  })
}

describe('authority starter composition', () => {
  it('orders the complete MySQL suite without owning policy', async () => {
    const mounted: unknown[] = []
    const services = new Map<string, unknown>([
      ['mysql', {}],
      ['auth', {}],
      ['accountAdministration', {}],
    ])
    const fake = {
      get: (name: string) => services.get(name),
      plugin: (plugin: unknown) => {
        mounted.push(plugin)
        if (plugin === TenantMysqlDirectory) services.set('tenants', {})
        else if (plugin === TeamMysqlDirectory) services.set('teams', {})
        else if (plugin === Authority) services.set('authority', {})
        else if (plugin === AuthRbac) services.set('authRbac', {})
        else if (plugin === AuthRbacMysql) services.set('authRbacMysql', {})
        else if (plugin === AuthorityAcl) services.set('authorityAcl', {})
        else if (plugin === AuthorityAclMysql) services.set('authorityAclMysql', {})
        else if (plugin === TenantAuthority) services.set('tenantAuthority', {})
        else if (plugin === AccountAuthority) services.set('accountAuthority', {})
        return Promise.resolve()
      },
    } as unknown as Context
    await FullStarter.apply(fake)
    expect(mounted).toEqual([...AUTHORITY_MYSQL_PLUGINS, ...AUTHORITY_CONSUMER_PLUGINS])
  })

  it('fails closed for missing storage, conflicts, and incomplete assembly', async () => {
    const empty = new Context()
    expect(() => { prepareAuthorityAssembly(empty, 'full') }).toThrow(/mysql/)
    expect(() => { prepareAuthorityAssembly(empty, 'minimal') }).toThrow(/auth/)
    expect(() => { assertAuthorityAssembly(empty, 'full') }).toThrow(/tenants/)
    expect(() => { assertAuthorityAssembly(empty, 'minimal') }).toThrow(/tenantAuthority/)

    const occupied = {
      get: (name: string) => name === 'tenants' || name === 'mysql' || name === 'auth' || name === 'accountAdministration'
        ? {}
        : undefined,
    } as unknown as Context
    expect(() => { prepareAuthorityAssembly(occupied, 'full') }).toThrow(/already active/)

    const consumerOccupied = {
      get: (name: string) => (
        name === 'tenantAuthority'
        || name === 'auth'
        || name === 'accountAdministration'
        || name === 'tenants'
        || name === 'teams'
        || name === 'authority'
        || name === 'authRbac'
        || name === 'authorityAcl'
        || name === AUTHORITY_PROVIDER_READINESS
          ? {}
          : undefined
      ),
    } as unknown as Context
    expect(() => { prepareAuthorityAssembly(consumerOccupied, 'minimal') }).toThrow(/already active/)
  })

  it('mounts consumers only after injected routes exist', async () => {
    const services = new Map<string, unknown>([
      ['auth', {}],
      ['accountAdministration', {}],
      ['tenants', {}],
      ['teams', {}],
      ['authority', {}],
      ['authRbac', {}],
      ['authorityAcl', {}],
      [AUTHORITY_PROVIDER_READINESS, true],
    ])
    const mounted: unknown[] = []
    const fake = {
      get: (name: string) => services.get(name),
      plugin: (plugin: unknown) => {
        mounted.push(plugin)
        if (plugin === TenantAuthority) services.set('tenantAuthority', {})
        if (plugin === AccountAuthority) services.set('accountAuthority', {})
        return Promise.resolve()
      },
    } as unknown as Context
    await MinimalStarter.apply(fake)
    expect(mounted).toEqual([...AUTHORITY_CONSUMER_PLUGINS])
  })

  it('boots memory Providers and fails decide and administration closed', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await provideMemoryAuthority(ctx)
    const fiber = ctx.plugin(MinimalStarter)
    await fiber
    const call = await authenticate(ctx)
    await expect(ctx.tenantAuthority.decide({
      call,
      action: EXECUTE,
      resource: { type: TYPE, id: 'plugin-1' },
      scope: { kind: 'tenant', tenantId: TENANT },
    })).resolves.toEqual({ outcome: 'deny', code: 'missing-provider' })
    await expect(ctx.accountAdministration.authorizers.authorize(call, 'disable', USER))
      .rejects.toMatchObject({ code: 'forbidden' })
    await fiber.dispose()
    expect(ctx.get('tenantAuthority')).toBeUndefined()
    expect(ctx.get('accountAuthority')).toBeUndefined()
    expect(ctx.get('tenants')).toBeDefined()
    expect(ctx.get('authority')).toBeDefined()
  })

  it('rejects a second assembly and leaves injected storage in place', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await provideMemoryAuthority(ctx)
    const first = ctx.plugin(MinimalStarter)
    await first.await()
    expect(() => { prepareAuthorityAssembly(ctx, 'minimal') }).toThrow(/already active/)
    await first.dispose()
    expect(ctx.get('tenantAuthority')).toBeUndefined()
    expect(ctx.get('accountAuthority')).toBeUndefined()
    expect(ctx.get('tenants')).toBeDefined()
  })

  it('fails the complete suite when a required child does not register', async () => {
    const services = new Map<string, unknown>([
      ['mysql', {}],
      ['auth', {}],
      ['accountAdministration', {}],
    ])
    const fake = {
      get: (name: string) => services.get(name),
      plugin: (plugin: unknown) => {
        if (plugin === TenantMysqlDirectory) services.set('tenants', {})
        else if (plugin === TeamMysqlDirectory) services.set('teams', {})
        else if (plugin === Authority) services.set('authority', {})
        else if (plugin === AuthRbac) services.set('authRbac', {})
        else if (plugin === AuthRbacMysql) services.set('authRbacMysql', {})
        else if (plugin === AuthorityAcl) services.set('authorityAcl', {})
        else if (plugin === AuthorityAclMysql) services.set('authorityAclMysql', {})
        else if (plugin === TenantAuthority) services.set('tenantAuthority', {})
        return Promise.resolve()
      },
    } as unknown as Context
    await expect(FullStarter.apply(fake)).rejects.toThrow(/accountAuthority/)
  })

  it('requires the readiness marker before mounting consumers', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await provideMemoryAuthority(ctx, false)
    expect(() => { prepareAuthorityAssembly(ctx, 'minimal') }).toThrow(/authorityProvidersReady/)
  })
})
