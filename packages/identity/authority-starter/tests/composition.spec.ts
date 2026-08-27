/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the authority-starter/minimal row.
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
import AuthRbac, { MemoryRbacPolicySource } from '@deepseek-ai/dsh-auth-rbac'
import Authority, { actionCode, resourceType } from '@deepseek-ai/dsh-authority'
import AuthorityAcl, { MemoryAclPolicySource } from '@deepseek-ai/dsh-authority-acl'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import * as MinimalStarter from '../src/minimal.ts'
import { AUTHORITY_PROVIDER_READINESS } from '../src/assembly.ts'
import { MemoryTeamDirectory } from '../../team/tests/memory.ts'
import { MemoryTenantDirectory } from '../../tenant/tests/memory.ts'
import { AccountAdministrationStub } from './account-admin-stub.ts'

const USER = userId('user-red')
const TENANT = tenantId('tenant-1')

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const AuthRuntimePlugin = {
  name: 'authority-starter-auth-runtime',
  async apply(ctx: Context): Promise<void> {
    await ctx.plugin(AuthenticationRuntime)
    await ctx.plugin(AccountAdministrationStub)
    const auth = ctx.get('auth') as Context['auth']
    auth.providers.register('in-process', {
      method: authenticationMethod('local-test'),
      verify: async () => ({
        principal: { kind: 'user' as const, id: USER },
        authenticatedAt: Date.now(),
      }),
    })
  },
}

const StoragePlugin = {
  name: 'authority-starter-memory-storage',
  async apply(ctx: Context): Promise<void> {
    await ctx.plugin(MemoryTenantDirectory)
    await ctx.plugin(MemoryTeamDirectory)
    await ctx.plugin(Authority)
    await ctx.plugin(AuthRbac)
    await ctx.plugin(AuthorityAcl)
    const rbac = ctx.get('authRbac') as Context['authRbac']
    const acl = ctx.get('authorityAcl') as Context['authorityAcl']
    rbac.registerSource(new MemoryRbacPolicySource())
    acl.registerSource(new MemoryAclPolicySource())
    ctx.provide(AUTHORITY_PROVIDER_READINESS, true)
  },
}

/** Write a cordis.yml, then boot it through the real Loader. */
async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-authority-starter-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-authority-starter-auth-runtime'",
    "- name: '@deepseek-ai/dsh-authority-starter-memory-storage'",
    "- name: '@deepseek-ai/dsh-authority-starter/minimal'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = `${pathToFileURL(root).href}/`
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-authority-starter-auth-runtime', AuthRuntimePlugin],
    ['@deepseek-ai/dsh-authority-starter-memory-storage', StoragePlugin],
    ['@deepseek-ai/dsh-authority-starter/minimal', MinimalStarter],
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

describe('authority-starter REAL composition', () => {
  it('boots through the Loader and keeps decide and administration fail-closed', async () => {
    const ctx = await loadComposition()
    const call = await ctx.auth.authenticate({
      requestId: authenticationRequestId('request-1'),
      channel: 'in-process',
      evidence: { kind: 'in-process' },
      signal: new AbortController().signal,
    })
    await expect(ctx.tenantAuthority.decide({
      call,
      action: actionCode('plugin:execute'),
      resource: { type: resourceType('plugin'), id: 'plugin-1' },
      scope: { kind: 'tenant', tenantId: TENANT },
    })).resolves.toEqual({ outcome: 'deny', code: 'missing-provider' })
    await expect(ctx.accountAdministration.authorizers.authorize(call, 'disable', USER))
      .rejects.toMatchObject({ code: 'forbidden' })
    expect(ctx.get('accountAuthority')).toBeDefined()
  })
})
