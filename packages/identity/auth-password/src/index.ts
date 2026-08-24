/**
 * Password authentication Provider backed by `ctx.userCredentials`.
 * @module @deepseek-ai/dsh-auth-password
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  AuthenticationError,
  authenticationMethod,
  type AuthenticationProvider,
  type VerifiedAuthentication,
} from '@deepseek-ai/dsh-auth'
import { UserCredentialError } from '@deepseek-ai/dsh-user-credential'
import type { UserId } from '@deepseek-ai/dsh-user-credential/types'
import type { PasswordAuthenticationEvidence } from './types.ts'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'auth-password'
/** Services required to register and run password authentication. */
export const inject = ['auth', 'userCredentials']

const METHOD = authenticationMethod('password')

function credentialFailure(cause: unknown): AuthenticationError {
  if (cause instanceof UserCredentialError && cause.code === 'provider-unavailable') {
    return new AuthenticationError(
      'authentication-unavailable',
      'auth-password: credential Provider is unavailable',
    )
  }
  return new AuthenticationError('unauthenticated', 'auth-password: credentials were rejected')
}

/** Create the password Provider registered by this plugin.
 * @param ctx - context carrying the active user credential service.
 * @returns Provider for the exact `password` evidence kind.
 */
export function createPasswordAuthenticationProvider(
  ctx: Context,
): AuthenticationProvider<'password'> {
  return {
    method: METHOD,
    async verify(attempt): Promise<VerifiedAuthentication> {
      const evidence: PasswordAuthenticationEvidence = attempt.evidence
      let userId: UserId | undefined
      try {
        userId = await ctx.userCredentials.resolve(evidence.identifier)
        const accepted = await ctx.userCredentials.verifyPassword({
          ...(userId === undefined ? {} : { userId }),
          password: evidence.password,
        })
        if (!accepted || userId === undefined) throw credentialFailure(undefined)
      } catch (cause) {
        if (cause instanceof AuthenticationError) throw cause
        throw credentialFailure(cause)
      }
      return {
        principal: { kind: 'user', id: userId },
        authenticatedAt: Date.now(),
      }
    },
  }
}

/** Register the sole password evidence Provider for this plugin fiber.
 * @param ctx - context carrying authentication and user credential services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.auth.providers.register(
    'password',
    createPasswordAuthenticationProvider(ctx),
  ))
}

export default apply
