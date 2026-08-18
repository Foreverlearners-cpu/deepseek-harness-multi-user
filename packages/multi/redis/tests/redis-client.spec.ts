import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Redis from '../src/index.ts'
import type { AddressInfo, Server, Socket } from 'node:net'

interface TcpFixture {
  readonly connectionCount: number
  readonly openSocketCount: number
  readonly url: string
  close(): Promise<void>
  dropConnections(): void
}

interface ParsedCommands {
  count: number
  rest: string
}

const contexts: Context[] = []
const fixtures: TcpFixture[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.allSettled(contexts.splice(0).map(async ctx => ctx.fiber.dispose()))
  await Promise.all(fixtures.splice(0).map(async fixture => fixture.close()))
})

function parseCommands(input: string): ParsedCommands {
  let count = 0
  let offset = 0

  while (offset < input.length) {
    const commandStart = offset
    const headerEnd = input.indexOf('\r\n', offset)
    if (headerEnd === -1) break
    const arity = Number(input.slice(offset + 1, headerEnd))
    let cursor = headerEnd + 2

    for (let index = 0; index < arity; index++) {
      const lengthEnd = input.indexOf('\r\n', cursor)
      if (lengthEnd === -1) return { count, rest: input.slice(commandStart) }
      const length = Number(input.slice(cursor + 1, lengthEnd))
      const argumentEnd = lengthEnd + 2 + length
      if (input.length < argumentEnd + 2) return { count, rest: input.slice(commandStart) }
      cursor = argumentEnd + 2
    }

    count++
    offset = cursor
  }

  return { count, rest: input.slice(offset) }
}

async function startFixture(onConnection: (socket: Socket) => void): Promise<TcpFixture> {
  const sockets = new Set<Socket>()
  let connectionCount = 0
  const server: Server = createServer((socket) => {
    connectionCount++
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    onConnection(socket)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  const fixture: TcpFixture = {
    get connectionCount() { return connectionCount },
    get openSocketCount() { return sockets.size },
    url: `redis://127.0.0.1:${port}`,
    dropConnections(): void {
      for (const socket of sockets) socket.destroy()
    },
    async close(): Promise<void> {
      fixture.dropConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    },
  }
  fixtures.push(fixture)
  return fixture
}

function newContext(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

describe('Redis with the real Node Redis client', () => {
  it('destroys a silent startup connection at the total deadline', async () => {
    const fixture = await startFixture((socket) => {
      socket.on('data', () => {})
    })
    const ctx = newContext()
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    await expect(ctx.plugin(Redis, {
      url: fixture.url,
      connectTimeoutMs: 50,
    })).rejects.toThrow('redis startup timed out after 50ms')

    expect(fixture.connectionCount).toBe(1)
    await vi.waitFor(() => {
      expect(fixture.openSocketCount).toBe(0)
    })
  })

  it('makes one connection attempt when the peer closes immediately', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fixture = await startFixture(socket => socket.destroy())
    const ctx = newContext()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})

    await expect(ctx.plugin(Redis, {
      url: fixture.url,
      connectTimeoutMs: 160,
    })).rejects.toThrow()

    expect(fixture.connectionCount).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('stays unavailable without reconnecting after an established socket drops', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let commandCount = 0
    const fixture = await startFixture((socket) => {
      let pending = ''
      socket.on('data', (chunk) => {
        pending += chunk.toString('utf8')
        const parsed = parseCommands(pending)
        pending = parsed.rest
        commandCount += parsed.count
        if (parsed.count > 0) socket.write('+PONG\r\n'.repeat(parsed.count))
      })
    })
    const ctx = newContext()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const fiber = ctx.plugin(Redis, {
      url: fixture.url,
      connectTimeoutMs: 500,
    })
    await fiber

    await expect(ctx.redis.withClient(client => client.ping())).resolves.toBe('PONG')
    expect(commandCount).toBeGreaterThanOrEqual(2)
    fixture.dropConnections()

    await vi.waitFor(async () => {
      await expect(ctx.redis.withClient(() => 'unreachable')).rejects.toThrow(/unavailable or closing/)
    })
    await fiber.dispose()
    const settledConnectionCount = fixture.connectionCount
    await delay(120)

    expect(settledConnectionCount).toBe(1)
    expect(fixture.connectionCount).toBe(settledConnectionCount)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
