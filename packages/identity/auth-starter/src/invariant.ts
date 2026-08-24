/** Package-owned invariant companion for `@deepseek-ai/dsh-auth-starter`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-auth-starter'
/** Cordis companion plugin name. */
export const name = 'auth-starter-invariant'
/** Service required before package ownership registration. */
export const inject = ['invariants']
/** No runtime invariant: child packages own Provider and durable-state relations. */
const install: InvariantInstaller = () => {}
/** Register this package's invariant ownership.
 * @param ctx - context carrying the invariant registry.
 * @returns installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
