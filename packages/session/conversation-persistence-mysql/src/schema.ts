/** MySQL schema owned by the message-only conversation persistence plugin. */

import { randomUUID } from 'node:crypto'
import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import type { RowDataPacket } from 'mysql2'

/** Current additive schema version for the conversation projection. */
export const SCHEMA_VERSION = 3
/** Singleton schema state table. */
export const STATE_TABLE = 'dsh_conversation_persistence_state'
/** Conversation metadata table. */
export const CONVERSATIONS_TABLE = 'dsh_conversations'
/** Message-only projection table. */
export const MESSAGES_TABLE = 'dsh_conversation_messages'
/** Content-addressed file object metadata table. */
export const ATTACHMENT_OBJECTS_TABLE = 'dsh_file_objects'
/** Conversation-owned file metadata table. */
export const CONVERSATION_FILES_TABLE = 'dsh_conversation_files'
/** Message-to-file link table. */
export const MESSAGE_FILES_TABLE = 'dsh_message_files'
/** Model attempt metadata table. */
export const ATTEMPTS_TABLE = 'dsh_model_attempts'
/** Semantic outbox table. */
export const OUTBOX_TABLE = 'dsh_conversation_outbox'
/** Dynamic runtime configuration table. */
export const CONFIG_TABLE = 'dsh_runtime_configs'
const USERS_TABLE = 'dsh_users'

/** Row containing the installed projection schema version. */
export interface SchemaStateRow extends RowDataPacket {
  schema_version: number
}

/** Database row for one conversation. */
export interface ConversationRow extends RowDataPacket {
  session_id: string
  version: number
  user_id: string
  title: string
  title_status: 'fallback' | 'generating' | 'generated' | 'manual' | string
  title_source: string
  title_revision: number
  title_updated_at: number
  status: 'active' | 'archived' | 'deleted' | string
  cwd: string | null
  parent_session_id: string | null
  seed_length: number | null
  origin: string | null
  delegation_depth: number | null
  agent_preset: string | null
  incarnation: string
  revision: number
  next_message_ordinal: number
  extensions: string | Record<string, unknown>
  created_at: number
  updated_at: number
}

/** Database row for one projected message. */
export interface MessageRow extends RowDataPacket {
  message_id: string
  session_id: string
  user_id: string
  ordinal: number
  event_type: string
  role: string
  turn_no: number
  step_no: number
  content_json: string | unknown[]
  source_json: string | Record<string, unknown> | null
  tool_call_id: string | null
  usage_json: string | Record<string, unknown> | null
  visibility: string
  status: string
  extensions: string | Record<string, unknown>
  created_at: number
  updated_at: number
}

/** Database row for one conversation-owned file. */
export interface ConversationFileRow extends RowDataPacket {
  file_id: string
  user_id: string
  session_id: string
  object_id: string
  original_name: string
  media_type: string
  byte_size: number
  purpose: string
  status: string
  extensions: string | Record<string, unknown>
  created_at: number
}

async function hasColumn(connection: MysqlConnection, table: string, column: string): Promise<boolean> {
  const [rows] = await connection.query<Array<{ Field: string } & RowDataPacket>>(
    `SHOW COLUMNS FROM ${table} LIKE ?`, [column],
  )
  return rows.length > 0
}

async function hasIndex(connection: MysqlConnection, table: string, index: string): Promise<boolean> {
  const [rows] = await connection.query<Array<{ Key_name: string } & RowDataPacket>>(
    `SHOW INDEX FROM ${table} WHERE Key_name = ?`, [index],
  )
  return rows.length > 0
}

async function hasForeignKey(connection: MysqlConnection, table: string, constraint: string): Promise<boolean> {
  const [rows] = await connection.query<Array<{ CONSTRAINT_NAME: string } & RowDataPacket>>(
    `SELECT CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, constraint],
  )
  return rows.length > 0
}

async function foreignKeyDeleteRule(connection: MysqlConnection, table: string, constraint: string): Promise<string | undefined> {
  const [rows] = await connection.query<Array<{ DELETE_RULE: string } & RowDataPacket>>(
    `SELECT DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
    [table, constraint],
  )
  return rows[0]?.DELETE_RULE
}

async function addIndexIfMissing(connection: MysqlConnection, table: string, index: string, definition: string): Promise<void> {
  if (!(await hasIndex(connection, table, index))) await connection.query(`ALTER TABLE ${table} ADD ${definition}`)
}

async function addForeignKeyIfMissing(
  connection: MysqlConnection,
  table: string,
  constraint: string,
  definition: string,
): Promise<void> {
  if (!(await hasForeignKey(connection, table, constraint))) await connection.query(`ALTER TABLE ${table} ADD ${definition}`)
}

/** Add direct user ownership to message and attempt rows and enforce consistency with their conversation. */
async function migrateDirectUserOwnership(connection: MysqlConnection): Promise<void> {
  await addIndexIfMissing(connection, CONVERSATIONS_TABLE, 'conversations_session_user',
    'UNIQUE KEY conversations_session_user (session_id, user_id)')

  if (!(await hasColumn(connection, MESSAGES_TABLE, 'user_id'))) {
    await connection.query(
      `ALTER TABLE ${MESSAGES_TABLE}
       ADD COLUMN user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER session_id`,
    )
    await connection.query(
      `UPDATE ${MESSAGES_TABLE} m
       JOIN ${CONVERSATIONS_TABLE} c ON c.session_id = m.session_id
       SET m.user_id = c.user_id
       WHERE m.user_id IS NULL`,
    )
    await connection.query(`ALTER TABLE ${MESSAGES_TABLE} MODIFY user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`)
  }
  await addIndexIfMissing(connection, MESSAGES_TABLE, 'messages_user_session_order',
    'KEY messages_user_session_order (user_id, session_id, ordinal)')
  await addForeignKeyIfMissing(connection, MESSAGES_TABLE, 'messages_conversation_user_fk',
    `CONSTRAINT messages_conversation_user_fk FOREIGN KEY (session_id, user_id)
       REFERENCES ${CONVERSATIONS_TABLE} (session_id, user_id) ON DELETE CASCADE`)

  if (!(await hasColumn(connection, ATTEMPTS_TABLE, 'user_id'))) {
    await connection.query(
      `ALTER TABLE ${ATTEMPTS_TABLE}
       ADD COLUMN user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER session_id`,
    )
    await connection.query(
      `UPDATE ${ATTEMPTS_TABLE} a
       JOIN ${CONVERSATIONS_TABLE} c ON c.session_id = a.session_id
       SET a.user_id = c.user_id
       WHERE a.user_id IS NULL`,
    )
    await connection.query(`ALTER TABLE ${ATTEMPTS_TABLE} MODIFY user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL`)
  }
  await addIndexIfMissing(connection, ATTEMPTS_TABLE, 'attempts_user_session',
    'KEY attempts_user_session (user_id, session_id, turn_no, step_no, retry_no)')
  await addForeignKeyIfMissing(connection, ATTEMPTS_TABLE, 'attempts_conversation_user_fk',
    `CONSTRAINT attempts_conversation_user_fk FOREIGN KEY (session_id, user_id)
       REFERENCES ${CONVERSATIONS_TABLE} (session_id, user_id) ON DELETE CASCADE`)

  // Existing file and outbox rows already carry user_id. These composite keys
  // prevent a row from combining one user's id with another user's session.
  await addIndexIfMissing(connection, CONVERSATION_FILES_TABLE, 'files_session_user',
    'KEY files_session_user (session_id, user_id)')
  await addForeignKeyIfMissing(connection, CONVERSATION_FILES_TABLE, 'files_conversation_user_fk',
    `CONSTRAINT files_conversation_user_fk FOREIGN KEY (session_id, user_id)
       REFERENCES ${CONVERSATIONS_TABLE} (session_id, user_id) ON DELETE CASCADE`)
  await addIndexIfMissing(connection, OUTBOX_TABLE, 'outbox_session_user',
    'KEY outbox_session_user (session_id, user_id)')
  if (await foreignKeyDeleteRule(connection, OUTBOX_TABLE, 'outbox_conversation_user_fk') === 'CASCADE') {
    await connection.query(`ALTER TABLE ${OUTBOX_TABLE} DROP FOREIGN KEY outbox_conversation_user_fk`)
  }
  await addForeignKeyIfMissing(connection, OUTBOX_TABLE, 'outbox_conversation_user_fk',
    `CONSTRAINT outbox_conversation_user_fk FOREIGN KEY (session_id, user_id)
       REFERENCES ${CONVERSATIONS_TABLE} (session_id, user_id) ON DELETE RESTRICT`)
}

/** Ensure the additive message-only schema exists and has the expected version.
 * @param connection MySQL connection used for DDL and migration checks.
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
    CREATE TABLE IF NOT EXISTS ${CONVERSATIONS_TABLE} (
      session_id VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      version INT UNSIGNED NOT NULL,
      user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      title VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      title_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      title_source VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      title_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
      title_updated_at BIGINT UNSIGNED NOT NULL,
      status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      cwd TEXT NULL,
      parent_session_id VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
      seed_length BIGINT UNSIGNED NULL,
      origin VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
      delegation_depth INT UNSIGNED NULL,
      agent_preset VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
      incarnation CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
      next_message_ordinal BIGINT UNSIGNED NOT NULL DEFAULT 0,
      extensions JSON NOT NULL,
      created_at BIGINT UNSIGNED NOT NULL,
      updated_at BIGINT UNSIGNED NOT NULL,
      PRIMARY KEY (session_id),
      UNIQUE KEY conversations_session_user (session_id, user_id),
      KEY conversations_user_list (user_id, status, updated_at, session_id),
      KEY conversations_parent (parent_session_id),
      CONSTRAINT conversations_user_fk FOREIGN KEY (user_id)
        REFERENCES ${USERS_TABLE} (user_id) ON DELETE RESTRICT,
      CONSTRAINT conversations_status_chk CHECK (status IN ('active', 'archived', 'deleted')),
      CONSTRAINT conversations_title_status_chk CHECK (title_status IN ('fallback', 'generating', 'generated', 'manual'))
    ) ENGINE = InnoDB
  `)
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ${MESSAGES_TABLE} (
      message_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      session_id VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      ordinal BIGINT UNSIGNED NOT NULL,
      event_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      role VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      turn_no INT UNSIGNED NOT NULL,
      step_no INT UNSIGNED NOT NULL,
      content_json JSON NOT NULL,
      source_json JSON NULL,
      tool_call_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
      usage_json JSON NULL,
      visibility VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      extensions JSON NOT NULL,
      created_at BIGINT UNSIGNED NOT NULL,
      updated_at BIGINT UNSIGNED NOT NULL,
      PRIMARY KEY (message_id),
      UNIQUE KEY messages_session_order (session_id, ordinal),
      KEY messages_user_session_order (user_id, session_id, ordinal),
      KEY messages_tool_call (session_id, tool_call_id),
      CONSTRAINT messages_session_fk FOREIGN KEY (session_id)
        REFERENCES ${CONVERSATIONS_TABLE} (session_id) ON DELETE CASCADE,
      CONSTRAINT messages_conversation_user_fk FOREIGN KEY (session_id, user_id)
        REFERENCES ${CONVERSATIONS_TABLE} (session_id, user_id) ON DELETE CASCADE,
      CONSTRAINT messages_event_type_chk CHECK (event_type IN ('user/message', 'assistant/message', 'tool/result')),
      CONSTRAINT messages_role_chk CHECK (role IN ('user', 'assistant', 'tool')),
      CONSTRAINT messages_visibility_chk CHECK (visibility IN ('user', 'internal')),
      CONSTRAINT messages_status_chk CHECK (status IN ('completed', 'partial', 'failed', 'superseded'))
    ) ENGINE = InnoDB
  `)
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ${ATTACHMENT_OBJECTS_TABLE} (
      object_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      sha256 BINARY(32) NOT NULL,
      byte_size BIGINT UNSIGNED NOT NULL,
      media_type VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      storage_backend VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      storage_key VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at BIGINT UNSIGNED NOT NULL,
      verified_at BIGINT UNSIGNED NULL,
      extensions JSON NOT NULL,
      PRIMARY KEY (object_id),
      CONSTRAINT file_objects_status_chk CHECK (status IN ('staging', 'ready', 'corrupt', 'deleting'))
    ) ENGINE = InnoDB
  `)
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ${CONVERSATION_FILES_TABLE} (
      file_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      session_id VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      object_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      original_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      media_type VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      byte_size BIGINT UNSIGNED NOT NULL,
      purpose VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      extensions JSON NOT NULL,
      created_at BIGINT UNSIGNED NOT NULL,
      deleted_at BIGINT UNSIGNED NULL,
      PRIMARY KEY (file_id),
      KEY files_user_session (user_id, session_id, status, created_at, file_id),
      KEY files_session_user (session_id, user_id),
      KEY files_object (object_id),
      CONSTRAINT files_user_fk FOREIGN KEY (user_id) REFERENCES ${USERS_TABLE} (user_id) ON DELETE RESTRICT,
      CONSTRAINT files_session_fk FOREIGN KEY (session_id) REFERENCES ${CONVERSATIONS_TABLE} (session_id) ON DELETE CASCADE,
      CONSTRAINT files_conversation_user_fk FOREIGN KEY (session_id, user_id)
        REFERENCES ${CONVERSATIONS_TABLE} (session_id, user_id) ON DELETE CASCADE,
      CONSTRAINT files_object_fk FOREIGN KEY (object_id) REFERENCES ${ATTACHMENT_OBJECTS_TABLE} (object_id) ON DELETE RESTRICT,
      CONSTRAINT files_status_chk CHECK (status IN ('ready', 'deleted', 'quarantined'))
    ) ENGINE = InnoDB
  `)
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ${MESSAGE_FILES_TABLE} (
      session_id VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      message_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      file_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      ordinal INT UNSIGNED NOT NULL,
      relation VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at BIGINT UNSIGNED NOT NULL,
      PRIMARY KEY (session_id, message_id, file_id),
      UNIQUE KEY message_files_order (session_id, message_id, ordinal),
      CONSTRAINT message_files_message_fk FOREIGN KEY (message_id)
        REFERENCES ${MESSAGES_TABLE} (message_id) ON DELETE CASCADE,
      CONSTRAINT message_files_file_fk FOREIGN KEY (file_id)
        REFERENCES ${CONVERSATION_FILES_TABLE} (file_id) ON DELETE RESTRICT
    ) ENGINE = InnoDB
  `)
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ${ATTEMPTS_TABLE} (
      attempt_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      session_id VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      turn_no INT UNSIGNED NOT NULL,
      step_no INT UNSIGNED NOT NULL,
      retry_no INT UNSIGNED NOT NULL DEFAULT 0,
      provider VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      model VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      started_at BIGINT UNSIGNED NOT NULL,
      first_token_at BIGINT UNSIGNED NULL,
      finished_at BIGINT UNSIGNED NULL,
      finish_reason VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
      usage_json JSON NULL,
      final_message_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
      partial_content_json JSON NULL,
      error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
      error_message VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
      extensions JSON NOT NULL,
      PRIMARY KEY (attempt_id),
      KEY attempts_session (session_id, turn_no, step_no, retry_no),
      KEY attempts_user_session (user_id, session_id, turn_no, step_no, retry_no),
      CONSTRAINT attempts_session_fk FOREIGN KEY (session_id)
        REFERENCES ${CONVERSATIONS_TABLE} (session_id) ON DELETE CASCADE,
      CONSTRAINT attempts_conversation_user_fk FOREIGN KEY (session_id, user_id)
        REFERENCES ${CONVERSATIONS_TABLE} (session_id, user_id) ON DELETE CASCADE,
      CONSTRAINT attempts_status_chk CHECK (status IN ('started', 'completed', 'failed', 'cancelled'))
    ) ENGINE = InnoDB
  `)
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ${OUTBOX_TABLE} (
      outbox_seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      outbox_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      schema_version INT UNSIGNED NOT NULL,
      event_type VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      aggregate_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      aggregate_id VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      session_id VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      message_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
      aggregate_revision BIGINT UNSIGNED NOT NULL,
      payload_json JSON NOT NULL,
      extensions JSON NOT NULL,
      occurred_at BIGINT UNSIGNED NOT NULL,
      PRIMARY KEY (outbox_id),
      UNIQUE KEY outbox_sequence (outbox_seq),
      KEY outbox_user_route (user_id, session_id, occurred_at),
      KEY outbox_session_user (session_id, user_id),
      CONSTRAINT outbox_conversation_user_fk FOREIGN KEY (session_id, user_id)
        REFERENCES ${CONVERSATIONS_TABLE} (session_id, user_id) ON DELETE RESTRICT,
      CONSTRAINT outbox_user_fk FOREIGN KEY (user_id) REFERENCES ${USERS_TABLE} (user_id) ON DELETE RESTRICT
    ) ENGINE = InnoDB
  `)
  // Additive upgrade for installations created before the monotonic cursor
  // existed. The sequence is internal ordering metadata; event_id remains the
  // stable idempotency key used by downstream sinks.
  const [outboxColumns] = await connection.query<Array<{ Field: string } & RowDataPacket>>(
    `SHOW COLUMNS FROM ${OUTBOX_TABLE} LIKE 'outbox_seq'`,
  )
  if (outboxColumns.length === 0) {
    await connection.query(
      `ALTER TABLE ${OUTBOX_TABLE}
       ADD COLUMN outbox_seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT AFTER outbox_id,
       ADD UNIQUE KEY outbox_sequence (outbox_seq)`,
    )
  }
  await connection.query(`
    CREATE TABLE IF NOT EXISTS ${CONFIG_TABLE} (
      config_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      value_json JSON NOT NULL,
      value_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      schema_version INT UNSIGNED NOT NULL DEFAULT 1,
      description VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
      updated_by VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
      extensions JSON NOT NULL,
      created_at BIGINT UNSIGNED NOT NULL,
      updated_at BIGINT UNSIGNED NOT NULL,
      PRIMARY KEY (config_key),
      CONSTRAINT configs_status_chk CHECK (status IN ('active', 'disabled'))
    ) ENGINE = InnoDB
  `)
  const [existingState] = await connection.query<SchemaStateRow[]>(
    `SELECT schema_version FROM ${STATE_TABLE} WHERE singleton = 1`,
  )
  if (existingState[0] !== undefined && existingState[0].schema_version > SCHEMA_VERSION) {
    throw new Error(`MySQL conversation schema ${String(existingState[0].schema_version)} is newer than ${SCHEMA_VERSION}`)
  }
  await migrateDirectUserOwnership(connection)
  if (existingState[0] === undefined) {
    await connection.query(
      `INSERT INTO ${STATE_TABLE} (singleton, store_id, schema_version) VALUES (1, ?, ?)`,
      [randomUUID(), SCHEMA_VERSION],
    )
  } else if (existingState[0].schema_version < SCHEMA_VERSION) {
    await connection.query(
      `UPDATE ${STATE_TABLE} SET schema_version = ? WHERE singleton = 1`, [SCHEMA_VERSION],
    )
  }
  const [rows] = await connection.query<SchemaStateRow[]>(
    `SELECT schema_version FROM ${STATE_TABLE} WHERE singleton = 1`,
  )
  if (rows[0]?.schema_version !== SCHEMA_VERSION) {
    throw new Error(`MySQL conversation schema ${String(rows[0]?.schema_version)} is incompatible with ${SCHEMA_VERSION}`)
  }
}
