/** Transport-neutral authentication gateway types. */

import type {
  AuthenticatedCall,
  AuthenticationRequestId,
  LoginIdentifierInput,
  UserRecord,
} from '@deepseek-ai/dsh-account/types'
import type { UserExtensions } from '@deepseek-ai/dsh-user/types'

export type { AuthenticatedCall, AuthenticationRequestId, LoginIdentifierInput, UserRecord }

/** Stable failure category exposed to HTTP and WebSocket adapters. */
export type AuthGatewayErrorCode =
  | 'invalid-request'
  | 'unauthenticated'
  | 'forbidden'
  | 'conflict'
  | 'unavailable'

/** One header entry before case folding; duplicates remain observable. */
export interface GatewayHeader {
  readonly name: string
  readonly value: string
}

/** One parsed cookie entry supplied by a transport adapter. */
export interface GatewayCookie {
  readonly name: string
  readonly value: string
}

/** One decoded query entry; repeated keys remain observable. */
export interface GatewayQueryEntry {
  readonly name: string
  readonly value: string
}

/** Lifecycle and structured carrier data shared by gateway entry points. */
export interface GatewayRequest {
  readonly requestId: string
  readonly signal: AbortSignal
  readonly headers?: readonly GatewayHeader[]
  readonly cookies?: readonly GatewayCookie[]
  readonly query?: readonly GatewayQueryEntry[]
}

/** HTTP request eligible for bearer authentication. */
export interface GatewayHttpAuthenticationRequest extends GatewayRequest {}

/** WebSocket handshake request; no frame or post-upgrade refresh is accepted. */
export interface GatewayWebSocketAuthenticationRequest extends GatewayRequest {
  readonly subprotocols?: readonly string[]
}

/** Adapter instructions accompanying a WebSocket handshake call. */
export interface GatewayWebSocketAuthenticationResult {
  readonly call: AuthenticatedCall
  readonly carrier: 'authorization' | 'subprotocol' | 'query'
  readonly adapter: {
    readonly echoCredentialSubprotocol: false
    readonly redactSubprotocols: boolean
    readonly redactQuery: boolean
  }
}

/** Password login input whose secret came from a bounded request body. */
export interface GatewayLoginRequest extends GatewayRequest {
  readonly identifier: LoginIdentifierInput
  readonly password: string
}

/** Registration input whose secret came from a bounded request body. */
export interface GatewayRegistrationRequest extends GatewayRequest {
  readonly identifier: LoginIdentifierInput
  readonly password: string
  readonly displayName?: string
  readonly extensions?: UserExtensions
}

/** Cookie mutation instruction interpreted by the HTTP adapter. */
export interface GatewayCookieDirective {
  readonly name: string
  readonly value: string
  readonly httpOnly: boolean
  readonly secure: boolean
  readonly sameSite: 'strict'
  readonly path: string
  readonly maxAgeSeconds?: number
}

/** Browser-safe session response: refresh material is present only in cookies. */
export interface GatewaySessionResult {
  readonly user?: UserRecord
  readonly accessToken: string
  readonly accessExpiresAt?: number
  readonly cookies: readonly GatewayCookieDirective[]
}

/** Logout response clearing gateway-owned cookies. */
export interface GatewayLogoutResult {
  readonly cookies: readonly GatewayCookieDirective[]
}

/** Configurable carrier names and browser-origin policy. */
export interface AuthGatewayConfig {
  /** Secure HttpOnly refresh-cookie name. */
  readonly refreshCookieName?: string
  /** Secure readable cookie name carrying the double-submit CSRF value. */
  readonly csrfCookieName?: string
  /** Request header name carrying the double-submit CSRF value. */
  readonly csrfHeaderName?: string
  /** Exact browser origins allowed to perform refresh. */
  readonly allowedOrigins?: readonly string[]
  /** Whether WebSocket handshakes may carry access tokens in query entries. */
  readonly allowWebSocketQueryAccessToken?: boolean
  /** Whether WebSocket handshakes may carry access tokens in subprotocol entries. */
  readonly allowWebSocketBearerSubprotocol?: boolean
}
