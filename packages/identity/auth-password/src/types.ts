/** Password evidence submitted to the Host authentication runtime. */

import type { LoginIdentifierInput } from '@deepseek-ai/dsh-user-credential/types'

/** Login identifier and candidate password extracted by a trusted Consumer. */
export interface PasswordAuthenticationEvidence {
  readonly kind: 'password'
  readonly identifier: LoginIdentifierInput
  readonly password: string
}

declare module '@deepseek-ai/dsh-auth/types' {
  interface AuthenticationEvidenceMap {
    /** Human login identifier and candidate password. */
    password: PasswordAuthenticationEvidence
  }
}
