import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import type { RowDataPacket } from 'mysql2/promise'

/** Current schema version owned by the MySQL credential Provider. */
export const USER_CREDENTIAL_MYSQL_SCHEMA_VERSION = 1

interface SchemaVersionRow extends RowDataPacket {
  version: number | string
}

interface ExistingTableRow extends RowDataPacket {
  table_name: string
}

const OWNED_TABLES = ['dsh_user_credentials', 'dsh_user_login_identifiers'] as const

const CREATE_CREDENTIALS_TABLE = `
  CREATE TABLE dsh_user_credentials (
    user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    revision BIGINT UNSIGNED NOT NULL,
    password_version SMALLINT UNSIGNED NULL,
    password_cost INT UNSIGNED NULL,
    password_block_size INT UNSIGNED NULL,
    password_parallelization INT UNSIGNED NULL,
    password_salt VARBINARY(64) NULL,
    password_derived_key VARBINARY(64) NULL,
    password_changed_at BIGINT UNSIGNED NULL,
    updated_at BIGINT UNSIGNED NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
`

const CREATE_IDENTIFIERS_TABLE = `
  CREATE TABLE dsh_user_login_identifiers (
    identifier_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    normalized_value VARCHAR(320) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    UNIQUE KEY dsh_user_login_identifiers_kind_value (kind, normalized_value),
    KEY dsh_user_login_identifiers_user_id (user_id, identifier_id),
    CONSTRAINT dsh_user_login_identifiers_user_fk FOREIGN KEY (user_id)
      REFERENCES dsh_user_credentials (user_id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
`

/** Initialize or verify the Provider-owned schema.
 * @param connection - callback-scoped MySQL connection.
 */
export async function initializeSchema(connection: MysqlConnection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS dsh_user_credential_schema (
      schema_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      version INT UNSIGNED NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
  `)
  const [versions] = await connection.query<SchemaVersionRow[]>(
    'SELECT version FROM dsh_user_credential_schema WHERE schema_name = ?',
    ['user-credentials'],
  )
  if (versions.length > 1
    || (versions.length === 1 && Number(versions[0]?.version) !== USER_CREDENTIAL_MYSQL_SCHEMA_VERSION)) {
    throw new Error(`user-credential-mysql: incompatible schema version; expected ${String(USER_CREDENTIAL_MYSQL_SCHEMA_VERSION)}`)
  }
  const [tables] = await connection.query<ExistingTableRow[]>(
    `SELECT TABLE_NAME AS table_name FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?)`,
    [...OWNED_TABLES],
  )
  const existing = new Set(tables.map(row => row.table_name))
  if (versions.length === 1) {
    if (existing.size !== OWNED_TABLES.length || OWNED_TABLES.some(table => !existing.has(table))) {
      throw new Error('user-credential-mysql: versioned credential tables are incomplete')
    }
    return
  }
  if (existing.size !== 0) {
    throw new Error('user-credential-mysql: unversioned credential table already exists')
  }
  await connection.query(CREATE_CREDENTIALS_TABLE)
  await connection.query(CREATE_IDENTIFIERS_TABLE)
  await connection.query(
    'INSERT INTO dsh_user_credential_schema (schema_name, version) VALUES (?, ?)',
    ['user-credentials', USER_CREDENTIAL_MYSQL_SCHEMA_VERSION],
  )
}
