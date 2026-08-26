/** Host authorization-decision types shared by Providers and Consumers. */

import type { AuthenticatedCall } from '@deepseek-ai/dsh-auth/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { TeamId } from '@deepseek-ai/dsh-team/types'
import type { TenantId } from '@deepseek-ai/dsh-tenant/types'
import type { UserId } from '@deepseek-ai/dsh-user/types'

/** Stable catalogued action, such as `plugin:execute`. */
export type ActionCode = Branded<'ActionCode'>

/** Stable resource class handled by one resolver, such as `plugin`. */
export type ResourceType = Branded<'ResourceType'>

/** Stable identity of one resolved resource. */
export type ResourceId = Branded<'ResourceId'>

/** Independent authorization route that contributes one action set on a team. */
export type AuthorityRoute = 'role' | 'object'

/** Which action set a route Provider must return for one evaluation. */
export type AuthorityPurpose = 'use' | 'delegate'

/** Client-supplied resource pointer. Tenant and team claims on this object are ignored. */
export interface ResourceRef {
  readonly type: ResourceType
  readonly id: string
}

/** Catalog entry that binds one action to the resource class it may target. */
export interface ActionDefinition {
  readonly action: ActionCode
  readonly resourceType: ResourceType
}

/** Resolver-owned resource facts. Callers cannot mint this value. */
export interface TrustedResourceRef {
  readonly type: ResourceType
  readonly id: ResourceId
  readonly tenantId: TenantId
  readonly teamId: TeamId
  readonly revision: number
}

/** Authorization request: current identity, catalogued action, and untrusted resource pointer. */
export interface AuthorityRequest {
  readonly call: AuthenticatedCall
  readonly action: ActionCode
  readonly resource: ResourceRef
  readonly purpose?: AuthorityPurpose
}

/** Stable deny category safe for transport mapping. */
export type AuthorityDenyCode =
  | 'unauthenticated'
  | 'unknown-action'
  | 'unresolved-resource'
  | 'missing-provider'
  | 'insufficient-permission'
  | 'provider-unavailable'

/** Stable authorization failure category, including registration and input errors. */
export type AuthorityErrorCode =
  | 'invalid-input'
  | 'conflict'
  | AuthorityDenyCode

/** Result of one fail-closed decision. */
export type AuthorityDecision =
  | { readonly outcome: 'allow'; readonly resource: TrustedResourceRef }
  | { readonly outcome: 'deny'; readonly code: AuthorityDenyCode }

/** Query sent to one route Provider after identity, action, and resource are resolved. */
export interface AuthorityRouteQuery {
  readonly userId: UserId
  readonly tenantId: TenantId
  readonly teamId: TeamId
  readonly action: ActionCode
  readonly resource: TrustedResourceRef
  readonly set: AuthorityPurpose
}

/** Action set returned by one route on the supplied team. */
export interface AuthorityRouteResult {
  readonly actions: readonly ActionCode[]
}

/** Route Provider that reports the Use or Delegate set for one team. */
export interface AuthorityRouteProvider {
  /** Return the Use or Delegate action set for the supplied team.
   * @param query - resolved user, tenant, team, action, resource, and set.
   * @returns action codes this route grants on that team for that set.
   */
  evaluate(query: AuthorityRouteQuery): Promise<AuthorityRouteResult>
}

/** Domain resolver that turns an untrusted pointer into tenant, team, and revision. */
export interface ResourceResolver {
  /** Resolve one untrusted pointer to trusted tenant, team, and revision.
   * @param ref - caller-supplied type and id.
   * @returns trusted resource facts, or undefined when the pointer is unknown.
   */
  resolve(ref: ResourceRef): Promise<TrustedResourceRef | undefined>
}
