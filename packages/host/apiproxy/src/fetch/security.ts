import type { RpcMethodMap } from '../api/rpc-map.ts'

/** Stable route names crossing the legacy API Proxy boundary. */
export type ApiProxyRoute = keyof RpcMethodMap | 'events.mux' | 'events.host' | 'session.export' | 'respond'

/** Policy identifiers for legacy API routes. Values are deliberately stable policy names. */
export const API_PROXY_ROUTE_PERMISSIONS: Readonly<Record<ApiProxyRoute, string>> = {
  'session.list': 'api:session-list', 'session.search': 'api:session-list', 'session.create': 'api:session-write',
  'session.history': 'api:session-history', 'session.models': 'api:session-list', 'session.selectModel': 'api:session-write',
  'session.rename': 'api:session-write', 'session.fork': 'api:session-write', 'session.prompt': 'api:session-prompt',
  'session.attachment': 'api:session-history', 'session.updateQueue': 'api:session-write', 'session.cancel': 'api:session-write',
  'subagent.list': 'api:subagent-list', 'subagent.history': 'api:subagent-history', 'subagent.prompt': 'api:subagent-prompt',
  'subagent.interrupt': 'api:subagent-write', 'host.describe': 'api:host-read', 'host.pickDirectory': 'api:host-native',
  'host.listDirectory': 'api:host-read', 'host.createDirectory': 'api:host-write', 'host.openPath': 'api:host-native',
  'workspace.list': 'api:workspace-read', 'workspace.create': 'api:workspace-write', 'workspace.rename': 'api:workspace-write',
  'workspace.delete': 'api:workspace-write', 'workspace.insertBefore': 'api:workspace-write',
  'workspace.insertSessionBefore': 'api:workspace-write', 'workspace.archiveSession': 'api:workspace-write',
  'skill.list': 'api:skill-list', 'agentPreset.list': 'api:agent-preset-list',
  'agentPreset.select': 'api:agent-preset-use', 'agentPreset.read': 'api:agent-preset-metadata-read',
  'agentPreset.copy': 'api:agent-preset-write', 'agentPreset.openDocument': 'api:agent-preset-native',
  'agentPreset.remove': 'api:agent-preset-write',
  'goal.create': 'api:goal-write', 'goal.edit': 'api:goal-write', 'goal.pause': 'api:goal-write',
  'goal.resume': 'api:goal-write', 'goal.complete': 'api:goal-write', 'goal.clear': 'api:goal-write',
  'settings.describe': 'api:settings-read', 'settings.openDocument': 'api:settings-native',
  'settings.update': 'api:settings-write', 'settings.replace': 'api:settings-write', 'settings.mutate': 'api:settings-write',
  'credentials.describe': 'api:credentials-read', 'credentials.set': 'api:credentials-write', 'credentials.unset': 'api:credentials-write',
  'llm.providers': 'api:llm-read', 'llm.models': 'api:llm-read', 'llm.discoverModels': 'api:llm-discover',
  'events.mux': 'api:events-mux', 'events.host': 'api:events-host', 'session.export': 'api:session-export', respond: 'api:respond',
}

/**
 * Resolve the stable action permission for one legacy route.
 * @param route - Route selected by the carrier.
 * @returns Stable policy identifier owned by the API Proxy catalog.
 */
export function apiProxyPermission(route: ApiProxyRoute): string {
  return API_PROXY_ROUTE_PERMISSIONS[route]
}

/** Carrier-safe authentication or authorization refusal category. */
export type ApiProxySecurityCode = 'unauthenticated' | 'permission-denied'

/**
 * Adapter-owned denial at the legacy carrier boundary.
 * Only `code` is safe to serialize; `message` may contain private adapter context.
 */
export class ApiProxySecurityError extends Error {
  /** Stable category that carrier adapters may serialize. */
  readonly code: ApiProxySecurityCode

  /**
   * Create an adapter denial while retaining an optional private diagnostic.
   * @param code - Stable carrier-safe refusal category.
   * @param message - Adapter diagnostic that must not be serialized directly.
   */
  constructor(code: ApiProxySecurityCode, message: string = code) {
    super(message)
    this.name = 'ApiProxySecurityError'
    this.code = code
  }
}

/** Trusted route authorization input assembled outside the RPC payload. */
export interface ApiProxySecurityRequest {
  readonly request: Request
  readonly route: ApiProxyRoute
  readonly permission: string
  readonly call: unknown
}

/** Revocable lifetime returned after a route decision has been accepted. */
export interface ApiProxySecurityLease {
  /** Aborts when the adapter no longer considers the decision current. */
  readonly signal: AbortSignal
  /** Stop observing the decision after the carrier operation ends. */
  release(): void
}

/** Optional authentication/authorization seam. Omit it for pure in-process protocol tests. */
export interface ApiProxySecurityOptions {
  authenticate(request: Request): Promise<unknown>
  /** Authorize one route and return an opaque adapter-owned decision token. */
  authorize(input: ApiProxySecurityRequest): Promise<unknown>
  /** Re-check a decision immediately before the route consumes it. */
  assertCurrent?(input: ApiProxySecurityRequest, decision: unknown): void | Promise<void>
  /** Keep a current decision live for a long-running carrier operation. */
  openLease?(
    input: ApiProxySecurityRequest,
    decision: unknown,
  ): ApiProxySecurityLease | Promise<ApiProxySecurityLease>
}
