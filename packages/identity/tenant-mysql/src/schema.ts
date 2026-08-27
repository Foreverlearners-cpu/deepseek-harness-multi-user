import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import type { RowDataPacket } from 'mysql2/promise'

/** Current schema version owned by the MySQL tenant-directory Provider. */
export const TENANT_MYSQL_SCHEMA_VERSION = 1

interface SchemaVersionRow extends RowDataPacket {
  version: number
}

interface ExistingTableRow extends RowDataPacket {
  table_name: string
}

const CREATE_TENANTS_TABLE = `
  CREATE TABLE dsh_tenants (
    tenant_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    display_name VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    status ENUM('active', 'disabled', 'deleted') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    KEY dsh_tenants_status_tenant_id (status, tenant_id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
`

const CREATE_MEMBERSHIPS_TABLE = `
  CREATE TABLE dsh_tenant_memberships (
    tenant_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    membership_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status ENUM('active', 'disabled', 'removed') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (tenant_id, user_id),
    UNIQUE KEY dsh_tenant_memberships_membership_id (membership_id),
    KEY dsh_tenant_memberships_tenant_status_membership (tenant_id, status, membership_id),
    KEY dsh_tenant_memberships_user_status_membership (user_id, status, membership_id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
`

/** Initialize or verify the Provider-owned schema.
 * @param connection - callback-scoped MySQL connection.
 */
export async function initializeSchema(connection: MysqlConnection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS dsh_tenant_schema (
      schema_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      version INT UNSIGNED NOT NULL
    ) ENGINE=InnoDB
  `)
  const [versions] = await connection.query<SchemaVersionRow[]>(
    'SELECT version FROM dsh_tenant_schema WHERE schema_name = ?',
    ['tenant-directory'],
  )
  if (versions.length > 1
    || (versions.length === 1 && Number(versions[0]?.version) !== TENANT_MYSQL_SCHEMA_VERSION)) {
    throw new Error(`tenant-mysql: incompatible schema version; expected ${String(TENANT_MYSQL_SCHEMA_VERSION)}`)
  }
  const [tables] = await connection.query<ExistingTableRow[]>(
    `SELECT TABLE_NAME AS table_name FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?)`,
    ['dsh_tenants', 'dsh_tenant_memberships'],
  )
  const existing = new Set(tables.map(row => row.table_name))
  if (versions.length === 1) {
    if (!existing.has('dsh_tenants') || !existing.has('dsh_tenant_memberships')) {
      throw new Error('tenant-mysql: versioned tenant tables are missing')
    }
    return
  }
  if (existing.size !== 0) {
    throw new Error('tenant-mysql: unversioned tenant tables already exist')
  }
  await connection.query(CREATE_TENANTS_TABLE)
  await connection.query(CREATE_MEMBERSHIPS_TABLE)
  await connection.query(
    'INSERT INTO dsh_tenant_schema (schema_name, version) VALUES (?, ?)',
    ['tenant-directory', TENANT_MYSQL_SCHEMA_VERSION],
  )
}
