/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the account-authority row.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AuthenticationRuntime, {
  authenticationMethod,
  authenticationRequestId,
} from '@deepseek-ai/dsh-auth'
import AuthRbac, { MemoryRbacPolicySource, roleId } from '@deepseek-ai/dsh-auth-rbac'
import Authority, { actionCode, resourceId } from '@deepseek-ai/dsh-authority'
import AuthorityAcl, { MemoryAclPolicySource } from '@deepseek-ai/dsh-authority-acl'
import { userId } from '@deepseek-ai/dsh-user'
import AccountAuthority, { ACCOUNT_RESOURCE_TYPE } from '../src/index.ts'
import { MemoryTeamDirectory } from '../../team/tests/memory.ts'
import { MemoryTenantDirectory } from '../../tenant/tests/memory.ts'
import { AccountAdministrationStub } from './account-admin-stub.ts'

const ACTOR = userId('user-admin')
const TARGET = userId('user-red')

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a cordis.yml, then boot it through the real Loader. */
async function loadComposition(includeAuthorizer: boolean): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-account-authority-loader-'))
  const configPath = join(root, 'cordis.yml')
  const rows = [
    "- name: '@deepseek-ai/dsh-auth'",
    "- name: '@deepseek-ai/dsh-authority'",
    "- name: '@deepseek-ai/dsh-tenant-memory'",
    "- name: '@deepseek-ai/dsh-team-memory'",
    "- name: '@deepseek-ai/dsh-auth-rbac'",
    "- name: '@deepseek-ai/dsh-authority-acl'",
    "- name: '@deepseek-ai/dsh-account-administration-stub'",
  ]
  if (includeAuthorizer) rows.push("- name: '@deepseek-ai/dsh-account-authority'")
  await writeFile(configPath, `${rows.join('\n')}\n`)

  context = new Context()
  context.baseUrl = `${pathToFileURL(root).href}/`
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-auth', AuthenticationRuntime],
    ['@deepseek-ai/dsh-authority', Authority],
    ['@deepseek-ai/dsh-tenant-memory', MemoryTenantDirectory],
    ['@deepseek-ai/dsh-team-memory', MemoryTeamDirectory],
    ['@deepseek-ai/dsh-auth-rbac', AuthRbac],
    ['@deepseek-ai/dsh-authority-acl', AuthorityAcl],
    ['@deepseek-ai/dsh-account-administration-stub', AccountAdministrationStub],
    ['@deepseek-ai/dsh-account-authority', AccountAuthority],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

async function authenticate(ctx: Context) {
  ctx.auth.providers.register('in-process', {
    method: authenticationMethod('local-test'),
    verify: async () => ({
      principal: { kind: 'user' as const, id: ACTOR },
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

describe('account-authority REAL composition', () => {
  it('denies administrator actions when cordis.yml omits the wiring plugin', async () => {
    const ctx = await loadComposition(false)
    const call = await authenticate(ctx)
    await expect(ctx.accountAdministration.authorizers.authorize(call, 'disable', TARGET))
      .rejects.toMatchObject({ code: 'forbidden' })
  })

  it('allows a same-team disable after the Loader mounts the wiring plugin', async () => {
    const ctx = await loadComposition(true)
    const rbac = new MemoryRbacPolicySource()
    const acl = new MemoryAclPolicySource()
    ctx.authRbac.registerSource(rbac)
    ctx.authorityAcl.registerSource(acl)
    const tenant = await ctx.tenants.create({ displayName: 'Acme' })
    const team = await ctx.teams.create({ tenantId: tenant.tenantId, displayName: 'RD' })
    for (const member of [ACTOR, TARGET]) {
      await ctx.tenants.addMember({ tenantId: tenant.tenantId, userId: member })
      await ctx.teams.addMember({
        teamId: team.teamId,
        tenantId: tenant.tenantId,
        userId: member,
      })
    }
    const disable = actionCode('account:disable')
    rbac.putRole({ roleId: roleId('runner'), use: [disable], delegate: [] })
    rbac.assign({
      userId: ACTOR,
      tenantId: tenant.tenantId,
      teamId: team.teamId,
      roleId: roleId('runner'),
    })
    acl.grant({
      resource: { type: ACCOUNT_RESOURCE_TYPE, id: resourceId(TARGET) },
      subject: { kind: 'team', id: team.teamId },
      use: [disable],
      delegate: [],
    })
    const call = await authenticate(ctx)
    await expect(ctx.accountAdministration.authorizers.authorize(call, 'disable', TARGET))
      .resolves.toBeUndefined()
  })
})
