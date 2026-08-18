/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-redis`.
 * @module @deepseek-ai/dsh-redis/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-redis'

/** Cordis companion plugin name. */
export const name = 'redis-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: Redis availability is external state rather than an
 * owned in-process relationship. Lifecycle tests verify startup, callback
 * admission, readiness refusal, and quiescent disposal.
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
