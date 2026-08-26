/** Browser login presentation plugin. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { LoginOverlay } from './LoginOverlay.tsx'
import { en, NS, zh, type LoginKey } from './locales.ts'

export type { LoginOverlayProps, LoginRole } from './LoginOverlay.tsx'
export type { LoginKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Login presentation copy. */
    'auth.login': LoginKey
  }
}

/** Required services for locale registration and shell-overlay contribution. */
export const inject = ['slots', 'locale']

/**
 * Register localized login presentation above the assembled Web application.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-auth-login: dictionaries')
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'auth-login',
    order: -100,
    locale: NS,
  }, LoginOverlay))
}
