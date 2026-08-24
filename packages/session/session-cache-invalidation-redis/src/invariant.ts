/** Package-owned invariant companion for Redis session cache invalidation. */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-session-cache-invalidation-redis'
/** Cordis companion plugin name. */
export const name = 'session-cache-invalidation-redis-invariant'
/** Service required before package ownership can be registered. */
export const inject = ['invariants']
/** No runtime invariant: Kafka acknowledgement and atomic Redis scripts own the external relation. */
const install: InvariantInstaller = () => {}
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
