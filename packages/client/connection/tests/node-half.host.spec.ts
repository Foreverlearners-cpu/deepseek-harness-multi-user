/** Node half: registers the /api prefix route bridging to the api gateway. */
import { EventEmitter, once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import AuthenticationProvider, {
  AuthenticationError,
  authenticationMethod,
  isAuthenticatedCall,
  localPrincipalId,
  membershipId,
  tenantId,
  type AuthenticationAttempt,
  type VerifiedAuthentication,
} from '@deepseek-ai/dsh-authentication'
import LocalAuthenticationProvider from '@deepseek-ai/dsh-authentication-local'
import StaticAuthorizationProvider from '@deepseek-ai/dsh-authorization-static'
import type AuthorizationProvider from '@deepseek-ai/dsh-authorization'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  API_PROXY_ROUTE_PERMISSIONS,
  RpcId,
  type ClientRequest,
} from '@deepseek-ai/dsh-host-apiproxy'
import type { WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  API_PATH,
  API_PROXY_PERMISSIONS,
  apply,
  HOST_EVENTS_PATH,
  inject,
  MUX_EVENTS_PATH,
  type HostConnectionHandle,
} from '../src/index.ts'
import { WebSocketDownlinks } from '../src/websocket-downlink.ts'

/** Structural webServer fake recording both route registries. */
function fakeHttpServer(
  routes: WebRoute[],
  upgrades: WebUpgradeRoute[],
): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port'> {
  return {
    register(route) {
      if (routes.some(candidate => candidate.kind === route.kind && candidate.path === route.path)) {
        throw new Error(`duplicate route ${route.path}`)
      }
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => { upgrades.splice(upgrades.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
}

/** Bodyless GET carrying the given headers (enough for the trust fence + bridge). */
function fakeRequest(headers: Record<string, string>, url = `${API_PATH}/session.list`): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'GET', headers })
  return request
}

/** JSON POST carrying a complete client-request envelope. */
function fakePost(headers: Record<string, string>, url: string, body: unknown): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'POST', headers: { 'content-type': 'application/json', ...headers } })
  return request
}

/** Raw POST for malformed-body and media-type boundary cases. */
function fakeRawPost(headers: Record<string, string>, url: string, body: string): IncomingMessage {
  const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'POST', headers })
  return request
}

/** Response recorder compatible with both the fence's short-circuit and the bridge. */
function fakeResponse(): { response: ServerResponse; state: { status?: number; body?: unknown } } {
  const state: { status?: number; body?: unknown } = {}
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(value: number) { state.status = value; return this },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(this: { writableEnded: boolean }, value?: unknown) {
      if (typeof value === 'string' || value instanceof Uint8Array) chunks.push(Buffer.from(value))
      else if (value !== undefined) throw new TypeError('fake response only accepts string or Uint8Array bodies')
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

/** Network-capable fixture identity used only where the test declares a non-loopback authority. */
class FixtureAuthenticationProvider extends AuthenticationProvider {
  protected verify(attempt: AuthenticationAttempt): Promise<VerifiedAuthentication> {
    if (attempt.channel === 'http'
      && attempt.evidence.request.headers.get('x-fixture-auth') === 'deny') {
      throw new AuthenticationError('unauthenticated', 'fixture authentication refused')
    }
    return Promise.resolve({
      principal: { kind: 'local', id: localPrincipalId('connection-test') },
      method: authenticationMethod('fixture'),
      scope: {
        kind: 'tenant',
        tenantId: tenantId('connection-tenant'),
        membershipId: membershipId('connection-membership'),
      },
    })
  }
}

/** Test-only explicit local profile: neither identity nor an allow policy is implicit. */
async function mountIdentity(
  ctx: Context,
  mode: 'trusted-local' | 'deny-all' = 'trusted-local',
  networkCapable = false,
): Promise<{ dispose: () => Promise<void>; authorization: AuthorizationProvider }> {
  const authenticationFiber = networkCapable
    ? ctx.plugin(FixtureAuthenticationProvider)
    : ctx.plugin(LocalAuthenticationProvider, {
      principalId: 'connection-test',
      tenantId: 'connection-tenant',
      membershipId: 'connection-membership',
    })
  await authenticationFiber
  const authorizationFiber = ctx.plugin(StaticAuthorizationProvider, { mode })
  await authorizationFiber
  return {
    authorization: ctx.get('authorization') as AuthorizationProvider,
    dispose: async () => {
      await authorizationFiber.dispose()
      await authenticationFiber.dispose()
    },
  }
}

async function mounted(
  config?: { trustedHosts?: string[] },
  options: { mode?: 'trusted-local' | 'deny-all'; apiProxy?: ApiProxy } = {},
): Promise<{
  routes: WebRoute[]
  upgrades: WebUpgradeRoute[]
  ctx: Context
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const upgrades: WebUpgradeRoute[] = []
  ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
  ctx.provide('apiProxy', options.apiProxy ?? {} as ApiProxy)
  const identity = await mountIdentity(
    ctx,
    options.mode ?? 'trusted-local',
    (config?.trustedHosts?.length ?? 0) > 0 || options.mode === 'deny-all',
  )
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  return {
    routes,
    upgrades,
    ctx,
    dispose: async () => {
      await fiber.dispose()
      await identity.dispose()
    },
  }
}

describe('connection node half', () => {
  it('fails loud when the carrier cap cannot hold the configured image batch', () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('attachments', {
      imageLimits: { maxMessageImageBytes: 20 * 1024 * 1024 },
    } as AttachmentStore)
    ctx.provide('apiProxy', {} as ApiProxy)
    ctx.plugin(LocalAuthenticationProvider, {
      principalId: 'connection-test', tenantId: 'connection-tenant', membershipId: 'connection-membership',
    })
    expect(() => { apply(ctx, { maxRequestBodyBytes: 1024 }) })
      .toThrow(/must be at least .* aggregate image limit/)
    expect(routes).toHaveLength(0)
  })

  it('fails the load on a trustedHosts entry that is not a bare authority', async () => {
    const routes: WebRoute[] = []
    const upgrades: WebUpgradeRoute[] = []
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
    ctx.provide('apiProxy', {} as unknown as ApiProxy)
    const identity = await mountIdentity(ctx, 'trusted-local', true)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.internal/path'] })
    await expect(fiber).rejects.toThrow(/not a bare host\[:port\] authority/)
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
    await identity.dispose()
  })

  it('fails closed when local-only authentication is combined with a remote authority', async () => {
    const routes: WebRoute[] = []
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('apiProxy', {} as ApiProxy)
    const identity = await mountIdentity(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.internal'] })

    await expect(fiber).rejects.toThrow(/local-only authentication cannot be combined with trustedHosts/)
    expect(routes).toHaveLength(0)
    await identity.dispose()
  })

  it('requires an explicit Authentication Provider before mounting Connection', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('apiProxy', {} as unknown as ApiProxy)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await Promise.resolve()
    expect(fiber.state).toBe(FiberState.PENDING)
    expect(routes).toHaveLength(0)
    await fiber.dispose()
  })

  it('registers one HTTP route plus one upgrade route per downlink and removes all three with the fiber', async () => {
    const { routes, upgrades, dispose } = await mounted()
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })
    expect(upgrades.map(route => route.path)).toEqual([MUX_EVENTS_PATH, HOST_EVENTS_PATH])
    await dispose()
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('requires WebSocket upgrade for network GETs to either event path', async () => {
    const { routes, dispose } = await mounted()
    for (const path of [MUX_EVENTS_PATH, HOST_EVENTS_PATH]) {
      const { response, state } = fakeResponse()
      await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }, path), response)
      expect(state.status).toBe(426)
      expect(state.body).toBe('upgrade required')
    }
    await dispose()
  })

  it('rejects an untrusted WebSocket upgrade before protocol negotiation', async () => {
    const { upgrades, dispose } = await mounted()
    const socket = new PassThrough()
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    const ended = once(socket, 'end')
    await upgrades[0]!.handler(fakeRequest({
      host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin',
    }, MUX_EVENTS_PATH), socket, Buffer.alloc(0))
    await ended
    expect(Buffer.concat(chunks).toString()).toContain('HTTP/1.1 403 Forbidden')
    await dispose()
  })

  it('rejects a spoofed loopback Host from a non-loopback TCP peer', async () => {
    const { routes, upgrades, dispose } = await mounted()
    const http = fakeRequest({ host: 'localhost:3080' })
    Object.assign(http, { socket: { remoteAddress: '192.168.1.9' } })
    const denied = fakeResponse()
    await routes[0]!.handler(http, denied.response)
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })

    const upgrade = fakeRequest({ host: 'localhost:3080' }, MUX_EVENTS_PATH)
    Object.assign(upgrade, { socket: { remoteAddress: '::ffff:192.168.1.9' } })
    const socket = new PassThrough()
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    const ended = once(socket, 'end')
    await upgrades[0]!.handler(upgrade, socket, Buffer.alloc(0))
    await ended
    expect(Buffer.concat(chunks).toString()).toContain('HTTP/1.1 403 Forbidden')
    await dispose()
  })

  it('registers the complete legacy API permission catalog while mounting Connection', async () => {
    const { ctx, dispose } = await mounted()
    const registered = new Set(ctx.authorization.permissions.list().map(definition => definition.code))
    expect(registered).toEqual(new Set(Object.values(API_PROXY_ROUTE_PERMISSIONS)))
    expect(API_PROXY_PERMISSIONS.map(definition => definition.code).sort())
      .toEqual([...registered].sort())
    await dispose()
  })

  it('maps an authorization denial before a malformed fallback body can be parsed', async () => {
    const { routes, dispose } = await mounted(undefined, { mode: 'deny-all' })
    const denied = fakeResponse()
    await routes[0]!.handler(fakeRawPost(
      { host: '127.0.0.1:3080', 'content-type': 'application/json' },
      '/api/session.list',
      '{',
    ), denied.response)

    expect(denied.state.status).toBe(200)
    expect(JSON.parse(String(denied.state.body))).toEqual({
      type: 'server-response',
      rpcId: 'security-denied',
      result: {
        ok: false,
        error: {
          code: 'permission-denied',
          message: 'permission-denied',
          details: { permission: 'api:session-list' },
        },
      },
    })
    await dispose()
  })

  it('rejects unauthorized WebSocket upgrades without opening either event source', async () => {
    const mux = vi.fn(() => (async function * () {})())
    const host = vi.fn(() => (async function * () {})())
    const api = { events: { mux, host } } as unknown as ApiProxy
    const { upgrades, dispose } = await mounted(undefined, { mode: 'deny-all', apiProxy: api })

    for (const [index, path] of [
      [0, MUX_EVENTS_PATH],
      [1, HOST_EVENTS_PATH],
    ] as const) {
      const socket = new PassThrough()
      const chunks: Buffer[] = []
      socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      const ended = once(socket, 'end')
      await upgrades[index]!.handler(fakeRequest({ host: '127.0.0.1:3080' }, path), socket, Buffer.alloc(0))
      await ended
      expect(Buffer.concat(chunks).toString()).toContain('HTTP/1.1 403 Forbidden')
    }
    expect(mux).not.toHaveBeenCalled()
    expect(host).not.toHaveBeenCalled()
    await dispose()
  })

  it('opens each lease after the final freshness check and hands it to the matching downlink', async () => {
    const { ctx, upgrades, dispose } = await mounted()
    const authorization = ctx.authorization
    const order: string[] = []
    const muxRelease = vi.fn()
    const hostRelease = vi.fn()
    const muxLease = { signal: new AbortController().signal, release: muxRelease }
    const hostLease = { signal: new AbortController().signal, release: hostRelease }
    const requireCurrent = authorization.require.bind(authorization)
    const assertCurrent = authorization.assertCurrent.bind(authorization)
    const requireSpy = vi.spyOn(authorization, 'require').mockImplementation(async (request) => {
      order.push(`authorize:${request.permission}`)
      return requireCurrent(request)
    })
    const assertSpy = vi.spyOn(authorization, 'assertCurrent').mockImplementation((request, decision) => {
      order.push(`assert:${request.permission}`)
      assertCurrent(request, decision)
    })
    const leaseSpy = vi.spyOn(authorization, 'openLease').mockImplementation((request) => {
      order.push(`lease:${request.permission}`)
      return request.permission === API_PROXY_ROUTE_PERMISSIONS['events.mux'] ? muxLease : hostLease
    })
    const muxHandoff = vi.spyOn(WebSocketDownlinks.prototype, 'handleMux')
      .mockImplementation((_request, socket, _head, lease) => {
        order.push('handoff:mux')
        expect(lease).toBe(muxLease)
        lease?.release()
        socket.destroy()
      })
    const hostHandoff = vi.spyOn(WebSocketDownlinks.prototype, 'handleHost')
      .mockImplementation((_request, socket, _head, lease) => {
        order.push('handoff:host')
        expect(lease).toBe(hostLease)
        lease?.release()
        socket.destroy()
      })

    try {
      await upgrades[0]!.handler(
        fakeRequest({ host: '127.0.0.1:3080' }, MUX_EVENTS_PATH),
        new PassThrough(),
        Buffer.alloc(0),
      )
      await upgrades[1]!.handler(
        fakeRequest({ host: '127.0.0.1:3080' }, HOST_EVENTS_PATH),
        new PassThrough(),
        Buffer.alloc(0),
      )
      expect(order).toEqual([
        `authorize:${API_PROXY_ROUTE_PERMISSIONS['events.mux']}`,
        `assert:${API_PROXY_ROUTE_PERMISSIONS['events.mux']}`,
        `lease:${API_PROXY_ROUTE_PERMISSIONS['events.mux']}`,
        'handoff:mux',
        `authorize:${API_PROXY_ROUTE_PERMISSIONS['events.host']}`,
        `assert:${API_PROXY_ROUTE_PERMISSIONS['events.host']}`,
        `lease:${API_PROXY_ROUTE_PERMISSIONS['events.host']}`,
        'handoff:host',
      ])
      expect(muxRelease).toHaveBeenCalledTimes(1)
      expect(hostRelease).toHaveBeenCalledTimes(1)
    } finally {
      hostHandoff.mockRestore()
      muxHandoff.mockRestore()
      leaseSpy.mockRestore()
      assertSpy.mockRestore()
      requireSpy.mockRestore()
      await dispose()
    }
  })

  it('rejects an upgrade when opening its authorization lease fails', async () => {
    const mux = vi.fn(() => (async function * () {})())
    const api = { events: { mux, host: vi.fn(() => (async function * () {})()) } } as unknown as ApiProxy
    const { ctx, upgrades, dispose } = await mounted(undefined, { apiProxy: api })
    const leaseSpy = vi.spyOn(ctx.authorization, 'openLease').mockImplementation(() => {
      throw new Error('lease unavailable')
    })
    const socket = new PassThrough()
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    const ended = once(socket, 'end')

    try {
      await upgrades[0]!.handler(
        fakeRequest({ host: '127.0.0.1:3080' }, MUX_EVENTS_PATH),
        socket,
        Buffer.alloc(0),
      )
      await ended
      expect(Buffer.concat(chunks).toString()).toContain('HTTP/1.1 403 Forbidden')
      expect(leaseSpy).toHaveBeenCalledTimes(1)
      expect(mux).not.toHaveBeenCalled()
    } finally {
      leaseSpy.mockRestore()
      await dispose()
    }
  })

  it('refuses an untrusted Host on any /api path before the bridge runs', async () => {
    const { routes, dispose } = await mounted()
    const { response, state } = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin',
    }), response)
    expect(state.status).toBe(403)
    expect(state.body).toBe('forbidden')
    await dispose()
  })

  it('pins privileged methods to loopback even for a declared trusted authority', async () => {
    const { routes, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    // The privileged set: native dialogs plus the whole settings/credential
    // configuration plane, reads included, plus the one method that makes the
    // host fetch a caller-chosen URL. The same declared authority reaches
    // ordinary reads (carrier-level 404 from the empty proxy proves the fence
    // passed), but each privileged method stays loopback-only and 403s.
    for (const method of [
      'host.pickDirectory', 'host.openPath',
      'settings.describe', 'settings.openDocument', 'settings.update', 'settings.replace', 'settings.mutate',
      'credentials.describe', 'credentials.set', 'credentials.unset',
      'llm.discoverModels',
      // A composition names the plugins a session runs: reading one is
      // reconnaissance, and copy/remove/openDocument manage the roster and
      // drive the host desktop.
      'agentPreset.read', 'agentPreset.copy', 'agentPreset.openDocument', 'agentPreset.remove',
    ]) {
      const denied = fakeResponse()
      await routes[0]!.handler(
        fakeRequest({ host: 'harness.example' }, `${API_PATH}/${method}`),
        denied.response,
      )
      expect(denied.state.status).toBe(403)
      expect(denied.state.body).toBe('forbidden')
    }
    const read = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: 'harness.example' }), read.response)
    expect(read.state.status).not.toBe(403)
    await dispose()
  })

  it('passes loopback and declared-authority requests through to the bridge', async () => {
    const { routes, dispose } = await mounted({ trustedHosts: ['harness.example:3080', '192.168.1.5'] })
    // Loopback, no browser markers (curl shape): the fence passes; the carrier
    // answers 404 for a GET unary path — proof the bridge ran.
    const loopback = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }), loopback.response)
    expect(loopback.state.status).toBe(404)
    // An all-interfaces composition derives port-less LAN IP literals, which
    // pass markerless curl on any port.
    const lan = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '192.168.1.5:3080' }), lan.response)
    expect(lan.state.status).toBe(404)
    // Declared public authority, same-origin browser shape.
    const declared = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: 'harness.example:3080', origin: 'http://harness.example:3080', 'sec-fetch-site': 'same-origin',
    }), declared.response)
    expect(declared.state.status).toBe(404)
    await dispose()
  })

  it('provides a disposable dedicated RPC channel without requiring apiProxy', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const identity = await mountIdentity(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })

    const connection = ctx.get('connection') as HostConnectionHandle
    const calls: unknown[] = []
    let receivedCall: unknown
    const remove = connection.rpc.handle('/rpc', async (endpoint, payload, call) => {
      calls.push({ endpoint, payload })
      receivedCall = call
      return { ok: true, value: { accepted: true } }
    }, { authority: 'trusted-host' })
    const route = routes.find(candidate => candidate.path === '/rpc')
    expect(route).toBeDefined()

    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-dedicated'),
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }
    const result = fakeResponse()
    await route!.handler(fakePost({ host: '127.0.0.1:3080' }, '/rpc/goals/create', request), result.response)
    expect(result.state.status).toBe(200)
    expect(JSON.parse(String(result.state.body))).toEqual({
      type: 'server-response',
      rpcId: 'rpc-dedicated',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toEqual([{
      endpoint: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }])
    expect(isAuthenticatedCall(receivedCall)).toBe(true)

    expect(() => connection.rpc.handle('/rpc', async () => ({ ok: true, value: null }), {
      authority: 'trusted-host',
    })).toThrow(/duplicate route/)
    await remove()
    expect(routes.map(candidate => candidate.path)).toEqual([API_PATH])
    await fiber.dispose()
    await identity.dispose()
    expect(routes).toHaveLength(0)
  })

  it('dispatches claimed /api endpoints before the API Proxy fallback and withdraws the claim', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('apiProxy', {} as unknown as ApiProxy)
    const identity = await mountIdentity(ctx, 'trusted-local', true)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const calls: unknown[] = []
    let receivedCall: unknown
    const remove = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create',
      async (endpoint, payload, call) => {
        calls.push({ endpoint, payload })
        receivedCall = call
        return { ok: true, value: { accepted: true } }
      },
      { authority: 'trusted-host' },
    )
    expect(() => connection.rpc.intercept(
      '/api',
      () => true,
      async () => ({ ok: true, value: null }),
      { authority: 'trusted-host' },
    )).toThrow('already has an interceptor')
    expect(() => connection.rpc.intercept(
      '/rpc' as '/api',
      () => true,
      async () => ({ ok: true, value: null }),
      { authority: 'trusted-host' },
    )).toThrow('invalid shared RPC channel')
    const route = routes.find(candidate => candidate.path === API_PATH)!
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-shared'),
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }

    const claimed = fakeResponse()
    await route.handler(fakePost({ host: '127.0.0.1:3080' }, '/api/goals/create', request), claimed.response)
    expect(JSON.parse(String(claimed.state.body))).toEqual({
      type: 'server-response',
      rpcId: 'rpc-shared',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toEqual([{
      endpoint: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }])
    expect(isAuthenticatedCall(receivedCall)).toBe(true)

    const denied = fakeResponse()
    await route.handler(fakePost({ host: 'other.example' }, '/api/goals/create', request), denied.response)
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })
    expect(calls).toHaveLength(1)

    const unclaimed = fakeResponse()
    await route.handler(fakeRequest({ host: '127.0.0.1:3080' }, '/api/session.list'), unclaimed.response)
    expect(unclaimed.state.status).toBe(404)

    await remove()
    const withdrawn = fakeResponse()
    await route.handler(fakePost({ host: '127.0.0.1:3080' }, '/api/goals/create', request), withdrawn.response)
    expect(withdrawn.state.status).toBe(404)
    expect(calls).toHaveLength(1)

    const removeLoopback = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create',
      async () => ({ ok: true, value: null }),
      { authority: 'loopback' },
    )
    const loopbackOnly = fakeResponse()
    await route.handler(fakePost({ host: 'harness.example' }, '/api/goals/create', request), loopbackOnly.response)
    expect(loopbackOnly.state.status).toBe(403)
    await removeLoopback()
    await fiber.dispose()
    await identity.dispose()
  })

  it('applies the configured trust fence and JSON envelope checks to generic channels', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const identity = await mountIdentity(ctx, 'trusted-local', true)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const handler = vi.fn(async (endpoint: string) => {
      if (endpoint === 'fail') throw new Error('handler broke')
      return { ok: true as const, value: null }
    })
    const remove = connection.rpc.handle('/rpc', handler, {
      authority: 'trusted-host',
    })
    const route = routes.find(candidate => candidate.path === '/rpc')!

    const denied = fakeResponse()
    await route.handler(fakePost({ host: 'other.example' }, '/rpc/goals/create', {}), denied.response)
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })

    const unauthenticated = fakeResponse()
    await route.handler(fakeRawPost({
      host: 'harness.example',
      'content-type': 'application/json',
      'x-fixture-auth': 'deny',
    }, '/rpc/goals/create', '{'), unauthenticated.response)
    expect(JSON.parse(String(unauthenticated.state.body))).toEqual({
      type: 'server-response',
      rpcId: 'security-denied',
      result: {
        ok: false,
        error: { code: 'unauthenticated', message: 'fixture authentication refused', details: {} },
      },
    })
    expect(handler).not.toHaveBeenCalled()

    const methodMismatch = fakeResponse()
    await route.handler(fakePost({ host: 'harness.example' }, '/rpc/goals/create', {
      type: 'client-request', rpcId: 'rpc-bad', method: 'other', payload: {},
    }), methodMismatch.response)
    expect(JSON.parse(String(methodMismatch.state.body))).toMatchObject({
      rpcId: 'rpc-bad',
      result: { ok: false, error: { code: 'bad-request' } },
    })

    for (const [request, status] of [
      [fakeRequest({ host: 'harness.example' }, '/rpc/goals/create'), 404],
      [fakePost({ host: 'harness.example' }, '/outside/goals/create', {}), 404],
      [fakePost({ host: 'harness.example' }, '/rpc/goals//create', {}), 404],
      [fakeRawPost({ host: 'harness.example' }, '/rpc/goals/create', '{}'), 415],
      [fakeRawPost({ host: 'harness.example', 'content-type': 'text/plain' }, '/rpc/goals/create', '{}'), 415],
      [fakeRawPost({ host: 'harness.example', 'content-type': 'application/json; charset=utf-8' }, '/rpc/goals/create', '{'), 400],
    ] as const) {
      const response = fakeResponse()
      await route.handler(request, response.response)
      expect(response.state.status).toBe(status)
    }

    for (const [body, rpcId] of [
      [{ rpcId: 'retained-id' }, 'retained-id'],
      [{ rpcId: 42 }, 'invalid-request'],
      [null, 'invalid-request'],
    ] as const) {
      const response = fakeResponse()
      await route.handler(fakePost({ host: 'harness.example' }, '/rpc/goals/create', body), response.response)
      expect(JSON.parse(String(response.state.body))).toMatchObject({
        rpcId,
        result: { ok: false, error: { code: 'bad-request' } },
      })
    }

    const failed = fakeResponse()
    await route.handler(fakePost({ host: 'harness.example' }, '/rpc/fail', {
      type: 'client-request', rpcId: 'rpc-fail', method: 'fail', payload: {},
    }), failed.response)
    expect(failed.state).toMatchObject({ status: 500, body: 'handler failure' })

    expect(() => connection.rpc.handle('/api', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
    })).toThrow('invalid or reserved RPC channel')
    expect(() => connection.rpc.handle('api3', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
    })).toThrow('invalid or reserved RPC channel')

    const removeLoopback = connection.rpc.handle('/loopback', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
    })
    const loopbackRoute = routes.find(candidate => candidate.path === '/loopback')!
    const publicResponse = fakeResponse()
    await loopbackRoute.handler(fakePost({ host: 'harness.example' }, '/loopback/read', {
      type: 'client-request', rpcId: 'rpc-public', method: 'read', payload: {},
    }), publicResponse.response)
    expect(publicResponse.state.status).toBe(403)
    await removeLoopback()
    await remove()
    await fiber.dispose()
    await identity.dispose()
  })
})

describe('connection node half over a real HTTP server', () => {
  /** Serve the registered prefix route from a real server and return its port. */
  async function serve(routes: WebRoute[]): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer((request, response) => {
      void routes[0]!.handler(request, response)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    return {
      port: address.port,
      close: () => new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined || error === null) resolve()
          else reject(error)
        })
      }),
    }
  }

  /** One real request; `host` spoofs the authority the way a LAN client's browser would send it. */
  function call(port: number, method: string, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port, path: `${API_PATH}/${method}`, method: 'GET', headers: { host } },
        (response) => {
          response.resume()
          response.on('end', () => { resolve(response.statusCode ?? 0) })
        },
      )
      request.on('error', reject)
      request.end()
    })
  }

  it('answers a declared LAN authority with 403 on every configuration method, over real HTTP', async () => {
    // The fence's input is a real IncomingMessage parsed by Node from the
    // wire, not a hand-assembled object: the Host header a LAN browser sends
    // is exactly what decides loopback-only here, so the boundary is asserted
    // against the parse the server actually performs.
    const { routes, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    const { port, close } = await serve(routes)
    try {
      // Reads are as privileged as writes: describe returns the exposed
      // configuration, and credentials.describe probes arbitrary env-var names.
      for (const method of [
        'settings.describe', 'settings.openDocument', 'settings.update', 'settings.replace', 'settings.mutate',
        'credentials.describe', 'credentials.set', 'credentials.unset',
        'host.pickDirectory', 'host.openPath',
        // Carries a draft credential and turns the host into a fetcher for a
        // URL the caller picked: an anonymous LAN caller must not reach it.
        'llm.discoverModels',
        'agentPreset.read', 'agentPreset.copy', 'agentPreset.openDocument', 'agentPreset.remove',
      ]) {
        expect([method, await call(port, method, 'harness.example')]).toEqual([method, 403])
      }
      // The model catalog stays reachable for the same authority: a LAN
      // client's model picker needs it, and it carries no key or endpoint
      // state (404 is the empty proxy's carrier answer — the fence passed).
      // `agentPreset.list` joins the model catalog for the same reason: ids and
      // trust only, and a LAN client's preset picker needs it. `select` is
      // reachable too: `session.create` already takes an `agentPreset`, and the
      // deployment's own default already carries bash, so pinning the switch
      // would be a fence beside an open gate.
      for (const method of ['llm.providers', 'llm.models', 'agentPreset.list', 'agentPreset.select']) {
        expect([method, await call(port, method, 'harness.example')]).toEqual([method, 404])
      }
      // Loopback reaches everything, configuration included.
      expect(await call(port, 'settings.describe', `127.0.0.1:${String(port)}`)).toBe(404)
    } finally {
      await close()
      await dispose()
    }
  })
})
