import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import type { RowDataPacket } from 'mysql2/promise'

/** Current schema version owned by the MySQL RBAC policy-source Provider. */
export const AUTH_RBAC_MYSQL_SCHEMA_VERSION = 1

interface SchemaVersionRow extends RowDataPacket {
  version: number
}

interface ExistingTableRow extends RowDataPacket {
  table_name: string
}

const CREATE_ROLE_GRANTS_TABLE = `
  CREATE TABLE dsh_role_action_grants (
    role_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    use_actions JSON NOT NULL,
    delegate_actions JSON NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
`

const CREATE_PRINCIPAL_ROLES_TABLE = `
  CREATE TABLE dsh_principal_roles (
    user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    tenant_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    team_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    role_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status ENUM('active', 'revoked') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (user_id, tenant_id, team_id, role_id),
    KEY dsh_principal_roles_user_tenant_team_status (user_id, tenant_id, team_id, status)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
`

/** Initialize or verify the Provider-owned schema.
 * @param connection - callback-scoped MySQL connection.
 */
export async function initializeSchema(connection: MysqlConnection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS dsh_rbac_schema (
      schema_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
      version INT UNSIGNED NOT NULL
    ) ENGINE=InnoDB
  `)
  const [versions] = await connection.query<SchemaVersionRow[]>(
    'SELECT version FROM dsh_rbac_schema WHERE schema_name = ?',
    ['rbac-policy'],
  )
  if (versions.length > 1
    || (versions.length === 1 && Number(versions[0]?.version) !== AUTH_RBAC_MYSQL_SCHEMA_VERSION)) {
    throw new Error(`auth-rbac-mysql: incompatible schema version; expected ${String(AUTH_RBAC_MYSQL_SCHEMA_VERSION)}`)
  }
  const [tables] = await connection.query<ExistingTableRow[]>(
    `SELECT TABLE_NAME AS table_name FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?)`,
    ['dsh_role_action_grants', 'dsh_principal_roles'],
  )
  const existing = new Set(tables.map(row => row.table_name))
  if (versions.length === 1) {
    if (!existing.has('dsh_role_action_grants') || !existing.has('dsh_principal_roles')) {
      throw new Error('auth-rbac-mysql: versioned rbac tables are missing')
    }
    return
  }
  if (existing.size !== 0) {
    throw new Error('auth-rbac-mysql: unversioned rbac tables already exist')
  }
  await connection.query(CREATE_ROLE_GRANTS_TABLE)
  await connection.query(CREATE_PRINCIPAL_ROLES_TABLE)
  await connection.query(
    'INSERT INTO dsh_rbac_schema (schema_name, version) VALUES (?, ?)',
    ['rbac-policy', AUTH_RBAC_MYSQL_SCHEMA_VERSION],
  )
}
