import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import type { RowDataPacket } from 'mysql2/promise'

/** Current schema version owned by the MySQL auth-token Provider. */
export const AUTH_TOKEN_MYSQL_SCHEMA_VERSION = 1

interface SchemaVersionRow extends RowDataPacket { version: number | string }
interface ExistingTableRow extends RowDataPacket { table_name: string }
interface AdvisoryLockRow extends RowDataPacket { acquired: number | string | null }
interface AdvisoryUnlockRow extends RowDataPacket { released: number | string | null }

const OWNED_TABLES = ['dsh_auth_token_families', 'dsh_auth_refresh_credentials'] as const
const SCHEMA_LOCK_NAME = "CONCAT('dsh:auth-token:', LEFT(SHA2(DATABASE(), 256), 40))"

const CREATE_FAMILIES = `
  CREATE TABLE dsh_auth_token_families (
    token_family_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    principal_kind ENUM('user', 'service-account', 'local') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status ENUM('active', 'revoked') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at BIGINT UNSIGNED NOT NULL,
    updated_at BIGINT UNSIGNED NOT NULL,
    expires_at BIGINT UNSIGNED NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    revoked_at BIGINT UNSIGNED NULL,
    revocation_reason ENUM('requested', 'refresh-token-reuse') CHARACTER SET ascii COLLATE ascii_bin NULL,
    KEY dsh_auth_token_principal_family (principal_kind, principal_id, token_family_id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
`

const CREATE_CREDENTIALS = `
  CREATE TABLE dsh_auth_refresh_credentials (
    credential_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    token_family_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status ENUM('active', 'rotated', 'revoked') CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    issued_at BIGINT UNSIGNED NOT NULL,
    expires_at BIGINT UNSIGNED NOT NULL,
    rotated_at BIGINT UNSIGNED NULL,
    replaced_by VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    revoked_at BIGINT UNSIGNED NULL,
    UNIQUE KEY dsh_auth_refresh_digest (digest),
    KEY dsh_auth_refresh_family_issued (token_family_id, issued_at, credential_id),
    CONSTRAINT dsh_auth_refresh_family_fk FOREIGN KEY (token_family_id)
      REFERENCES dsh_auth_token_families (token_family_id) ON DELETE RESTRICT
  ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
`

/** Initialize or verify the Provider-owned schema.
 * @param connection - callback-scoped MySQL connection.
 */
export async function initializeSchema(connection: MysqlConnection): Promise<void> {
  const [locks] = await connection.query<AdvisoryLockRow[]>(
    `SELECT GET_LOCK(${SCHEMA_LOCK_NAME}, 30) AS acquired`,
  )
  if (Number(locks[0]?.acquired) !== 1) {
    throw new Error('auth-token-mysql: could not acquire schema initialization lock')
  }
  let initializationFailure: unknown
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS dsh_auth_token_schema (
        schema_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        version INT UNSIGNED NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
    `)
    const [versions] = await connection.query<SchemaVersionRow[]>(
      'SELECT version FROM dsh_auth_token_schema WHERE schema_name = ?',
      ['auth-token'],
    )
    if (versions.length > 1
      || (versions.length === 1 && Number(versions[0]?.version) !== AUTH_TOKEN_MYSQL_SCHEMA_VERSION)) {
      throw new Error(`auth-token-mysql: incompatible schema version; expected ${String(AUTH_TOKEN_MYSQL_SCHEMA_VERSION)}`)
    }
    const [tables] = await connection.query<ExistingTableRow[]>(
      `SELECT TABLE_NAME AS table_name FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?)`,
      [...OWNED_TABLES],
    )
    const existing = new Set(tables.map(row => row.table_name))
    if (versions.length === 1) {
      if (existing.size !== OWNED_TABLES.length || OWNED_TABLES.some(table => !existing.has(table))) {
        throw new Error('auth-token-mysql: versioned token tables are incomplete')
      }
      return
    }
    if (existing.size !== 0) throw new Error('auth-token-mysql: unversioned token table already exists')
    await connection.query(CREATE_FAMILIES)
    await connection.query(CREATE_CREDENTIALS)
    await connection.query(
      'INSERT INTO dsh_auth_token_schema (schema_name, version) VALUES (?, ?)',
      ['auth-token', AUTH_TOKEN_MYSQL_SCHEMA_VERSION],
    )
  } catch (cause) {
    initializationFailure = cause
    throw cause
  } finally {
    try {
      const [unlocks] = await connection.query<AdvisoryUnlockRow[]>(
        `SELECT RELEASE_LOCK(${SCHEMA_LOCK_NAME}) AS released`,
      )
      if (Number(unlocks[0]?.released) !== 1) {
        throw new Error('auth-token-mysql: could not release schema initialization lock')
      }
    } catch (releaseFailure) {
      if (initializationFailure !== undefined) {
        throw new AggregateError(
          [initializationFailure, releaseFailure],
          'auth-token-mysql: schema initialization and lock release failed',
        )
      }
      throw releaseFailure
    }
  }
}
