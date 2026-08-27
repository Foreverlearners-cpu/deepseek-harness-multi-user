/** MySQL-backed complete authorization suite. @module @deepseek-ai/dsh-authority-starter */

import type { Context } from '@deepseek-ai/cordis'
import {
  assertAuthorityAssembly,
  mountAuthorityConsumers,
  mountAuthorityMysqlTree,
  prepareAuthorityAssembly,
} from './assembly.ts'

export { AUTHORITY_PROVIDER_READINESS } from './assembly.ts'

/** Cordis plugin name. */
export const name = 'authority-starter'
/** The complete suite reuses an injected MySQL pool, current auth, and account administration. */
export const inject: readonly string[] = ['mysql', 'auth', 'accountAdministration']

/** Mount the complete MySQL authorization suite in dependency order.
 * @param ctx - suite-owned Cordis context.
 */
export async function apply(ctx: Context): Promise<void> {
  prepareAuthorityAssembly(ctx, 'full')
  await mountAuthorityMysqlTree(ctx)
  await mountAuthorityConsumers(ctx)
  assertAuthorityAssembly(ctx, 'full')
}
