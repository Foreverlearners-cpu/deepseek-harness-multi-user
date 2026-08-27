import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import type { RowDataPacket } from 'mysql2/promise'

/** Current schema version owned by the MySQL ACL policy-source Provider. */
export const AUTHORITY_ACL_MYSQL_SCHEMA_VERSION = 1

interface SchemaVersionRow extends RowDataPacket {
  version: number
}

interface ExistingTableRow extends RowDataPacket {
  table_name: string
}

const CREATE_GRANTS_TABLE = `
  CREATE TABLE dsh_resource_action_grants (
    resource_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    resource_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    resource_revision BIGINT UNSIGNED NOT NULL,
    subject_ref VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    use_actions JSON NOT NULL,
    delegate_actions JSON NOT NULL,
    status ENUM('active', 'revoked') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (resource_type, resource_id, resource_revision, subject_ref),
    KEY dsh_resource_action_grants_resource_revision_status
      (resource_type, resource_id, resource_revision, status)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
`

/** Initialize or verify the Provider-owned schema.
 * @param connection - callback-scoped MySQL connection.
 */
export async function initializeSchema(connection: MysqlConnection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS dsh_acl_schema (
      schema_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      version INT UNSIGNED NOT NULL
    ) ENGINE=InnoDB
  `)
  const [versions] = await connection.query<SchemaVersionRow[]>(
    'SELECT version FROM dsh_acl_schema WHERE schema_name = ?',
    ['acl-policy'],
  )
  if (versions.length > 1
    || (versions.length === 1 && Number(versions[0]?.version) !== AUTHORITY_ACL_MYSQL_SCHEMA_VERSION)) {
    throw new Error(`authority-acl-mysql: incompatible schema version; expected ${String(AUTHORITY_ACL_MYSQL_SCHEMA_VERSION)}`)
  }
  const [tables] = await connection.query<ExistingTableRow[]>(
    `SELECT TABLE_NAME AS table_name FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
    ['dsh_resource_action_grants'],
  )
  const existing = new Set(tables.map(row => row.table_name))
  if (versions.length === 1) {
    if (!existing.has('dsh_resource_action_grants')) {
      throw new Error('authority-acl-mysql: versioned acl tables are missing')
    }
    return
  }
  if (existing.size !== 0) {
    throw new Error('authority-acl-mysql: unversioned acl tables already exist')
  }
  await connection.query(CREATE_GRANTS_TABLE)
  await connection.query(
    'INSERT INTO dsh_acl_schema (schema_name, version) VALUES (?, ?)',
    ['acl-policy', AUTHORITY_ACL_MYSQL_SCHEMA_VERSION],
  )
}
