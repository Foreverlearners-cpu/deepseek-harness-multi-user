/** MySQL schema owned by the user identity Consumer. */

import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import type { RowDataPacket } from 'mysql2'

/** User-id-only schema version for the user directory. */
export const SCHEMA_VERSION = 2
/** Singleton state table used to record the installed schema version. */
export const STATE_TABLE = 'dsh_user_persistence_state'
/** Durable user records table. */
export const USERS_TABLE = 'dsh_users'

/** Row returned from the user table. */
export interface UserRow extends RowDataPacket {
  user_id: string
  display_name: string | null
  status: 'active' | 'disabled' | 'deleted'
  created_at: number
  updated_at: number
  revision: number
}

/** Create or validate the user schema.
 * @param connection MySQL connection used for DDL and validation queries.
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
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ${USERS_TABLE} (
      user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      display_name VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
      status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at BIGINT UNSIGNED NOT NULL,
      updated_at BIGINT UNSIGNED NOT NULL,
      revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id),
      KEY users_status_updated (status, updated_at, user_id),
      CHECK (status IN ('active', 'disabled', 'deleted'))
    ) ENGINE = InnoDB
  `)
  const [legacyColumns] = await connection.query<RowDataPacket[]>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'tenant_id'`,
    [USERS_TABLE],
  )
  if (legacyColumns.length > 0) {
    throw new Error(
      `MySQL user table ${USERS_TABLE} still has tenant_id; recreate this unreleased database or run an explicit user-id-only migration`,
    )
  }
  await connection.query(
    `INSERT INTO ${STATE_TABLE} (singleton, store_id, schema_version) VALUES (1, UUID(), ?)
     ON DUPLICATE KEY UPDATE schema_version = schema_version`,
    [SCHEMA_VERSION],
  )
  const [rows] = await connection.query<(RowDataPacket & { schema_version: number })[]>(
    `SELECT schema_version FROM ${STATE_TABLE} WHERE singleton = 1`,
  )
  if (rows[0]?.schema_version !== SCHEMA_VERSION) {
    throw new Error(`MySQL user schema version ${String(rows[0]?.schema_version)} is incompatible with ${SCHEMA_VERSION}`)
  }
}
