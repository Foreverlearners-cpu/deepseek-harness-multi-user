/**
 * Package-owned invariant companion for session cache invalidation through Redis.
 * @module @deepseek-ai/dsh-session-cache-invalidation-redis/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-cache-invalidation-redis'

/** Cordis companion plugin name. */
export const name = 'session-cache-invalidation-redis-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this Host Consumer owns no event stream or mutable
 * in-process relation; Kafka offset commit and Redis `DEL` are enforced by
 * the transport, the client callback, and this package's handler tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
