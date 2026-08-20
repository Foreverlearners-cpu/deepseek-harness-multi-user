/** Package-owned invariant companion for the message-only MySQL provider. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-conversation-persistence-mysql'

/** Cordis companion plugin name. */
export const name = 'conversation-persistence-mysql-invariant'
/** Invariant registry required before package ownership is reserved. */
export const inject = ['invariants']

/** This package deliberately stores final messages, never streaming chunks. */
export const MESSAGE_ONLY = true

// No runtime invariant: the message-only boundary is enforced at the durable
// SQL projection and validated by the MySQL round-trip tests, not by a live
// in-process relation.
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
