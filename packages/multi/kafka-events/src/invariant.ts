/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-kafka-events`.
 * @module @deepseek-ai/dsh-kafka-events/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-kafka-events'

/** Cordis companion plugin name. */
export const name = 'kafka-events-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: typed runners own no relationship beyond the active
 * Kafka subscriptions whose lifecycle and commit behavior the transport owns.
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
