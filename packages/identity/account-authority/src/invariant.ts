/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-account-authority`.
 * @module @deepseek-ai/dsh-account-authority/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-account-authority'

/** Cordis companion plugin name. */
export const name = 'account-authority-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: each authorize call re-reads live membership and authority. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership.
 * @param ctx - context carrying the invariant registry.
 * @returns installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
