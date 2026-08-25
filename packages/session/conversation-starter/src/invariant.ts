/** Package-owned invariant companion for local conversation attachment. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-conversation-starter'

/** Cordis companion plugin name. */
export const name = 'conversation-starter-invariant'
/** Service required before package ownership is reserved. */
export const inject = ['invariants']
/** No runtime invariant: unpublished setup rejects invalid lineage before publication. */
const install: InvariantInstaller = () => {}
/** Register package ownership. @param ctx - Host context. @returns registration disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
