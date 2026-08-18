/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-mysql`.
 * @module @deepseek-ai/dsh-mysql/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mysql'

/** Cordis companion plugin name. */
export const name = 'mysql-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: MySQL availability is external state rather than an
 * owned in-process relationship. Startup and connection tests verify pool
 * acquisition, lease release, and quiescent disposal.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
