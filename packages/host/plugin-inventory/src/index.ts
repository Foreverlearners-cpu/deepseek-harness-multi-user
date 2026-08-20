/** Read-only projection of the current Cordis Loader plugin entries. */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { AuthenticatedCall } from '@deepseek-ai/dsh-authentication'
import { permissionCode, type PermissionDefinition } from '@deepseek-ai/dsh-authorization'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryDiscoverySnapshot,
  PluginInventoryEntry,
  PluginInventorySnapshot,
} from './types.ts'

export type * from './types.ts'

/** Permission to learn which Loader entries exist. */
export const PLUGIN_DISCOVER_PERMISSION = permissionCode('plugin:discover')
/** Permission to read package names, enablement, and runtime phases. */
export const PLUGIN_METADATA_READ_PERMISSION = permissionCode('plugin:metadata-read')

/** Permission definitions owned by this domain package. */
export const PLUGIN_INVENTORY_PERMISSIONS: readonly PermissionDefinition[] = Object.freeze([
  Object.freeze({
    code: PLUGIN_DISCOVER_PERMISSION,
    owner: '@deepseek-ai/dsh-host-plugin-inventory',
    description: 'Discover configured plugin entry identities.',
    disclosure: 'discovery',
  }),
  Object.freeze({
    code: PLUGIN_METADATA_READ_PERMISSION,
    owner: '@deepseek-ai/dsh-host-plugin-inventory',
    description: 'Read configured plugin package and runtime metadata.',
    disclosure: 'metadata',
  }),
])

/** Brand an existing Loader-tree entry id at the owning boundary. */
function pluginEntryId(value: string): PluginEntryId {
  return value as PluginEntryId
}

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, PluginFiberPhase>

/** Remote-only service exposing the Loader's current non-group entry state. */
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader', 'authorization']

  constructor(ctx: Context) {
    super(ctx, 'pluginInventory')
    for (const definition of PLUGIN_INVENTORY_PERMISSIONS) {
      ctx.authorization.permissions.register(definition)
    }
  }

  /**
   * Project only configured entry identities.
   * @param call - Host-issued caller identity injected outside Remote wire arguments.
   * @returns Current non-group Loader entry ids in Loader order.
   */
  @Remote({ exportName: 'discover', permission: 'plugin:discover' })
  async discover(call: AuthenticatedCall): Promise<PluginInventoryDiscoverySnapshot> {
    await this.ctx.authorization.require({ call, permission: PLUGIN_DISCOVER_PERMISSION })
    return {
      entries: [...this.ctx.loader.entries()]
        .filter(entry => !entry.options.group)
        .map(entry => ({ entryId: pluginEntryId(entry.id) })),
    }
  }

  /**
   * Read the Loader directly on every call. Cordis's internal plugin/status
   * events already maintain Entry.fiber and Fiber.state, so a second cache
   * would only add another lifecycle truth to keep synchronized.
   * @param call - Host-issued caller identity injected outside Remote wire arguments.
   * @returns Current non-group Loader entries in Loader order.
   */
  @Remote({ exportName: 'list', permission: 'plugin:metadata-read' })
  async list(call: AuthenticatedCall): Promise<PluginInventorySnapshot> {
    await this.ctx.authorization.require({ call, permission: PLUGIN_METADATA_READ_PERMISSION })
    const entries: PluginInventoryEntry[] = []
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group) continue
      entries.push({
        entryId: pluginEntryId(entry.id),
        moduleName: entry.options.name,
        enabled: !entry.disabled,
        fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state],
      })
    }
    return { entries }
  }
}

export default PluginInventoryGateway
