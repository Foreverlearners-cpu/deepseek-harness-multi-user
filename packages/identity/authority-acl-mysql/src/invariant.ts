/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-authority-acl-mysql`.
 * @module @deepseek-ai/dsh-authority-acl-mysql/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-authority-acl-mysql'

/** Cordis companion plugin name. */
export const name = 'authority-acl-mysql-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: grant-to-evaluate relationships are owned by
 * `dsh-authority-acl`; schema compatibility and atomic SQL behavior require a database.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
