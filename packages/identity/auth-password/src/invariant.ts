/** Package-owned invariant companion for `@deepseek-ai/dsh-auth-password`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-auth-password'

/** Cordis companion plugin name. */
export const name = 'auth-password-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No independent runtime invariant: `dsh-auth` owns Provider registration and
 * result events, while `dsh-user-credential` owns verification work.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership.
 * @param ctx - context carrying the invariant registry.
 * @returns installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
