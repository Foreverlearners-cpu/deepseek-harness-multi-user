/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-authority`.
 * @module @deepseek-ai/dsh-authority/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-authority'

/** Cordis companion plugin name. */
export const name = 'authority-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: each decide/require call re-reads live registries and current-call provenance. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership.
 * @param ctx - context carrying the invariant registry.
 * @returns installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
