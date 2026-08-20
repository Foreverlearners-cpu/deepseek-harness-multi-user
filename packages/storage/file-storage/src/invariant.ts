/** Package-owned invariant companion for `@deepseek-ai/dsh-file-storage`. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-file-storage'

/** Cordis companion plugin name. */
export const name = 'file-storage-invariant'
/** Invariant registry required before package ownership is reserved. */
export const inject = ['invariants']

/**
 * No runtime invariant: the service's durable relation is the digest-to-bytes
 * check, which is enforced by put/get and covered by the medium round-trip
 * tests; there is no separate in-process registry relation to observe.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
