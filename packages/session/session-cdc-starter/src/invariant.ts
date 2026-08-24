/** Package-owned invariant companion for `@deepseek-ai/dsh-session-cdc-starter`. */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-cdc-starter'

/** Cordis companion plugin name. */
export const name = 'session-cdc-starter-invariant'
/** Invariant registry required for package ownership. */
export const inject = ['invariants']

/** Runtime route and consumer relationships are validated during starter activation. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant ownership. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
