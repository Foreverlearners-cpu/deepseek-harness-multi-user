/**
 * Service Definition for verified, immutable Host call identity.
 * Transport adapters submit carrier-owned evidence; Providers verify it, and
 * only this module can mint a call accepted by downstream authorization.
 * @module @deepseek-ai/dsh-authentication
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  AuthenticatedCall,
  AuthenticationAttempt,
  AuthenticationErrorCode,
  AuthenticationMethod,
  AuthenticationRequestId,
  LocalPrincipalId,
  MembershipId,
  OperatorGrantId,
  ServiceAccountId,
  TenantId,
  UserId,
  VerifiedAuthentication,
} from './types.ts'

export type * from './types.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/
const issuedCalls = new WeakSet<object>()
const callIssuers = new WeakMap<object, object>()

function validateId(kind: string, value: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new TypeError(`authentication: ${kind} must match ${String(ID_PATTERN)}`)
  }
  return value
}

/**
 * Brand a Host-generated request correlation id.
 * @param value - Candidate id.
 * @returns Validated id.
 */
export function authenticationRequestId(value: string): AuthenticationRequestId {
  return validateId('request id', value) as AuthenticationRequestId
}

/**
 * Brand a human account id.
 * @param value - Candidate id.
 * @returns Validated id.
 */
export function userId(value: string): UserId {
  return validateId('user id', value) as UserId
}

/**
 * Brand a service-account id.
 * @param value - Candidate id.
 * @returns Validated id.
 */
export function serviceAccountId(value: string): ServiceAccountId {
  return validateId('service-account id', value) as ServiceAccountId
}

/**
 * Brand an explicit local principal id.
 * @param value - Candidate id.
 * @returns Validated id.
 */
export function localPrincipalId(value: string): LocalPrincipalId {
  return validateId('local principal id', value) as LocalPrincipalId
}

/**
 * Brand a tenant id.
 * @param value - Candidate id.
 * @returns Validated id.
 */
export function tenantId(value: string): TenantId {
  return validateId('tenant id', value) as TenantId
}

/**
 * Brand a membership id.
 * @param value - Candidate id.
 * @returns Validated id.
 */
export function membershipId(value: string): MembershipId {
  return validateId('membership id', value) as MembershipId
}

/**
 * Brand a platform operator grant id.
 * @param value - Candidate id.
 * @returns Validated id.
 */
export function operatorGrantId(value: string): OperatorGrantId {
  return validateId('operator grant id', value) as OperatorGrantId
}

/**
 * Brand an authentication mechanism name.
 * @param value - Candidate name.
 * @returns Validated name.
 */
export function authenticationMethod(value: string): AuthenticationMethod {
  return validateId('authentication method', value) as AuthenticationMethod
}

/**
 * Test whether a value was minted by this process's Authentication Service.
 * Structural copies, JSON round trips, and client payloads always fail.
 * @param value - Candidate call.
 * @returns Whether the private issuer recorded this exact frozen object.
 */
export function isAuthenticatedCall(value: unknown): value is AuthenticatedCall {
  return (typeof value === 'object' && value !== null) && issuedCalls.has(value)
}

/** Public authentication failure safe to map onto a carrier response. */
export class AuthenticationError extends Error {
  /** Stable failure category. */
  readonly code: AuthenticationErrorCode

  /**
   * @param code - Stable failure category.
   * @param message - Public diagnostic without credential material.
   * @param options - Optional contained cause.
   */
  constructor(code: AuthenticationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AuthenticationError'
    this.code = code
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Active Host Authentication Provider. */
    authentication: AuthenticationProvider
  }
}

/** Provider base that exclusively mints immutable authenticated calls. */
export abstract class AuthenticationProvider extends Service {
  private readonly issuerToken = {}

  /**
   * Whether this Provider is restricted to an explicitly local composition.
   * Network-capable Providers keep the default `false`; local synthetic
   * Providers override it so transport adapters can fail closed when a
   * deployment declares non-loopback authorities.
   */
  readonly localOnly: boolean = false

  /** @param ctx - Owning Host Context. */
  constructor(ctx: Context) {
    super(ctx, 'authentication')
  }

  /**
   * Verify carrier evidence and mint a call bound to its request, channel, and
   * cancellation signal. Provider-owned objects are copied before freezing.
   * @param attempt - Trusted transport input, never a business payload.
   * @returns A privately issued immutable call.
   * @throws {@link AuthenticationError} or a Provider-specific verification failure.
   */
  async authenticate(attempt: AuthenticationAttempt): Promise<AuthenticatedCall> {
    const verified = await this.verify(attempt)
    if (verified.expiresAt !== undefined && !Number.isFinite(verified.expiresAt)) {
      throw new AuthenticationError(
        'authentication-unavailable',
        'authentication provider returned an invalid credential expiry',
      )
    }
    const principal = Object.freeze({ ...verified.principal })
    const scope = Object.freeze({ ...verified.scope })
    const call = Object.freeze({
      requestId: attempt.requestId,
      channel: attempt.channel,
      signal: attempt.signal,
      principal,
      method: verified.method,
      scope,
      ...(verified.expiresAt === undefined ? {} : { expiresAt: verified.expiresAt }),
    }) as AuthenticatedCall
    issuedCalls.add(call)
    callIssuers.set(call, this.issuerToken)
    return call
  }

  /**
   * Check that a call was issued by this live Provider instance.
   * @param value - Candidate call.
   * @returns Whether this Provider minted the exact call object.
   */
  owns(value: unknown): value is AuthenticatedCall {
    return isAuthenticatedCall(value) && callIssuers.get(value) === this.issuerToken
  }

  /**
   * Verify one carrier attempt without constructing the final call object.
   * @param attempt - Trusted transport input.
   * @returns Verified principal, method, scope, and optional expiry.
   */
  protected abstract verify(attempt: AuthenticationAttempt): Promise<VerifiedAuthentication>
}

export default AuthenticationProvider
