/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-team-mysql`.
 * @module @deepseek-ai/dsh-team-mysql/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-team-mysql'

/** Cordis companion plugin name. */
export const name = 'team-mysql-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: committed record and event relationships are owned by
 * `dsh-team`; schema compatibility and atomic SQL behavior require a database.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
