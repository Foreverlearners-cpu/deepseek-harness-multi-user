/** Versioned MySQL schema for immutable conversation file metadata. */

import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import type { RowDataPacket } from 'mysql2/promise'

/** Current schema version owned only by this plugin. */
export const CONVERSATION_FILES_MYSQL_SCHEMA_VERSION = 1
const LOCK_NAME = "CONCAT('dsh:conversation-files:', LEFT(SHA2(DATABASE(), 256), 40))"
const TABLES = [
  'dsh_file_objects',
  'dsh_conversation_files',
  'dsh_conversation_message_files',
] as const

interface LockRow extends RowDataPacket { acquired: number | null }
interface UnlockRow extends RowDataPacket { released: number | null }
interface VersionRow extends RowDataPacket { version: number | string }
interface TableRow extends RowDataPacket { table_name: string }

const CREATE_TABLES = [
  `CREATE TABLE dsh_file_objects (
    tenant_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    object_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    storage_backend VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    storage_key VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    byte_size BIGINT UNSIGNED NOT NULL,
    created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (tenant_id, user_id, object_id),
    KEY dsh_file_objects_digest (tenant_id, user_id, sha256)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
  `CREATE TABLE dsh_conversation_files (
    tenant_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    conversation_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    file_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    object_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    media_type VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    file_name VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (tenant_id, user_id, conversation_id, file_id),
    KEY dsh_conversation_files_object (tenant_id, user_id, object_id),
    CONSTRAINT dsh_conversation_files_conversation FOREIGN KEY (tenant_id, user_id, conversation_id)
      REFERENCES dsh_conversations (tenant_id, user_id, conversation_id),
    CONSTRAINT dsh_conversation_files_object FOREIGN KEY (tenant_id, user_id, object_id)
      REFERENCES dsh_file_objects (tenant_id, user_id, object_id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
  `CREATE TABLE dsh_conversation_message_files (
    tenant_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    conversation_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    message_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    file_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (tenant_id, user_id, conversation_id, message_id, file_id),
    KEY dsh_conversation_message_files_file (tenant_id, user_id, conversation_id, file_id),
    CONSTRAINT dsh_conversation_message_files_conversation_file
      FOREIGN KEY (tenant_id, user_id, conversation_id, file_id)
      REFERENCES dsh_conversation_files (tenant_id, user_id, conversation_id, file_id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
] as const

/** Initialize or verify all plugin-owned tables under a database-scoped advisory lock. @param connection - callback-scoped connection. */
export async function initializeSchema(connection: MysqlConnection): Promise<void> {
  const [locks] = await connection.query<LockRow[]>(`SELECT GET_LOCK(${LOCK_NAME}, 30) AS acquired`)
  if (Number(locks[0]?.acquired) !== 1) throw new Error('conversation-files-mysql: schema lock was not acquired')
  let initializationFailure: unknown
  try {
    await connection.query(`CREATE TABLE IF NOT EXISTS dsh_conversation_files_schema (
      schema_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      version INT UNSIGNED NOT NULL
    ) ENGINE=InnoDB`)
    const [versions] = await connection.query<VersionRow[]>(
      'SELECT version FROM dsh_conversation_files_schema WHERE schema_name = ?', ['conversation-files'],
    )
    const placeholders = TABLES.map(() => '?').join(', ')
    const [tables] = await connection.query<TableRow[]>(
      `SELECT TABLE_NAME AS table_name FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`, [...TABLES],
    )
    if (versions.length === 1) {
      if (Number(versions[0]?.version) !== CONVERSATION_FILES_MYSQL_SCHEMA_VERSION || tables.length !== TABLES.length) {
        throw new Error('conversation-files-mysql: incompatible or incomplete schema')
      }
      return
    }
    if (versions.length !== 0 || tables.length !== 0) {
      throw new Error('conversation-files-mysql: unversioned owned table exists')
    }
    for (const sql of CREATE_TABLES) await connection.query(sql)
    await connection.query(
      'INSERT INTO dsh_conversation_files_schema (schema_name, version) VALUES (?, ?)',
      ['conversation-files', CONVERSATION_FILES_MYSQL_SCHEMA_VERSION],
    )
  } catch (cause) {
    initializationFailure = cause
    throw cause
  } finally {
    try {
      const [unlocks] = await connection.query<UnlockRow[]>(`SELECT RELEASE_LOCK(${LOCK_NAME}) AS released`)
      if (Number(unlocks[0]?.released) !== 1) throw new Error('conversation-files-mysql: schema lock was not released')
    } catch (releaseFailure) {
      if (initializationFailure !== undefined) {
        throw new AggregateError(
          [initializationFailure, releaseFailure],
          'conversation-files-mysql: schema initialization and lock release failed',
        )
      }
      throw releaseFailure
    }
  }
}
