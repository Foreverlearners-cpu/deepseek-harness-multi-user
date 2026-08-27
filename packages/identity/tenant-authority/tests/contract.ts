/** Shared tenant-guard contract against a resolver seeded with the standard fixture. */

import { Context } from '@deepseek-ai/cordis'
import AuthenticationRuntime from '@deepseek-ai/dsh-auth'
import Authority, {
  actionCode,
  resourceId,
  resourceType,
  type TrustedResourceRef,
} from '@deepseek-ai/dsh-authority'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import { describe, expect, it } from 'vitest'
import TenantAuthority, { type TenantScopeDecision, type TenantScopeQuery } from '../src/index.ts'
import { MemoryTenantMembership } from './tenants-stub.ts'

const USER = userId('user-red')
const TENANT = tenantId('tenant-1')
const OTHER_TENANT = tenantId('tenant-2')
const EXECUTE = actionCode('plugin:execute')
const TYPE = resourceType('plugin')
const RESOURCE = resourceId('plugin-100')

/** Live tenant-guard matcher used for one conformance case. */
export interface TenantAuthorityContractHarness {
  readonly match: (query: TenantScopeQuery) => Promise<TenantScopeDecision>
}

function resource(
  owner: ReturnType<typeof tenantId>,
  id: ReturnType<typeof resourceId> = RESOURCE,
): TrustedResourceRef {
  return {
    type: TYPE,
    id,
    tenantId: owner,
    teamId: 'team-rd' as TrustedResourceRef['teamId'],
    revision: 1,
  }
}

/**
 * Seed membership in `tenant-1` only and a resolver that can return either tenant.
 * @param tenants - live membership table used as `ctx.tenants`.
 */
export function seedStandardTenants(tenants: MemoryTenantMembership): void {
  tenants.add(TENANT, USER)
}

/**
 * Run the same-tenant allow / cross-tenant hidden-deny contract.
 * The factory must place `user-red` only in `tenant-1`.
 * @param label - Provider label used in the test suite name.
 * @param create - factory returning a live matcher over that fixture.
 */
export function runTenantAuthorityContract(
  label: string,
  create: () => Promise<TenantAuthorityContractHarness>,
): void {
  describe(`tenant-authority contract: ${label}`, () => {
    it('allows the check when the actor scope is the resource tenant', async () => {
      const { match } = await create()
      await expect(match({
        userId: USER,
        scope: { kind: 'tenant', tenantId: TENANT },
        resourceTenantId: TENANT,
      })).resolves.toEqual({ outcome: 'allow' })
    })

    it('denies a valid other-tenant id as unresolved', async () => {
      const { match } = await create()
      await expect(match({
        userId: USER,
        scope: { kind: 'tenant', tenantId: TENANT },
        resourceTenantId: OTHER_TENANT,
      })).resolves.toEqual({ outcome: 'deny', code: 'unresolved-resource' })
    })

    it('does not treat platform scope as tenant membership', async () => {
      const { match } = await create()
      await expect(match({
        userId: USER,
        scope: { kind: 'platform' },
        resourceTenantId: TENANT,
      })).resolves.toEqual({ outcome: 'deny', code: 'unresolved-resource' })
    })
  })
}

/** Mount auth, authority, tenant membership, and the tenant guard.
 * @returns live harness used by the shared contract and local tests.
 */
export async function setupTenantAuthority(): Promise<{
  readonly ctx: Context
  readonly tenantAuthority: TenantAuthority
  readonly tenants: MemoryTenantMembership
}> {
  const ctx = new Context()
  await ctx.plugin(AuthenticationRuntime)
  await ctx.plugin(Authority)
  await ctx.plugin(MemoryTenantMembership)
  await ctx.plugin(TenantAuthority)
  const tenants = ctx.get('tenants') as unknown as MemoryTenantMembership
  seedStandardTenants(tenants)
  ctx.authority.registerAction({ action: EXECUTE, resourceType: TYPE })
  ctx.authority.registerRoute('role', { evaluate: async () => ({ actions: [EXECUTE] }) })
  ctx.authority.registerRoute('object', { evaluate: async () => ({ actions: [EXECUTE] }) })
  ctx.tenantAuthority.registerResolver(TYPE, {
    resolve: async (ref) => {
      if (ref.id === 'missing') return undefined
      if (ref.id === RESOURCE || ref.id === 'plugin-100') return resource(TENANT)
      if (ref.id === 'plugin-other') return resource(OTHER_TENANT, resourceId('plugin-other'))
      return undefined
    },
  })
  return { ctx, tenantAuthority: ctx.tenantAuthority, tenants }
}

export { EXECUTE, OTHER_TENANT, RESOURCE, TENANT, TYPE, USER, resource }
