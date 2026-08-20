/** Host HTTP bridge for browser-client RPC. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import {
  isAuthenticatedCall,
} from '@deepseek-ai/dsh-authentication'
import {
  AuthorizationDeniedError,
  permissionCode,
  type AuthorizationAllowDecision,
  type PermissionDefinition,
  type PermissionDisclosure,
} from '@deepseek-ai/dsh-authorization'
// Activates the webServer Context merge used below.
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  API_PROXY_ROUTE_PERMISSIONS,
  ApiProxySecurityError,
  toFetchHandler,
  type ApiProxyRoute,
  type ApiProxySecurityLease,
  type ApiProxySecurityOptions,
  type ApiProxySecurityRequest,
} from '@deepseek-ai/dsh-host-apiproxy'
import { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { assertTrustedAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import { HostConnectionService } from './rpc-host.ts'
import { rejectWebSocketUpgrade, WebSocketDownlinks } from './websocket-downlink.ts'

export type {
  ConnectionRpcAuthority,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcHandler,
  ConnectionRpcHandlerOptions,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'
export { HostConnectionService } from './rpc-host.ts'

export { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

const CONTENT_PERMISSIONS = new Set([
  'api:events-mux',
  'api:events-host',
  'api:session-history',
  'api:subagent-history',
  'api:session-export',
])

function disclosureFor(permission: string): PermissionDisclosure {
  if (CONTENT_PERMISSIONS.has(permission)) return 'content'
  if (permission === 'api:credentials-write') return 'secret-use'
  if (permission.endsWith('-read') || permission.endsWith('-list')) return 'metadata'
  return 'administration'
}

/** Complete permission catalog for the legacy API Proxy carrier surface. */
export const API_PROXY_PERMISSIONS: readonly PermissionDefinition[] = Object.freeze(
  [...new Set(Object.values(API_PROXY_ROUTE_PERMISSIONS))].map(value => Object.freeze({
    code: permissionCode(value),
    owner: '@deepseek-ai/dsh-host-apiproxy',
    description: `Use the legacy API Proxy capability ${value}.`,
    disclosure: disclosureFor(value),
  })),
)

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/** Services required before providing Connection; API Proxy is an optional `/api` fallback. */
export const inject = ['webServer', 'authentication']

/** Plugin config: the deployment's non-loopback serving authorities. */
export interface ConnectionConfig {
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The /api trust fence refuses any
   * request whose Host is neither loopback nor listed here, so a
   * non-loopback (`0.0.0.0`) deployment must declare the names it is reached
   * by (the dsh CLI derives the machine's LAN IP literals itself). An entry
   * that is not a bare, canonical authority fails the plugin load.
   */
  trustedHosts?: string[]
  /** Maximum buffered JSON body for every `/api` request. */
  maxRequestBodyBytes?: number
}

export const Config: z<ConnectionConfig> = z.object({
  trustedHosts: z.array(String).default([]),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

/**
 * Methods gated to loopback even on a trusted-host deployment. Native dialogs
 * act on the host machine; the settings and credential domains mutate the
 * user's configuration and secret store, and READING them is equally
 * privileged — `settings.describe` returns every exposed namespace's
 * configuration and `credentials.describe` reports whether an arbitrary
 * environment-variable name is configured and where from. `trustedHosts` is
 * a DNS-rebinding fence, explicitly not authentication; Authentication and
 * route Authorization run after it. The whole configuration plane remains
 * loopback-same-origin as an additional deployment restriction even for an
 * authenticated principal. `llm.discoverModels` belongs to that plane on both counts: it
 * carries a draft credential, and it makes the HOST issue a GET to a URL the
 * caller chose and reports back the status or the parsed body — an anonymous
 * LAN caller would have a probe for whatever the host can reach and the
 * browser cannot.
 *
 * The model catalog (`llm.providers`, `llm.models`) is deliberately NOT here:
 * it carries provider ids, display names, and model lists — no endpoints,
 * keys, or key state — and a LAN client's model picker legitimately needs it.
 */
const PRIVILEGED_METHODS = new Set([
  // A preset composition names the plugins a session runs, so reading one is
  // reconnaissance; copy and remove rearrange what the deployment offers, and
  // openDocument drives the host desktop — all more than the roster beside
  // them. (Authoring is copy-only, so no method here accepts composition text
  // or a path; the pin is about who may manage the roster at all.)
  //
  // CHOOSING one is not pinned, and `agentPreset.list` is not either. Picking a
  // preset looks like escalation — one of them mounts the toolset that edits the
  // live runtime — but `session.create` already takes an `agentPreset`, so
  // pinning only the switch would leave the same capability one method over.
  // The deeper reason is that the capability is not the preset's to grant: the
  // deployment's own default already carries `bash` and the filesystem tools, so
  // any caller that may start a session at all can already run commands as this
  // process. Pinning the switch would be a fence beside an open gate.
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.discoverModels',
])

function securityError(error: unknown): ApiProxySecurityError {
  if (error instanceof ApiProxySecurityError) return error
  if (error instanceof AuthorizationDeniedError) {
    return new ApiProxySecurityError(
      error.publicError.code === 'UNAUTHENTICATED' ? 'unauthenticated' : 'permission-denied',
    )
  }
  return new ApiProxySecurityError('permission-denied')
}

function apiProxySecurity(
  ctx: Context,
  connection: HostConnectionService,
): ApiProxySecurityOptions {
  return {
    authenticate: request => connection.authenticateRequest(request),
    async authorize(input): Promise<AuthorizationAllowDecision> {
      if (!isAuthenticatedCall(input.call)) throw new ApiProxySecurityError('unauthenticated')
      const authorization = ctx.get('authorization')
      if (authorization === undefined) throw new ApiProxySecurityError('permission-denied')
      try {
        return await authorization.require({
          call: input.call,
          permission: permissionCode(input.permission),
        })
      } catch (error) {
        throw securityError(error)
      }
    },
    assertCurrent(input, decision): void {
      if (!isAuthenticatedCall(input.call)) throw new ApiProxySecurityError('unauthenticated')
      const authorization = ctx.get('authorization')
      if (authorization === undefined) throw new ApiProxySecurityError('permission-denied')
      try {
        authorization.assertCurrent(
          { call: input.call, permission: permissionCode(input.permission) },
          decision as AuthorizationAllowDecision,
        )
      } catch (error) {
        throw securityError(error)
      }
    },
    openLease(input, decision) {
      if (!isAuthenticatedCall(input.call)) throw new ApiProxySecurityError('unauthenticated')
      const authorization = ctx.get('authorization')
      if (authorization === undefined) throw new ApiProxySecurityError('permission-denied')
      try {
        return authorization.openLease(
          { call: input.call, permission: permissionCode(input.permission) },
          decision as AuthorizationAllowDecision,
        )
      } catch (error) {
        throw securityError(error)
      }
    },
  }
}

function requestForUpgrade(req: IncomingMessage): Request {
  const authority = typeof req.headers.host === 'string' ? req.headers.host : 'dsh.internal'
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value)
    else if (Array.isArray(value)) headers.set(name, value.join(', '))
  }
  return new Request(new URL(req.url ?? '/', `http://${authority}`), {
    method: req.method ?? 'GET',
    headers,
  })
}

async function authorizeUpgrade(
  security: ApiProxySecurityOptions,
  request: Request,
  route: Extract<ApiProxyRoute, 'events.mux' | 'events.host'>,
): Promise<ApiProxySecurityLease | undefined> {
  let call: unknown
  try {
    call = await security.authenticate(request)
  } catch {
    throw new ApiProxySecurityError('unauthenticated')
  }
  const input: ApiProxySecurityRequest = {
    request,
    route,
    permission: API_PROXY_ROUTE_PERMISSIONS[route],
    call,
  }
  let decision: unknown
  try {
    decision = await security.authorize(input)
    await security.assertCurrent?.(input, decision)
    return await security.openLease?.(input, decision)
  } catch (error) {
    throw securityError(error)
  }
}

/**
 * Mounts the API gateway under the browser transport prefix. Every request on
 * the prefix passes the browser-trust fence first (DNS-rebinding and
 * cross-site defense — [api-request-trust](./api-request-trust.ts));
 * privileged methods additionally pass it with an empty trust list, which
 * pins them to loopback.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config?: ConnectionConfig): void {
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? []
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  const authentication = ctx.get('authentication')
  if (trustedHosts.length > 0 && authentication?.localOnly === true) {
    throw new Error(
      'client-connection: local-only authentication cannot be combined with trustedHosts; '
      + 'configure a network-capable Authentication Provider first',
    )
  }
  if (ctx.get('apiProxy') !== undefined) assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  const connection = new HostConnectionService(ctx, trustedHosts)
  const security = apiProxySecurity(ctx, connection)
  ctx.inject(['authorization'], (authorizationCtx) => {
    for (const definition of API_PROXY_PERMISSIONS) {
      authorizationCtx.authorization.permissions.register(definition)
    }
  })
  const fetchHandler = connection.createSharedFetchHandler(API_PATH, {
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const method = pathname.startsWith(`${API_PATH}/`)
        ? pathname.slice(API_PATH.length + 1)
        : undefined
      if (method !== undefined
        && PRIVILEGED_METHODS.has(method)
        && !isTrustedApiRequest(request, [])) {
        return new Response('forbidden', { status: 403 })
      }
      if (request.method === 'GET' && (pathname === MUX_EVENTS_PATH || pathname === HOST_EVENTS_PATH)) {
        return new Response('upgrade required', {
          status: 426,
          headers: { connection: 'Upgrade', upgrade: 'websocket' },
        })
      }
      const apiProxy = ctx.get('apiProxy')
      if (apiProxy === undefined) return new Response('not found', { status: 404 })
      return toFetchHandler(apiProxy, { security }).fetch(request)
    },
  })
  const route: WebRoute = {
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHosts)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      await bridge(req, res, fetchHandler, maxRequestBodyBytes)
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'client-connection: /api route')
  ctx.inject(['apiProxy'], (apiCtx) => {
    assertImageBodyCapacity(apiCtx, maxRequestBodyBytes)
    const downlinks = new WebSocketDownlinks(apiCtx.apiProxy)
    const registerDownlink = (
      path: string,
      route: Extract<ApiProxyRoute, 'events.mux' | 'events.host'>,
      handle: (
        req: IncomingMessage,
        socket: Duplex,
        head: Buffer,
        lease: ApiProxySecurityLease | undefined,
      ) => void,
    ): void => {
      apiCtx.effect(() => apiCtx.webServer.registerUpgrade({
        path,
        handler: async (req, socket, head) => {
          if (!isTrustedApiRequest(req, trustedHosts)) {
            rejectWebSocketUpgrade(socket)
            return
          }
          let lease: ApiProxySecurityLease | undefined
          try {
            lease = await authorizeUpgrade(security, requestForUpgrade(req), route)
          } catch (error) {
            const status = error instanceof ApiProxySecurityError && error.code === 'unauthenticated'
              ? 401
              : 403
            rejectWebSocketUpgrade(socket, status)
            return
          }
          handle(req, socket, head, lease)
        },
      }), `client-connection: ${path} WebSocket`)
    }
    apiCtx.effect(() => () => downlinks.close(), 'client-connection: WebSocket downlinks')
    registerDownlink(MUX_EVENTS_PATH, 'events.mux', (req, socket, head, lease) => {
      downlinks.handleMux(req, socket, head, lease)
    })
    registerDownlink(HOST_EVENTS_PATH, 'events.host', (req, socket, head, lease) => {
      downlinks.handleHost(req, socket, head, lease)
    })
  })
}
