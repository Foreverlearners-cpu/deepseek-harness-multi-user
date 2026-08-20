/** MySQL DDL and row vocabulary owned by the MySQL session persistence Consumer. */

import { randomUUID } from 'node:crypto'
import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import type { RowDataPacket } from 'mysql2'

/** User-id-only schema version accepted by this provider. */
export const SCHEMA_VERSION = 3

/** Singleton table recording ownership and schema version. */
export const STATE_TABLE = 'dsh_session_persistence_state'
/** User-owned session metadata table. */
export const SESSIONS_TABLE = 'dsh_session_persistence_sessions'
/** User-owned immutable packed-record table. */
export const RECORDS_TABLE = 'dsh_session_persistence_records'
/** Table owned by the user provider; used only for the relational owner FK. */
const USERS_TABLE = 'dsh_users'

/** Row returned from the user-owned session metadata table. */
export interface SessionRow extends RowDataPacket {
  session_id: string
  version: number
  created_at: number
  updated_at: number
  cwd: string | null
  parent_session_id: string | null
  seed_length: number | null
  origin: 'subagent' | null
  delegation_depth: number | null
  agent_preset: string | null
  owner_kind: 'user' | string
  owner_id: string
  incarnation: string
  revision: number
  next_seq: number
}

/** Row returned from the user-owned immutable record table. */
export interface RecordRow extends RowDataPacket {
  session_id: string
  seq_from: number
  seq_to: number
  record_kind: 'event' | 'chunk_pack'
  event_type: string
  codec: 'json' | 'gzip-json'
  payload: Buffer | string
  event_count: number
  checksum: Buffer | string
}

/**
 * Create or upgrade the schema and verify the persisted version marker.
 * @param connection - callback-scoped MySQL connection owned by `dsh-mysql`.
 */
export async function ensureSchema(connection: MysqlConnection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
      singleton TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      store_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      schema_version INT UNSIGNED NOT NULL,
      CHECK (singleton = 1)
    ) ENGINE = InnoDB
  `)
  const [legacySessionColumns] = await connection.query<RowDataPacket[]>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name IN (?, ?) AND column_name = 'tenant_id'`,
    [SESSIONS_TABLE, RECORDS_TABLE],
  )
  if (legacySessionColumns.length > 0) {
    throw new Error(
      'MySQL session tables still have tenant_id; recreate this unreleased database or run an explicit user-id-only migration',
    )
  }
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ${SESSIONS_TABLE} (
      session_id VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      version INT UNSIGNED NOT NULL,
      created_at BIGINT UNSIGNED NOT NULL,
      updated_at BIGINT UNSIGNED NOT NULL,
      cwd TEXT NULL,
      parent_session_id VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
      seed_length BIGINT UNSIGNED NULL,
      origin VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
      delegation_depth INT UNSIGNED NULL,
      agent_preset VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
      owner_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      owner_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      incarnation CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      revision BIGINT UNSIGNED NOT NULL,
      next_seq BIGINT UNSIGNED NOT NULL,
      PRIMARY KEY (session_id),
      KEY sessions_owner (owner_kind, owner_id, updated_at, session_id),
      KEY sessions_parent (parent_session_id),
      CONSTRAINT sessions_owner_fk
        FOREIGN KEY (owner_id)
        REFERENCES ${USERS_TABLE} (user_id)
        ON DELETE RESTRICT,
      CONSTRAINT sessions_parent_fk
        FOREIGN KEY (parent_session_id)
        REFERENCES ${SESSIONS_TABLE} (session_id)
        ON DELETE RESTRICT,
      CHECK (owner_kind = 'user')
    ) ENGINE = InnoDB
  `)
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ${RECORDS_TABLE} (
      session_id VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      seq_from BIGINT UNSIGNED NOT NULL,
      seq_to BIGINT UNSIGNED NOT NULL,
      record_kind VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      event_type VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      codec VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      payload LONGBLOB NOT NULL,
      event_count INT UNSIGNED NOT NULL,
      checksum BINARY(32) NOT NULL,
      created_at BIGINT UNSIGNED NOT NULL,
      PRIMARY KEY (session_id, seq_from),
      KEY records_end (session_id, seq_to),
      CONSTRAINT records_session_fk
        FOREIGN KEY (session_id)
        REFERENCES ${SESSIONS_TABLE} (session_id)
        ON DELETE CASCADE,
      CHECK (seq_to >= seq_from),
      CHECK (event_count > 0)
    ) ENGINE = InnoDB
  `)
  const [rows] = await connection.query<(RowDataPacket & { schema_version: number })[]>(
    `SELECT schema_version FROM ${STATE_TABLE} WHERE singleton = 1`,
  )
  const version = rows[0]?.schema_version
  if (version === undefined) {
    await connection.query(
      `INSERT INTO ${STATE_TABLE} (singleton, store_id, schema_version) VALUES (1, ?, ?)`,
      [randomUUID(), SCHEMA_VERSION],
    )
    return
  }
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `MySQL session persistence schema version ${String(version)} is incompatible with user-id-only version ${SCHEMA_VERSION}; recreate this unreleased database or run an explicit migration`,
    )
  }
}
