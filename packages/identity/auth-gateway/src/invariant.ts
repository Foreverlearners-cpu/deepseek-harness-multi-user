/** Package-owned invariant companion for `@deepseek-ai/dsh-auth-gateway`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-auth-gateway'

/** Cordis companion plugin name. */
export const name = 'auth-gateway-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: calls are revalidated synchronously at their use site. */
const install: InvariantInstaller = () => {}

/** Register package invariant ownership.
 * @param ctx - context carrying the invariant registry.
 * @returns installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
