/** Explicit local-profile Authentication Provider. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import AuthenticationProvider, {
  AuthenticationError,
  authenticationMethod,
  localPrincipalId,
  membershipId,
  tenantId,
  type AuthenticationAttempt,
  type VerifiedAuthentication,
} from '@deepseek-ai/dsh-authentication'

/** Stable local identities selected by composition. */
export interface Config {
  /** Principal id used by this local profile. */
  principalId: string
  /** Personal tenant id used by this local profile. */
  tenantId: string
  /** Membership joining the local principal to its tenant. */
  membershipId: string
}

/** Local Authentication Provider enabled only when explicitly mounted. */
export class LocalAuthenticationProvider extends AuthenticationProvider {
  /** Transport adapters must keep this synthetic identity loopback-only. */
  override readonly localOnly = true
  /** Local identity configuration has no permissive defaults. */
  static Config: z<Config> = z.object({
    principalId: z.string(),
    tenantId: z.string(),
    membershipId: z.string(),
  })

  private readonly identity: VerifiedAuthentication

  /** @param ctx - Owning local-profile Context. @param config - Explicit stable local ids. */
  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.identity = Object.freeze({
      principal: Object.freeze({ kind: 'local', id: localPrincipalId(config.principalId) }),
      method: authenticationMethod('local'),
      scope: Object.freeze({
        kind: 'tenant',
        tenantId: tenantId(config.tenantId),
        membershipId: membershipId(config.membershipId),
      }),
    })
  }

  /** @param attempt - Trusted carrier attempt. @returns The configured local identity. */
  protected verify(attempt: AuthenticationAttempt): Promise<VerifiedAuthentication> {
    if (attempt.channel === 'http' && !isLoopbackRequest(attempt.evidence.request)) {
      throw new AuthenticationError(
        'unauthenticated',
        'local authentication is restricted to loopback HTTP authorities',
      )
    }
    return Promise.resolve(this.identity)
  }
}

function isLoopbackRequest(request: Request): boolean {
  let hostname: string
  try {
    const authority = request.headers.get('host')
    hostname = authority === null
      ? new URL(request.url).hostname.toLowerCase()
      : new URL(`http://${authority}`).hostname.toLowerCase()
  } catch {
    return false
  }
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
}

export default LocalAuthenticationProvider
