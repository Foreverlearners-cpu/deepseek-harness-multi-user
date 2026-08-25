/** Package-owned invariant companion for `@deepseek-ai/dsh-conversation`. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-conversation'

/** Cordis companion plugin name. */
export const name = 'conversation-invariant'
/** Service required before package ownership can be registered. */
export const inject = ['invariants']

/** No runtime invariant: Provider operations validate ownership and sequence relations at their commit points. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. @param ctx - context carrying invariants. @returns registration disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
