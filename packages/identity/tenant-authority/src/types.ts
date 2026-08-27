/** Host tenant-guard types shared by the authority decide entry. */

import type { AuthenticatedCall } from '@deepseek-ai/dsh-auth/types'
import type {
  ActionCode,
  AuthorityDenyCode,
  AuthorityPurpose,
  ResourceRef,
  TrustedResourceRef,
} from '@deepseek-ai/dsh-authority/types'
import type { TenantId } from '@deepseek-ai/dsh-tenant/types'
import type { UserId } from '@deepseek-ai/dsh-user/types'

/** Trusted actor scope. Platform is never treated as a tenant membership. */
export type TenantAuthorityScope =
  | { readonly kind: 'tenant'; readonly tenantId: TenantId }
  | { readonly kind: 'platform' }

/** Authorization request plus the trusted actor scope selected before decide. */
export interface TenantAuthorityRequest {
  readonly call: AuthenticatedCall
  readonly action: ActionCode
  readonly resource: ResourceRef
  readonly purpose?: AuthorityPurpose
  readonly scope: TenantAuthorityScope
}

/** Query that asks only whether the actor scope matches one resolved tenant. */
export interface TenantScopeQuery {
  readonly userId: UserId
  readonly scope: TenantAuthorityScope
  readonly resourceTenantId: TenantId
}

/** Result of the tenant-consistency check. Deny never names the other tenant. */
export type TenantScopeDecision =
  | { readonly outcome: 'allow' }
  | { readonly outcome: 'deny'; readonly code: 'unresolved-resource' | 'provider-unavailable' }

/** Stable tenant-guard failure category safe for transport mapping. */
export type TenantAuthorityErrorCode =
  | 'invalid-input'
  | 'conflict'
  | AuthorityDenyCode

/** Public decide outcome. Cross-tenant and missing resources share one deny code. */
export type TenantAuthorityDecision =
  | { readonly outcome: 'allow'; readonly resource: TrustedResourceRef }
  | { readonly outcome: 'deny'; readonly code: AuthorityDenyCode }
