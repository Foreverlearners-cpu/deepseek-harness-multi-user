import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  authenticationRequestId,
  type AuthenticatedCall,
} from '@deepseek-ai/dsh-authentication'
import LocalAuthenticationProvider from '@deepseek-ai/dsh-authentication-local'
import { AuthorizationDeniedError } from '@deepseek-ai/dsh-authorization'
import StaticAuthorizationProvider, {
  type StaticAuthorizationMode,
} from '@deepseek-ai/dsh-authorization-static'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import PluginInventoryGateway, {
  PLUGIN_DISCOVER_PERMISSION,
  PLUGIN_METADATA_READ_PERMISSION,
} from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const activePlugin: Plugin.Function = () => {}
const pendingPlugin: Plugin.Object = {
  inject: ['neverReady'],
  apply() {},
}

async function harness(mode?: StaticAuthorizationMode): Promise<{
  ctx: Context
  inventory: PluginInventoryGateway
  call: AuthenticatedCall
  inventoryFiber: ReturnType<Context['plugin']>
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  await ctx.plugin(LocalAuthenticationProvider, {
    principalId: 'test-user', tenantId: 'test-tenant', membershipId: 'test-membership',
  })
  await ctx.plugin(StaticAuthorizationProvider, { mode: mode ?? 'trusted-local' })
  ctx.loader.builtins.active = activePlugin
  ctx.loader.builtins.pending = pendingPlugin
  const inventoryFiber = ctx.plugin(PluginInventoryGateway)
  await inventoryFiber
  const inventory = ctx.get('pluginInventory') as PluginInventoryGateway
  const signal = new AbortController().signal
  const call = await ctx.authentication.authenticate({
    requestId: authenticationRequestId('plugin-inventory-test'),
    channel: 'in-process',
    evidence: { kind: 'in-process' },
    signal,
  })
  return { ctx, inventory, call, inventoryFiber }
}

describe('PluginInventoryGateway', () => {
  it('publishes protected discovery and metadata methods under the pluginInventory namespace', async () => {
    const { inventory } = await harness()
    expect(inventory.typertRemote).toMatchObject({
      serviceKey: 'pluginInventory',
      namespace: 'pluginInventory',
    })
    expect(remoteMethods(inventory)).toEqual([
      {
        method: 'discover',
        invocation: { kind: 'direct' },
        access: 'permission',
        authorization: { permission: 'plugin:discover', callParameter: 'call' },
      },
      {
        method: 'list',
        invocation: { kind: 'direct' },
        access: 'permission',
        authorization: { permission: 'plugin:metadata-read', callParameter: 'call' },
      },
    ])
  })

  it('projects current non-group Loader entries without a second cache', async () => {
    const { ctx, inventory, call } = await harness()
    const activeId = await ctx.loader.create({ name: 'cordis:active' })
    const pendingId = await ctx.loader.create({ name: 'cordis:pending' })
    const disabledId = await ctx.loader.create({
      name: 'cordis:not-installed',
      disabled: true,
    })
    await ctx.loader.create({ name: 'cordis:active', group: true })

    const discovery = await inventory.discover(call)
    expect(discovery.entries.map(entry => entry.entryId)).toEqual([activeId, pendingId, disabledId])

    const snapshot = await inventory.list(call)
    expect(snapshot.entries).toHaveLength(3)
    expect(snapshot.entries).toEqual(expect.arrayContaining([
      {
        entryId: activeId,
        moduleName: 'cordis:active',
        enabled: true,
        fiberPhase: 'active',
      },
      {
        entryId: pendingId,
        moduleName: 'cordis:pending',
        enabled: true,
        fiberPhase: 'pending',
      },
      {
        entryId: disabledId,
        moduleName: 'cordis:not-installed',
        enabled: false,
        fiberPhase: null,
      },
    ]))

    await ctx.loader.update(activeId, { disabled: true })
    expect((await inventory.list(call)).entries.find(entry => entry.entryId === activeId)).toEqual({
      entryId: activeId,
      moduleName: 'cordis:active',
      enabled: false,
      fiberPhase: null,
    })

    await ctx.loader.remove(pendingId)
    expect((await inventory.list(call)).entries.some(entry => entry.entryId === pendingId)).toBe(false)
  })

  it('registers its domain permissions for exactly the service lifetime', async () => {
    const { ctx, inventoryFiber } = await harness()
    expect(ctx.authorization.permissions.get(PLUGIN_DISCOVER_PERMISSION)).toMatchObject({ disclosure: 'discovery' })
    expect(ctx.authorization.permissions.get(PLUGIN_METADATA_READ_PERMISSION)).toMatchObject({ disclosure: 'metadata' })
    await inventoryFiber.dispose()
    expect(ctx.authorization.permissions.get(PLUGIN_DISCOVER_PERMISSION)).toBeUndefined()
    expect(ctx.authorization.permissions.get(PLUGIN_METADATA_READ_PERMISSION)).toBeUndefined()
  })

  it('denies direct domain calls under the explicit deny-all Provider', async () => {
    const { inventory, call } = await harness('deny-all')
    await expect(inventory.discover(call)).rejects.toBeInstanceOf(AuthorizationDeniedError)
    await expect(inventory.list(call)).rejects.toBeInstanceOf(AuthorizationDeniedError)
  })
})
