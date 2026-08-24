/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-user-credential-mysql`.
 * @module @deepseek-ai/dsh-user-credential-mysql/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-user-credential-mysql'

/** Cordis companion plugin name. */
export const name = 'user-credential-mysql-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: metadata and event relationships are owned by
 * `dsh-user-credential`; schema, verifier, and transaction behavior require MySQL.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
