import { createServer, type Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import KafkaService, { KafkaError } from '@deepseek-ai/dsh-kafka'

interface TcpPeer {
  endpoint: string
  stop(): Promise<void>
}

async function startPeer(onConnection: (socket: Socket) => void): Promise<TcpPeer> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
    onConnection(socket)
  })
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => { reject(error) }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('TCP test peer has no port')
  return {
    endpoint: `127.0.0.1:${address.port}`,
    async stop(): Promise<void> {
      for (const socket of sockets) socket.destroy()
      if (!server.listening) return
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    },
  }
}

describe('KafkaService real dependency failures', () => {
  it('bounds metadata when a connected TCP peer never sends a Kafka response', async () => {
    const peer = await startPeer((socket) => { socket.resume() })
    const ctx = new Context()
    const fiber = ctx.plugin(KafkaService, {
      binding: 'silent-peer',
      brokers: [peer.endpoint],
      clientId: 'dsh-kafka-dependency-test',
      tls: false,
      requestTimeoutMs: 100,
      connectionTimeoutMs: 1_000,
      retries: 0,
      retryDelayMs: 0,
    })
    const startedAt = Date.now()
    try {
      const failure = await Promise.resolve(fiber).catch((cause: unknown) => cause)
      expect(failure).toBeInstanceOf(KafkaError)
      expect(failure).toMatchObject({ code: 'timeout', binding: 'silent-peer' })
      expect(Date.now() - startedAt).toBeLessThan(2_000)
    } finally {
      await fiber.dispose()
      await peer.stop()
    }
  })

  it('classifies retried connection failures from the real client aggregate', async () => {
    const peer = await startPeer((socket) => { socket.destroy() })
    const ctx = new Context()
    const fiber = ctx.plugin(KafkaService, {
      binding: 'reset-peer',
      brokers: [peer.endpoint],
      clientId: 'dsh-kafka-dependency-test',
      tls: false,
      requestTimeoutMs: 2_000,
      connectionTimeoutMs: 500,
      retries: 1,
      retryDelayMs: 1,
    })
    try {
      const failure = await Promise.resolve(fiber).catch((cause: unknown) => cause)
      expect(failure).toBeInstanceOf(KafkaError)
      expect(failure).toMatchObject({ code: 'unavailable', binding: 'reset-peer' })
    } finally {
      await fiber.dispose()
      await peer.stop()
    }
  })
})
