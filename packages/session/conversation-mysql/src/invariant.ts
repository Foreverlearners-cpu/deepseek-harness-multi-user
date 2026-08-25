/** Package invariant companion for the MySQL Conversation Provider. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-conversation-mysql'
/** Companion plugin name. */
export const name = 'conversation-mysql-invariant'
/** Invariant service dependency. */
export const inject = ['invariants']
/** No runtime invariant: append transactions enforce records, projections, and sequence advancement together. */
const install: InvariantInstaller = () => {}
/** Register package ownership. @param ctx - invariant context. @returns disposer. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
