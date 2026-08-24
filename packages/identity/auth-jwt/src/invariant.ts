/** Package-owned invariant companion for `@deepseek-ai/dsh-auth-jwt`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-auth-jwt'

/** Cordis companion plugin name. */
export const name = 'auth-jwt-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: `dsh-auth` owns Provider provenance and
 * `dsh-auth-token` owns family state and its post-commit relation checks.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership.
 * @param ctx - context carrying the invariant registry.
 * @returns installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
