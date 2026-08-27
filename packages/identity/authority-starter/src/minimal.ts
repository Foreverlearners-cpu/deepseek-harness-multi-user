/** Authorization consumers over externally supplied storage services. @module @deepseek-ai/dsh-authority-starter/minimal */

import type { Context } from '@deepseek-ai/cordis'
import {
  AUTHORITY_PROVIDER_READINESS,
  assertAuthorityAssembly,
  mountAuthorityConsumers,
  prepareAuthorityAssembly,
} from './assembly.ts'

export { AUTHORITY_PROVIDER_READINESS } from './assembly.ts'

/** Cordis plugin name. */
export const name = 'authority-starter-minimal'
/** Directories, routes, and registered policy sources must be supplied by sibling plugins. */
export const inject = [
  'auth',
  'accountAdministration',
  'tenants',
  'teams',
  'authority',
  'authRbac',
  'authorityAcl',
  AUTHORITY_PROVIDER_READINESS,
]

/** Mount authorization consumers over injected custom Providers.
 * @param ctx - context carrying custom directories, routes, and registered sources.
 */
export async function apply(ctx: Context): Promise<void> {
  prepareAuthorityAssembly(ctx, 'minimal')
  await mountAuthorityConsumers(ctx)
  assertAuthorityAssembly(ctx, 'minimal')
}
