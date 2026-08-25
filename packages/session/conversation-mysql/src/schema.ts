/** Versioned MySQL schema for semantic conversations. */

import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import type { RowDataPacket } from 'mysql2/promise'

/** Current schema version owned by this Provider. */
export const CONVERSATION_MYSQL_SCHEMA_VERSION = 1
const LOCK_NAME = "CONCAT('dsh:conversation:', LEFT(SHA2(DATABASE(), 256), 40))"
const TABLES = [
  'dsh_conversations',
  'dsh_agent_records',
  'dsh_conversation_messages',
  'dsh_conversation_message_state',
  'dsh_subagent_runs',
] as const

interface LockRow extends RowDataPacket { acquired: number | null }
interface UnlockRow extends RowDataPacket { released: number | null }
interface VersionRow extends RowDataPacket { version: number | string }
interface TableRow extends RowDataPacket { table_name: string }

const CREATE_TABLES = [
  `CREATE TABLE dsh_conversations (
    tenant_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    conversation_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    session_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    parent_conversation_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    origin ENUM('top-level','subagent','imported') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    delegation_depth INT UNSIGNED NOT NULL,
    title VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    status ENUM('active','archived','deleted') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    revision INT UNSIGNED NOT NULL,
    next_sequence BIGINT UNSIGNED NOT NULL,
    retention JSON NOT NULL,
    created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    updated_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    extensions JSON NOT NULL,
    PRIMARY KEY (tenant_id, user_id, conversation_id),
    UNIQUE KEY dsh_conversations_session (session_id),
    KEY dsh_conversations_owner_status (tenant_id, user_id, status, conversation_id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
  `CREATE TABLE dsh_agent_records (
    tenant_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    conversation_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    session_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    sequence BIGINT UNSIGNED NOT NULL,
    source_seq BIGINT UNSIGNED NOT NULL,
    record_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    record_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    group_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    record_json JSON NOT NULL,
    occurred_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (tenant_id, user_id, conversation_id, sequence),
    UNIQUE KEY dsh_agent_records_source_record (tenant_id, user_id, session_id, source_seq, record_id),
    UNIQUE KEY dsh_agent_records_record (tenant_id, user_id, conversation_id, record_id),
    KEY dsh_agent_records_type_sequence (tenant_id, user_id, conversation_id, record_type, sequence),
    CONSTRAINT dsh_agent_records_conversation FOREIGN KEY (tenant_id, user_id, conversation_id)
      REFERENCES dsh_conversations (tenant_id, user_id, conversation_id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
  `CREATE TABLE dsh_conversation_messages (
    tenant_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    session_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    message_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    revision INT UNSIGNED NOT NULL,
    status ENUM('completed','superseded') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    visibility ENUM('user','internal') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    role ENUM('user','assistant') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    visible_text MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    occurred_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (tenant_id, user_id, session_id, message_id),
    KEY dsh_conversation_messages_visibility (tenant_id, user_id, session_id, visibility, occurred_at, message_id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
  `CREATE TABLE dsh_conversation_message_state (
    tenant_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    session_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    message_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    conversation_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    ordinal BIGINT UNSIGNED NOT NULL,
    extensions JSON NOT NULL,
    PRIMARY KEY (tenant_id, user_id, session_id, message_id),
    UNIQUE KEY dsh_conversation_message_state_ordinal (tenant_id, user_id, session_id, ordinal),
    CONSTRAINT dsh_conversation_message_state_message FOREIGN KEY (tenant_id, user_id, session_id, message_id)
      REFERENCES dsh_conversation_messages (tenant_id, user_id, session_id, message_id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
  `CREATE TABLE dsh_subagent_runs (
    tenant_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    parent_conversation_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    delegation_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    child_conversation_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    task_record_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status ENUM('started','completed','failed','interrupted','unknown') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    result_record_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL,
    started_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    completed_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL,
    extensions JSON NOT NULL,
    PRIMARY KEY (tenant_id, user_id, parent_conversation_id, delegation_id),
    KEY dsh_subagent_runs_status (tenant_id, user_id, parent_conversation_id, status, delegation_id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
] as const

/** Initialize or verify all Provider-owned tables under a server advisory lock. @param connection - callback-scoped connection. */
export async function initializeSchema(connection: MysqlConnection): Promise<void> {
  const [locks] = await connection.query<LockRow[]>(`SELECT GET_LOCK(${LOCK_NAME}, 30) AS acquired`)
  if (Number(locks[0]?.acquired) !== 1) throw new Error('conversation-mysql: schema lock was not acquired')
  let initializationFailure: unknown
  try {
    await connection.query(`CREATE TABLE IF NOT EXISTS dsh_conversation_schema (
      schema_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      version INT UNSIGNED NOT NULL
    ) ENGINE=InnoDB`)
    const [versions] = await connection.query<VersionRow[]>(
      'SELECT version FROM dsh_conversation_schema WHERE schema_name = ?', ['conversation'],
    )
    const placeholders = TABLES.map(() => '?').join(', ')
    const [tables] = await connection.query<TableRow[]>(
      `SELECT TABLE_NAME AS table_name FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${placeholders})`, [...TABLES],
    )
    if (versions.length === 1) {
      if (Number(versions[0]?.version) !== CONVERSATION_MYSQL_SCHEMA_VERSION || tables.length !== TABLES.length) {
        throw new Error('conversation-mysql: incompatible or incomplete schema')
      }
      return
    }
    if (versions.length !== 0 || tables.length !== 0) throw new Error('conversation-mysql: unversioned owned table exists')
    for (const sql of CREATE_TABLES) await connection.query(sql)
    await connection.query(
      'INSERT INTO dsh_conversation_schema (schema_name, version) VALUES (?, ?)',
      ['conversation', CONVERSATION_MYSQL_SCHEMA_VERSION],
    )
  } catch (cause) {
    initializationFailure = cause
    throw cause
  } finally {
    try {
      const [unlocks] = await connection.query<UnlockRow[]>(
        `SELECT RELEASE_LOCK(${LOCK_NAME}) AS released`,
      )
      if (Number(unlocks[0]?.released) !== 1) {
        throw new Error('conversation-mysql: schema lock was not released')
      }
    } catch (releaseFailure) {
      if (initializationFailure !== undefined) {
        throw new AggregateError(
          [initializationFailure, releaseFailure],
          'conversation-mysql: schema initialization and lock release failed',
        )
      }
      throw releaseFailure
    }
  }
}
