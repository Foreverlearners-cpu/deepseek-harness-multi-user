/** Signed access and refresh JWT types shared with trusted transport Consumers. */

/** Bearer JWT extracted by a trusted transport adapter. */
export interface BearerAuthenticationEvidence {
  readonly kind: 'bearer'
  readonly token: string
}

/** One symmetric JWT signing and verification key. */
export interface JwtSigningKeyConfig {
  /** Stable protected-header key id. */
  readonly keyId: string
  /** Base64url-encoded secret containing 32-128 random bytes. */
  readonly secret: string
}

/** JWT issuer, audience, lifetimes, and rotation keyring. */
export interface JwtAuthenticationConfig {
  /** Exact issuer claim required on both Token types. */
  readonly issuer: string
  /** Exact single audience claim required on both Token types. */
  readonly audience: string
  /** Access lifetime in seconds; defaults to 900. */
  readonly accessTtlSeconds?: number
  /** Fixed refresh-family lifetime in seconds; defaults to 2,592,000. */
  readonly refreshTtlSeconds?: number
  /** JWT clock tolerance in seconds; defaults to zero. */
  readonly clockToleranceSeconds?: number
  /** Configured key id used to sign newly issued Token pairs. */
  readonly activeKeyId: string
  /** Verification keyring containing the active and retained rotation keys. */
  readonly keys: readonly JwtSigningKeyConfig[]
}

declare module '@deepseek-ai/dsh-auth/types' {
  interface AuthenticationEvidenceMap {
    /** Signed access JWT carried as bearer evidence. */
    bearer: BearerAuthenticationEvidence
  }
}
