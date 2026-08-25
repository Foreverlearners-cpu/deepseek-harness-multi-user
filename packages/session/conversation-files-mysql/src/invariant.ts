/** Package invariant companion for MySQL conversation file metadata. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-conversation-files-mysql'
/** Companion plugin name. */
export const name = 'conversation-files-mysql-invariant'
/** Invariant service dependency. */
export const inject = ['invariants']
/** No runtime invariant: database foreign keys and owner-scoped transactions enforce metadata relations. */
const install: InvariantInstaller = () => {}
/** Register package ownership. @param ctx - invariant context. @returns disposer. */
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
