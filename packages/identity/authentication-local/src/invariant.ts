/** Package-owned invariant companion for `@deepseek-ai/dsh-authentication-local`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-authentication-local'

/** Cordis companion plugin name. */
export const name = 'authentication-local-invariant'
/** Service required before reserving package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the immutable configured identity has no independent event or mutable relation. */
const install: InvariantInstaller = () => {}

/** @param ctx - Context carrying invariant registration. @returns Registration disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
