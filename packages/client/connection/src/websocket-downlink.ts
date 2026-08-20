/** Host-side WebSocket carrier for the two server-to-browser event streams. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import type {
  ApiProxy, HostFrame, MuxFrame, RpcRequest, ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ApiProxySecurityLease } from '@deepseek-ai/dsh-host-apiproxy'

type Frame = MuxFrame | HostFrame

const AUTHORIZATION_REVOKED_CLOSE_CODE = 1008
const AUTHORIZATION_REVOKED_REASON = 'authorization revoked'

function serverRequest(frame: RpcRequest<Frame>): ServerRequest {
  return {
    type: 'server-request',
    rpcId: frame.rpcId,
    method: frame.payload.type,
    payload: frame.payload,
  }
}

function send(socket: WebSocket, frame: RpcRequest<Frame>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('websocket downlink closed before frame delivery'))
      return
    }
    socket.send(JSON.stringify(serverRequest(frame)), (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function failureFrame(error: unknown): RpcRequest<Frame> {
  void error
  return {
    rpcId: RpcId(randomUUID()),
    payload: {
      type: 'stream/error',
      error: { code: 'internal', message: 'handler failure', details: {} },
    },
  }
}

/**
 * Owns WebSocket negotiation and frame pumping for the connection plugin's
 * two downlinks. Client messages are a protocol violation: upstream traffic
 * remains on HTTP.
 */
export class WebSocketDownlinks {
  private readonly server = new WebSocketServer({ noServer: true })
  private readonly pumps = new Set<Promise<void>>()

  /** @param api - host API supplying the typed event streams. */
  constructor(private readonly api: ApiProxy) {}

  /**
   * Upgrade one socket and pump the mux stream until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - Raw socket transferred by the HTTP server.
   * @param head - Bytes already read after the upgrade headers.
   * @param lease - Authorization lifetime transferred by the upgrade boundary.
   */
  handleMux(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    lease?: ApiProxySecurityLease,
  ): void {
    this.upgrade(req, socket, head, lease, signal => this.api.events.mux({
      rpcId: RpcId(randomUUID()),
      payload: {},
    }, signal))
  }

  /**
   * Upgrade one socket and pump the host stream until either side closes.
   * @param req - HTTP upgrade request.
   * @param socket - Raw socket transferred by the HTTP server.
   * @param head - Bytes already read after the upgrade headers.
   * @param lease - Authorization lifetime transferred by the upgrade boundary.
   */
  handleHost(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    lease?: ApiProxySecurityLease,
  ): void {
    this.upgrade(req, socket, head, lease, signal => this.api.events.host({
      rpcId: RpcId(randomUUID()),
      payload: {},
    }, signal))
  }

  /**
   * Terminate owned sockets and await the no-server acceptor plus frame pumps.
   * @returns A promise resolving after every socket and source iterator stops.
   */
  async close(): Promise<void> {
    for (const socket of this.server.clients) socket.terminate()
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    await Promise.all(this.pumps)
  }

  private upgrade<F extends Frame>(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    lease: ApiProxySecurityLease | undefined,
    open: (signal: AbortSignal) => AsyncIterable<RpcRequest<F>>,
  ): void {
    const abort = new AbortController()
    let websocket: WebSocket | undefined
    let released = false
    const onLeaseAbort = (): void => {
      abort.abort(lease?.signal.reason)
      if (websocket?.readyState === WebSocket.OPEN) {
        websocket.close(AUTHORIZATION_REVOKED_CLOSE_CODE, AUTHORIZATION_REVOKED_REASON)
      }
    }
    const releaseLease = (): void => {
      if (released) return
      released = true
      lease?.signal.removeEventListener('abort', onLeaseAbort)
      lease?.release()
    }
    lease?.signal.addEventListener('abort', onLeaseAbort, { once: true })
    if (lease?.signal.aborted) onLeaseAbort()

    try {
      this.server.handleUpgrade(req, socket, head, (upgraded) => {
        websocket = upgraded
        if (lease?.signal.aborted) {
          try {
            onLeaseAbort()
          } finally {
            releaseLease()
          }
          return
        }
        upgraded.once('close', () => { abort.abort() })
        upgraded.once('error', () => { abort.abort() })
        upgraded.once('message', () => {
          upgraded.close(1008, 'downlink only')
        })
        const pump = this.pump(upgraded, open, abort, releaseLease)
        this.pumps.add(pump)
        void pump.then(() => { this.pumps.delete(pump) })
      })
    } catch (error) {
      abort.abort()
      releaseLease()
      throw error
    }
  }

  private async pump<F extends Frame>(
    socket: WebSocket,
    open: (signal: AbortSignal) => AsyncIterable<RpcRequest<F>>,
    abort: AbortController,
    releaseLease: () => void,
  ): Promise<void> {
    try {
      for await (const frame of open(abort.signal)) await send(socket, frame)
    } catch (error) {
      if (!abort.signal.aborted) {
        try {
          await send(socket, failureFrame(error))
        } catch {
          // Socket loss won the race; no downstream remains to receive the failure frame.
        }
      }
    } finally {
      abort.abort()
      if (socket.readyState === WebSocket.OPEN) socket.close()
      releaseLease()
    }
  }
}

/**
 * Reject an untrusted upgrade before protocol negotiation.
 * @param socket - Raw HTTP socket that remains owned by the caller.
 * @param status - Authentication or authorization refusal status.
 */
export function rejectWebSocketUpgrade(socket: Duplex, status: 401 | 403 = 403): void {
  const unauthorized = status === 401
  const reason = unauthorized ? 'Unauthorized' : 'Forbidden'
  const body = unauthorized ? 'unauthorized' : 'forbidden'
  socket.end([
    `HTTP/1.1 ${String(status)} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}
