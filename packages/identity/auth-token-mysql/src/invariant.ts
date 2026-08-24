/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-auth-token-mysql`.
 * @module @deepseek-ai/dsh-auth-token-mysql/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-auth-token-mysql'

/** Cordis companion plugin name. */
export const name = 'auth-token-mysql-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** SQL atomicity and schema compatibility require a database-backed test. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
