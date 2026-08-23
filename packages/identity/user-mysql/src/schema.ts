import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import type { RowDataPacket } from 'mysql2/promise'

/** Current schema version owned by the MySQL user-directory Provider. */
export const USER_MYSQL_SCHEMA_VERSION = 1

interface SchemaVersionRow extends RowDataPacket {
  version: number
}

interface ExistingTableRow extends RowDataPacket {
  table_name: string
}

const CREATE_USERS_TABLE = `
  CREATE TABLE dsh_users (
    user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    display_name VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    status ENUM('active', 'disabled', 'deleted') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    extensions JSON NOT NULL,
    KEY dsh_users_status_user_id (status, user_id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
`

/** Initialize or verify the Provider-owned schema.
 * @param connection - callback-scoped MySQL connection.
 */
export async function initializeSchema(connection: MysqlConnection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS dsh_user_schema (
      schema_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      version INT UNSIGNED NOT NULL
    ) ENGINE=InnoDB
  `)
  const [versions] = await connection.query<SchemaVersionRow[]>(
    'SELECT version FROM dsh_user_schema WHERE schema_name = ?',
    ['user-directory'],
  )
  if (versions.length > 1
    || (versions.length === 1 && Number(versions[0]?.version) !== USER_MYSQL_SCHEMA_VERSION)) {
    throw new Error(`user-mysql: incompatible schema version; expected ${String(USER_MYSQL_SCHEMA_VERSION)}`)
  }
  const [tables] = await connection.query<ExistingTableRow[]>(
    `SELECT TABLE_NAME AS table_name FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    ['dsh_users'],
  )
  if (versions.length === 1) {
    if (tables.length !== 1) throw new Error('user-mysql: versioned user table is missing')
    return
  }
  if (tables.length !== 0) {
    throw new Error('user-mysql: unversioned dsh_users table already exists')
  }
  await connection.query(CREATE_USERS_TABLE)
  await connection.query(
    'INSERT INTO dsh_user_schema (schema_name, version) VALUES (?, ?)',
    ['user-directory', USER_MYSQL_SCHEMA_VERSION],
  )
}
