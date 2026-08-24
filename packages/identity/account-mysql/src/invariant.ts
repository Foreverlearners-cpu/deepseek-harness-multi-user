/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-account-mysql`.
 * @module @deepseek-ai/dsh-account-mysql/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-account-mysql'

/** Cordis companion plugin name. */
export const name = 'account-mysql-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** SQL atomicity and schema compatibility require a database-backed test. */
const install: InvariantInstaller = () => {
  // No runtime invariant: durable atomicity and schema ownership are observable only through MySQL.
}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
