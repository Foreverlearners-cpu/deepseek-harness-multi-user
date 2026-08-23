import { Context, Service } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import MysqlSessionPersistence from '../src/index.ts'
import { StubUsers } from './helpers/stub-users.ts'

interface FakeSessionRow {
  session_id: string
  next_seq: number
  owner_kind: string
  owner_id: string
  revision: number
}

/** Minimal driver-shaped connection used to exercise transaction behavior without MySQL. */
class FakeConnection {
  readonly operations: string[] = []
  readonly records: unknown[][] = []
  private readonly sessions = new Map<string, FakeSessionRow>()

  plantSession(row: FakeSessionRow): void {
    this.sessions.set(row.session_id, { ...row })
  }

  nextSeq(id: string): number | undefined {
    return this.sessions.get(id)?.next_seq
  }

  async beginTransaction(): Promise<void> {
    this.operations.push('begin')
  }

  async commit(): Promise<void> {
    this.operations.push('commit')
  }

  async rollback(): Promise<void> {
    this.operations.push('rollback')
  }

  async query(sql: string, params: unknown[] = []): Promise<[unknown, unknown?]> {
    if (sql.includes('information_schema.columns')) return [[], undefined]
    if (sql.includes('dsh_session_persistence_state')) {
      if (sql.trimStart().startsWith('SELECT')) return [[{ schema_version: 3 }], undefined]
      return [[], undefined]
    }
    if (sql.includes('CREATE TABLE')) return [[], undefined]
    if (sql.includes('FOR UPDATE')) {
      const [id] = params as [string]
      const row = this.sessions.get(id)
      return [row ? [row] : [], undefined]
    }
    if (sql.includes('FOR SHARE')) return [[], undefined]
    if (sql.includes('INSERT INTO dsh_session_persistence_sessions')) {
      const [id, , , , , , , , , , , ownerId] = params as unknown[]
      this.sessions.set(String(id), {
        session_id: String(id),
        next_seq: 0,
        owner_kind: 'user',
        owner_id: String(ownerId),
        revision: 0,
      })
      return [[], undefined]
    }
    if (sql.includes('INSERT INTO dsh_session_persistence_records')) {
      this.records.push(params)
      return [[], undefined]
    }
    if (sql.includes('UPDATE dsh_session_persistence_sessions')) {
      const [nextSeq, , id] = params as [number, number, string]
      const row = this.sessions.get(id)
      if (row) this.sessions.set(id, { ...row, next_seq: nextSeq, revision: row.revision + 1 })
      return [[], undefined]
    }
    return [[], undefined]
  }
}

/** Cordis service stand-in for `ctx.mysql` exposing only the upstream `connection` lease. */
class FakeMysql extends Service {
  constructor(ctx: Context, config: { lease: FakeConnection }) {
    super(ctx, 'mysql')
    this.lease = config.lease
  }

  readonly lease: FakeConnection

  connection<T>(callback: (connection: FakeConnection) => T | Promise<T>): Promise<T> {
    return Promise.resolve(callback(this.lease))
  }
}

const contexts: Context[] = []

async function boot(ownerUserId = 'alice'): Promise<{
  ctx: Context
  service: MysqlSessionPersistence
  connection: FakeConnection
}> {
  const ctx = new Context()
  contexts.push(ctx)
  const connection = new FakeConnection()
  await ctx.plugin(SessionStore)
  await ctx.plugin(FakeMysql, { lease: connection })
  await ctx.plugin(StubUsers, { active: ownerUserId })
  const service = new MysqlSessionPersistence(ctx, { ownerUserId })
  return { ctx, service, connection }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) {
    await ctx.fiber.dispose()
  }
})

function header(id: SessionId, createdAt = Date.now()): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id, createdAt }
}

describe('MySQL session persistence transaction behavior', () => {
  it('appends events inside one transaction and commits', async () => {
    const { service, connection } = await boot()
    const id = SessionId('session-1')
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    await service.appendBatch(header(id), events, false)
    expect(connection.operations).toEqual(['begin', 'commit'])
    expect(connection.nextSeq(id)).toBe(2)
    expect(connection.records).toHaveLength(2)
  })

  it('rolls back and rejects when the expected sequence does not match', async () => {
    const { service, connection } = await boot()
    const id = SessionId('session-2')
    connection.plantSession({ session_id: id, next_seq: 5, owner_kind: 'user', owner_id: 'alice', revision: 0 })
    const events: SessionEvent[] = [{ type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } }]
    await expect(service.appendBatch(header(id), events, false)).rejects.toThrow(/expected seq 5/)
    expect(connection.operations).toEqual(['begin', 'rollback'])
    expect(connection.nextSeq(id)).toBe(5)
  })

  it('rejects appends to a session owned by another user', async () => {
    const { service, connection } = await boot()
    const id = SessionId('session-3')
    connection.plantSession({ session_id: id, next_seq: 0, owner_kind: 'user', owner_id: 'bob', revision: 0 })
    const events: SessionEvent[] = [{ type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } }]
    await expect(service.appendBatch(header(id), events, false)).rejects.toThrow(/not found/)
    expect(connection.operations).toEqual(['begin', 'rollback'])
  })
})
