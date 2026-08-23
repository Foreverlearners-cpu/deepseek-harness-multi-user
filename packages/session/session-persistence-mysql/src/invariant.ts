/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-session-persistence-mysql`.
 * @module @deepseek-ai/dsh-session-persistence-mysql/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-session-persistence-mysql'

/** Cordis companion plugin name. */
export const name = 'session-persistence-mysql-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: persistence correctness requires backend round-trip and
 * crash-tail tests; this package exposes no continuously observable in-process relation.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
