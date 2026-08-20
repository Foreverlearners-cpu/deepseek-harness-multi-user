import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type {
  ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { HOST_EVENTS_PATH, MUX_EVENTS_PATH } from '../src/api-path.ts'
import { WebSocketDownlinks } from '../src/websocket-downlink.ts'

type MuxSource = (signal: AbortSignal) => AsyncIterable<RpcRequest<MuxFrame>>
type HostSource = (signal: AbortSignal) => AsyncIterable<RpcRequest<HostFrame>>
type DownlinkLease = NonNullable<Parameters<WebSocketDownlinks['handleMux']>[3]>

const running: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map(close => close()))
})

function untilAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

async function * idle<F>(signal: AbortSignal): AsyncGenerator<RpcRequest<F>> {
  await untilAbort(signal)
}

function api(mux: MuxSource, host: HostSource): ApiProxy {
  return {
    events: {
      mux: (_request, signal) => mux(signal),
      host: (_request, signal) => host(signal),
    },
  } as ApiProxy
}

async function serve(
  downlinks: WebSocketDownlinks,
  leaseFor: (pathname: string) => DownlinkLease | undefined = () => undefined,
): Promise<{
  origin: string
  close: () => Promise<void>
}> {
  const server = createServer()
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
    const lease = leaseFor(pathname)
    if (pathname === MUX_EVENTS_PATH) downlinks.handleMux(request, socket, head, lease)
    else if (pathname === HOST_EVENTS_PATH) downlinks.handleHost(request, socket, head, lease)
    else socket.destroy()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: `ws://127.0.0.1:${String(port)}`,
    close: async () => {
      await downlinks.close()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    },
  }
}

function read(socket: WebSocket): Promise<ServerRequest> {
  return once(socket, 'message').then(([data]) => JSON.parse(String(data)) as ServerRequest)
}

async function acceptedSocket(downlinks: WebSocketDownlinks): Promise<WebSocket> {
  const server = (downlinks as unknown as { server: { clients: Set<WebSocket> } }).server
  let accepted: WebSocket | undefined
  await vi.waitFor(() => {
    accepted = server.clients.values().next().value
    expect(accepted).toBeDefined()
  })
  return accepted as WebSocket
}

describe('WebSocket downlinks', () => {
  it('carries mux and host over independent downstream sockets and cancels each source on close', async () => {
    let muxAborted = false
    let hostAborted = false
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        try {
          yield {
            rpcId: RpcId('mux-1'),
            payload: { type: 'session/subscribed', sessionId: 'session-1' as never, lastSeq: 4 },
          }
          await untilAbort(signal)
        } finally {
          muxAborted = true
        }
      },
      async function * (signal) {
        try {
          yield { rpcId: RpcId('host-1'), payload: { type: 'host/remote-event', event: 'commands/change', args: [] } }
          await untilAbort(signal)
        } finally {
          hostAborted = true
        }
      },
    ))
    const host = await serve(downlinks)
    running.push(host.close)

    const mux = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const hostSocket = new WebSocket(`${host.origin}${HOST_EVENTS_PATH}`)
    const muxFrame = read(mux)
    const hostFrame = read(hostSocket)
    expect(await muxFrame).toEqual({
      type: 'server-request',
      rpcId: 'mux-1',
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 4 },
    })
    expect(await hostFrame).toEqual({
      type: 'server-request',
      rpcId: 'host-1',
      method: 'host/remote-event',
      payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
    })

    const muxClosed = once(mux, 'close')
    const hostClosed = once(hostSocket, 'close')
    mux.close()
    hostSocket.close()
    await Promise.all([muxClosed, hostClosed])
    await vi.waitFor(() => {
      expect(muxAborted).toBe(true)
      expect(hostAborted).toBe(true)
    })
  })

  it('revokes one socket with 1008, releases once, and leaves the acceptor available', async () => {
    const sourceSignals: AbortSignal[] = []
    const mux = vi.fn((signal: AbortSignal) => {
      sourceSignals.push(signal)
      return idle<MuxFrame>(signal)
    })
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const firstRelease = vi.fn()
    const secondRelease = vi.fn()
    const leases: DownlinkLease[] = [
      { signal: firstAbort.signal, release: firstRelease },
      { signal: secondAbort.signal, release: secondRelease },
    ]
    const downlinks = new WebSocketDownlinks(api(mux, idle))
    const host = await serve(downlinks, pathname => pathname === MUX_EVENTS_PATH ? leases.shift() : undefined)
    running.push(host.close)

    const revoked = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(revoked, 'open')
    await vi.waitFor(() => { expect(mux).toHaveBeenCalledTimes(1) })
    const revokedClosed = once(revoked, 'close')
    firstAbort.abort(new Error('policy changed'))
    const [code, reason] = await revokedClosed as [number, Buffer]
    expect(code).toBe(1008)
    expect(String(reason)).toBe('authorization revoked')
    await vi.waitFor(() => {
      expect(sourceSignals[0]?.aborted).toBe(true)
      expect(firstRelease).toHaveBeenCalledTimes(1)
    })

    const fresh = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(fresh, 'open')
    await vi.waitFor(() => { expect(mux).toHaveBeenCalledTimes(2) })
    expect(sourceSignals[1]?.aborted).toBe(false)
    expect(secondAbort.signal.aborted).toBe(false)
    const freshClosed = once(fresh, 'close')
    fresh.close()
    await freshClosed
    await vi.waitFor(() => { expect(secondRelease).toHaveBeenCalledTimes(1) })
    expect(firstRelease).toHaveBeenCalledTimes(1)
  })

  it('does not open a source for a lease already revoked before upgrade', async () => {
    const leaseAbort = new AbortController()
    leaseAbort.abort(new Error('already stale'))
    const release = vi.fn()
    const mux = vi.fn((signal: AbortSignal) => idle<MuxFrame>(signal))
    const downlinks = new WebSocketDownlinks(api(mux, idle))
    const host = await serve(downlinks, pathname => pathname === MUX_EVENTS_PATH
      ? { signal: leaseAbort.signal, release }
      : undefined)
    running.push(host.close)

    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const [code, reason] = await once(socket, 'close') as [number, Buffer]
    expect(code).toBe(1008)
    expect(String(reason)).toBe('authorization revoked')
    expect(mux).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('releases an owned lease when WebSocket negotiation throws synchronously', async () => {
    const release = vi.fn()
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    const server = (downlinks as unknown as {
      server: { handleUpgrade: (...args: unknown[]) => void }
    }).server
    const handleUpgrade = vi.spyOn(server, 'handleUpgrade').mockImplementation(() => {
      throw new Error('upgrade failed')
    })

    expect(() => {
      downlinks.handleMux(
        {} as Parameters<WebSocketDownlinks['handleMux']>[0],
        new PassThrough(),
        Buffer.alloc(0),
        { signal: new AbortController().signal, release },
      )
    }).toThrow('upgrade failed')
    expect(release).toHaveBeenCalledTimes(1)
    handleUpgrade.mockRestore()
    await downlinks.close()
  })

  it('rejects client messages because upstream remains HTTP', async () => {
    let aborted = false
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        try {
          await untilAbort(signal)
        } finally {
          aborted = true
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.send('upstream payload')
    const [code, reason] = await closed as [number, Buffer]
    expect(code).toBe(1008)
    expect(String(reason)).toBe('downlink only')
    await vi.waitFor(() => { expect(aborted).toBe(true) })
  })

  it('sends stream/error before closing when a source fails', async () => {
    const downlinks = new WebSocketDownlinks(api(
      async function * () {
        throw new Error('mux source failed')
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    const failure = read(socket)
    const closed = once(socket, 'close')
    expect((await failure).payload).toEqual({
      type: 'stream/error',
      error: { code: 'internal', message: 'handler failure', details: {} },
    })
    await closed
  })

  it('aborts the source when an accepted socket reports a transport error', async () => {
    let aborted = false
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        try {
          await untilAbort(signal)
        } finally {
          aborted = true
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const accepted = await acceptedSocket(downlinks)
    const closed = once(socket, 'close')
    accepted.emit('error', new Error('transport failed'))
    await closed
    expect(aborted).toBe(true)
  })

  it('drops a source frame that races after the client has closed', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let finish!: () => void
    const finished = new Promise<void>((resolve) => { finish = resolve })
    let sourceSignal: AbortSignal | undefined
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        sourceSignal = signal
        try {
          await gate
          yield {
            rpcId: RpcId('late'),
            payload: { type: 'session/subscribed', sessionId: 'session-late' as never, lastSeq: 0 },
          }
        } finally {
          finish()
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const closed = once(socket, 'close')
    socket.close()
    await closed
    await vi.waitFor(() => { expect(sourceSignal?.aborted).toBe(true) })
    release()
    await finished
  })

  it('contains socket send callback failures and closes the downlink', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const downlinks = new WebSocketDownlinks(api(
      async function * () {
        await gate
        yield {
          rpcId: RpcId('send-failure'),
          payload: { type: 'session/subscribed', sessionId: 'session-send' as never, lastSeq: 0 },
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    running.push(host.close)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    const accepted = await acceptedSocket(downlinks)
    const send = vi.spyOn(accepted, 'send').mockImplementation(((
      _data: unknown,
      optionsOrCallback?: unknown,
      callback?: (error?: Error) => void,
    ) => {
      const done = typeof optionsOrCallback === 'function'
        ? optionsOrCallback as (error?: Error) => void
        : callback
      done?.(new Error('socket send failed'))
    }) as WebSocket['send'])
    const closed = once(socket, 'close')
    release()
    await closed
    expect(send).toHaveBeenCalledTimes(2)
    send.mockRestore()
  })

  it('rejects when its acceptor has already closed', async () => {
    const downlinks = new WebSocketDownlinks(api(idle, idle))
    await downlinks.close()
    await expect(downlinks.close()).rejects.toThrow('The server is not running')
  })

  it('waits for source cleanup before teardown resolves', async () => {
    let cleanupStarted!: () => void
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve })
    let releaseCleanup!: () => void
    const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve })
    let cleaned = false
    const downlinks = new WebSocketDownlinks(api(
      async function * (signal) {
        try {
          await untilAbort(signal)
        } finally {
          cleanupStarted()
          await cleanupGate
          cleaned = true
        }
      },
      idle,
    ))
    const host = await serve(downlinks)
    const socket = new WebSocket(`${host.origin}${MUX_EVENTS_PATH}`)
    await once(socket, 'open')
    let closed = false
    const closing = host.close().then(() => { closed = true })
    try {
      await started
      expect(closed).toBe(false)
      releaseCleanup()
      await closing
      expect(cleaned).toBe(true)
    } finally {
      releaseCleanup()
      await closing
    }
  })
})
