/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-auth-rbac`.
 * @module @deepseek-ai/dsh-auth-rbac/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-auth-rbac'

/** Cordis companion plugin name. */
export const name = 'auth-rbac-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: each evaluate call re-reads the live source for the query team only. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership.
 * @param ctx - context carrying the invariant registry.
 * @returns installed registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
