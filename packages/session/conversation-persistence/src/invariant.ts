/** Package-owned invariant companion for conversation persistence. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-conversation-persistence'

/** Cordis companion plugin name. */
export const name = 'conversation-persistence-invariant'
/** Service required before package ownership is reserved. */
export const inject = ['invariants']

/** No runtime invariant: correctness is observable only through Provider commits and flush failures. */
const install: InvariantInstaller = () => {}

/** Register the package invariant companion. @param ctx - Host context. @returns registration disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
