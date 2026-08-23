/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-projection-reconciler`.
 * @module @deepseek-ai/dsh-session-projection-reconciler/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-projection-reconciler'

/** Cordis companion plugin name. */
export const name = 'session-projection-reconciler-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the source and sinks are application-owned effects,
 * while each reconcile job validates its page and tenant relationships inline.
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
