/**
 * User-scoped MySQL SessionPersistence provider. It delegates buffering and
 * recovery orchestration to PersistenceCoordinator and stores packed logical
 * event records in MySQL.
 * @module @deepseek-ai/dsh-session-persistence-mysql
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { gzipSync, gunzipSync } from 'node:zlib'
import { createHash, randomUUID } from 'node:crypto'
import { decodeStorageRecord, packChunkRuns } from '@deepseek-ai/dsh-session'
import type { ChunkRow, SessionEvent, SessionId, SessionHeader, SessionPreparation, StorageRecord } from '@deepseek-ai/dsh-session'
import { UserId } from '@deepseek-ai/dsh-user'
import type { UserId as UserIdType } from '@deepseek-ai/dsh-user'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE, DEFAULT_WRITE_BATCH_MAX_DELAY_MS, MAX_WRITE_BATCH_DELAY_MS,
  PersistenceCoordinator, SessionPersistence, SessionPersistenceRevision,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  PersistenceBackend, SessionInspection, SessionLocation, SessionPersistenceSnapshot,
  SessionPersistenceRevision as PersistenceRevision, StoredPrefix, StoredSuffix,
} from '@deepseek-ai/dsh-session-persistence'
import { ensureSchema, RECORDS_TABLE, SCHEMA_VERSION, SESSIONS_TABLE, type RecordRow, type SessionRow } from './schema.ts'

/** MySQL session persistence configuration. One provider instance owns one user scope. */
export interface Config {
  /** Trusted authenticated user identity for this provider instance. */
  ownerUserId: string
  /** Maximum cold preparations retained by the coordinator. */
  preparedSessionCacheSize?: number
  /** Maximum intentional write-behind delay. */
  writeBatchMaxDelayMs?: number
}

interface EncodedRecord {
  seqFrom: number
  seqTo: number
  recordKind: 'event' | 'chunk_pack'
  eventType: string
  codec: 'json' | 'gzip-json'
  payload: Buffer
  eventCount: number
  checksum: Buffer
}

function isChunkRow(record: StorageRecord): record is ChunkRow {
  return record.type === 'text-chunks'
    || record.type === 'reasoning-chunks'
    || record.type === 'tool-call-chunks'
}

function eventCount(record: StorageRecord): number {
  return isChunkRow(record) ? decodeStorageRecord(record).length : 1
}

function firstSeq(record: StorageRecord): number {
  return isChunkRow(record) ? record.seq0 : record.seq
}

function encodeRecord(record: StorageRecord): EncodedRecord {
  const plain = Buffer.from(JSON.stringify(record), 'utf8')
  const count = eventCount(record)
  const seqFrom = firstSeq(record)
  return {
    seqFrom,
    seqTo: seqFrom + count - 1,
    recordKind: isChunkRow(record) ? 'chunk_pack' : 'event',
    eventType: record.type,
    codec: isChunkRow(record) ? 'gzip-json' : 'json',
    payload: isChunkRow(record) ? gzipSync(plain) : plain,
    eventCount: count,
    checksum: createHash('sha256').update(plain).digest(),
  }
}

function payloadBuffer(payload: Buffer | string): Buffer {
  return Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
}

function decodeRecord(row: RecordRow): SessionEvent[] {
  const compressed = payloadBuffer(row.payload)
  const plain = row.codec === 'gzip-json' ? gunzipSync(compressed) : compressed
  const checksum = createHash('sha256').update(plain).digest()
  const expected = payloadBuffer(row.checksum)
  if (!checksum.equals(expected)) {
    throw new Error(`corrupt MySQL session record at seq ${row.seq_from}: checksum mismatch`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(plain.toString('utf8'))
  } catch (error: unknown) {
    throw new Error(`corrupt MySQL session record at seq ${row.seq_from}: payload is not JSON`, { cause: error })
  }
  const events = decodeStorageRecord(parsed)
  if (events.length !== row.event_count || events[0]?.seq !== row.seq_from
    || events.at(-1)?.seq !== row.seq_to) {
    throw new Error(`corrupt MySQL session record at seq ${row.seq_from}: sequence range mismatch`)
  }
  return events
}

function metaFromRow(row: SessionRow): SessionHeader {
  if (row.owner_kind !== 'user' || row.owner_id.length === 0) {
    throw new Error(`MySQL session "${row.session_id}" has no supported user owner`)
  }
  return {
    version: row.version,
    id: row.session_id as SessionId,
    createdAt: row.created_at,
    ...row.cwd === null ? {} : { cwd: row.cwd },
    ...row.parent_session_id === null ? {} : { parentSession: row.parent_session_id as SessionId },
    ...row.seed_length === null ? {} : { seedLength: row.seed_length },
    ...row.origin === null ? {} : { origin: row.origin },
    ...row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth },
    ...row.agent_preset === null ? {} : { agentPreset: row.agent_preset },
  }
}

function revision(row: SessionRow): PersistenceRevision {
  return SessionPersistenceRevision(
    `mysql:incarnation:${row.incarnation}:revision:${row.revision}`,
  )
}

/** MySQL-backed SessionPersistence provider. */
export class MysqlSessionPersistence extends SessionPersistence implements PersistenceBackend<undefined> {
  override readonly supportsRawArtifacts = false

  static inject = ['sessions', 'mysql', 'users']

  static Config: z<Config> = z.object({
    ownerUserId: z.string().min(1).max(128),
    preparedSessionCacheSize: z.number().step(1).min(1).default(DEFAULT_PREPARED_SESSION_CACHE_SIZE),
    writeBatchMaxDelayMs: z.number().step(1).min(1).max(MAX_WRITE_BATCH_DELAY_MS)
      .default(DEFAULT_WRITE_BATCH_MAX_DELAY_MS),
  })

  override readonly name = 'session-persistence-mysql'

  private readonly ownerUserId: UserIdType
  private readonly coordinator: PersistenceCoordinator<undefined>
  private readonly ready: Promise<void>

  constructor(ctx: Context, public config: Config) {
    super(ctx)
    this.ownerUserId = UserId(config.ownerUserId)
    this.ready = this.initialize()
    this.coordinator = new PersistenceCoordinator<undefined>(this.ctx, this, {
      preparedSessionCacheSize: config.preparedSessionCacheSize ?? DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: config.writeBatchMaxDelayMs ?? DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    })
  }

  /** Finish schema initialization before Cordis exposes the persistence service. */
  async [Service.init](): Promise<void> {
    await this.ready
  }

  private async initialize(): Promise<void> {
    await this.ctx.mysql.connection(async connection => ensureSchema(connection))
    await this.ctx.users.requireActive(this.ownerUserId)
  }

  locate(_meta: SessionHeader): SessionLocation | undefined {
    return undefined
  }

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }
  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> { return this.coordinator.append(id, events) }
  override prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation> { return this.coordinator.prepare(id, signal) }
  load(id: SessionId): Promise<SessionInspection> { return this.coordinator.load(id) }
  inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> { return this.coordinator.inspect(id, signal) }
  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<undefined> | undefined> {
    signal?.throwIfAborted()
    await this.ready
    const [sessionRows] = await this.ctx.mysql.connection(connection => connection.query<SessionRow[]>(
      `SELECT * FROM ${SESSIONS_TABLE}
       WHERE session_id = ? AND owner_kind = 'user' AND owner_id = ?`,
      [id, this.ownerUserId],
    ))
    signal?.throwIfAborted()
    const row = sessionRows[0]
    if (row === undefined) return undefined
    const [recordRows] = await this.ctx.mysql.connection(connection => connection.query<RecordRow[]>(
      `SELECT * FROM ${RECORDS_TABLE} WHERE session_id = ? ORDER BY seq_from`,
      [id],
    ))
    const events = this.decodeRows(recordRows, id, 0)
    return { meta: metaFromRow(row), events, revision: revision(row) }
  }

  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<PersistenceRevision | undefined> {
    signal?.throwIfAborted()
    await this.ready
    const [rows] = await this.ctx.mysql.connection(connection => connection.query<SessionRow[]>(
      `SELECT * FROM ${SESSIONS_TABLE}
       WHERE session_id = ? AND owner_kind = 'user' AND owner_id = ?`,
      [id, this.ownerUserId],
    ))
    signal?.throwIfAborted()
    return rows[0] === undefined ? undefined : revision(rows[0])
  }

  async loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    signal?.throwIfAborted()
    await this.ready
    const [sessionRows] = await this.ctx.mysql.connection(connection => connection.query<SessionRow[]>(
      `SELECT * FROM ${SESSIONS_TABLE}
       WHERE session_id = ? AND owner_kind = 'user' AND owner_id = ?`,
      [id, this.ownerUserId],
    ))
    const row = sessionRows[0]
    if (row === undefined) return undefined
    const [recordRows] = await this.ctx.mysql.connection(connection => connection.query<RecordRow[]>(
      `SELECT * FROM ${RECORDS_TABLE}
       WHERE session_id = ? AND seq_to >= ? ORDER BY seq_from`,
      [id, fromSeq],
    ))
    return {
      meta: metaFromRow(row),
      events: this.decodeRows(recordRows, id, recordRows[0]?.seq_from ?? fromSeq)
        .filter(event => event.seq >= fromSeq),
    }
  }

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    await this.ready
    if (events.length === 0) return
    await this.ctx.users.requireActive(this.ownerUserId)
    const records = packChunkRuns(events).map(encodeRecord)
    await this.ctx.mysql.connection(async (connection) => {
      await connection.beginTransaction()
      try {
        const [existingRows] = await connection.query<SessionRow[]>(
          `SELECT * FROM ${SESSIONS_TABLE} WHERE session_id = ? FOR UPDATE`,
          [meta.id],
        )
        const row = existingRows[0]
        if (row === undefined) {
          if (isMaterialized) throw new Error(`MySQL session "${meta.id}" is missing its materialized row`)
          if (meta.parentSession !== undefined) {
            const [parents] = await connection.query<SessionRow[]>(
              `SELECT owner_kind, owner_id FROM ${SESSIONS_TABLE}
               WHERE session_id = ? FOR SHARE`,
              [meta.parentSession],
            )
            const parent = parents[0]
            if (parent === undefined || parent.owner_kind !== 'user' || parent.owner_id !== this.ownerUserId) {
              throw new Error(`session "${meta.parentSession}" not found`)
            }
          }
          const now = Date.now()
          await connection.query(
            `INSERT INTO ${SESSIONS_TABLE}
             (session_id, version, created_at, updated_at, cwd, parent_session_id,
              seed_length, origin, delegation_depth, agent_preset, owner_kind, owner_id,
              incarnation, revision, next_seq)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user', ?, ?, 0, 0)`,
            [meta.id, meta.version, meta.createdAt, now, meta.cwd ?? null,
              meta.parentSession ?? null, meta.seedLength ?? null, meta.origin ?? null,
              meta.delegationDepth ?? null, meta.agentPreset ?? null, this.ownerUserId, randomUUID()],
          )
        } else {
          this.assertOwnedRow(row, meta.id)
          if (row.next_seq !== events[0]!.seq) {
            throw new Error(`MySQL session "${meta.id}" expected seq ${row.next_seq}, got ${events[0]!.seq}`)
          }
        }
        for (const record of records) {
          await connection.query(
            `INSERT INTO ${RECORDS_TABLE}
             (session_id, seq_from, seq_to, record_kind, event_type, codec,
              payload, event_count, checksum, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [meta.id, record.seqFrom, record.seqTo, record.recordKind,
              record.eventType, record.codec, record.payload, record.eventCount, record.checksum, Date.now()],
          )
        }
        const nextSeq = events.at(-1)!.seq + 1
        await connection.query(
          `UPDATE ${SESSIONS_TABLE} SET next_seq = ?, revision = revision + 1, updated_at = ?
           WHERE session_id = ?`,
          [nextSeq, Date.now(), meta.id],
        )
        await connection.commit()
      } catch (error: unknown) {
        try {
          await connection.rollback()
        } catch {
          // Preserve the original error; the upstream lease still restores the connection.
        }
        throw error
      }
    })
  }

  async commitRepair(meta: SessionHeader, _tornMarker: undefined, closers: readonly SessionEvent[]): Promise<void> {
    if (closers.length > 0) await this.appendBatch(meta, closers, true)
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    const snapshots = await this.listSnapshots(signal)
    return snapshots.map(snapshot => snapshot.header)
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    await this.ready
    const [rows] = await this.ctx.mysql.connection(connection => connection.query<SessionRow[]>(
      `SELECT * FROM ${SESSIONS_TABLE}
       WHERE owner_kind = 'user' AND owner_id = ?
       ORDER BY updated_at DESC, session_id`,
      [this.ownerUserId],
    ))
    signal?.throwIfAborted()
    return rows.map(row => ({ header: metaFromRow(row), revision: revision(row) }))
  }

  private decodeRows(rows: readonly RecordRow[], id: SessionId, expectedStart: number): SessionEvent[] {
    const events: SessionEvent[] = []
    for (const row of rows) {
      if (row.seq_from !== expectedStart + events.length) {
        throw new Error(`corrupt MySQL session "${id}": expected seq ${expectedStart + events.length}, got ${row.seq_from}`)
      }
      events.push(...decodeRecord(row))
    }
    return events
  }

  private assertOwnedRow(row: SessionRow, id: SessionId): void {
    if (row.owner_kind !== 'user' || row.owner_id !== this.ownerUserId) {
      throw new Error(`session "${id}" not found`)
    }
  }
}

export { SCHEMA_VERSION }
export default MysqlSessionPersistence
