import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import type { RowDataPacket } from 'mysql2/promise'

/** Current schema version owned by the MySQL account-operation Provider. */
export const ACCOUNT_MYSQL_SCHEMA_VERSION = 1

interface SchemaVersionRow extends RowDataPacket { version: number | string }
interface ExistingTableRow extends RowDataPacket { table_name: string }
interface AdvisoryLockRow extends RowDataPacket { acquired: number | string | null }
interface AdvisoryUnlockRow extends RowDataPacket { released: number | string | null }

const SCHEMA_LOCK_NAME = "CONCAT('dsh:account:', LEFT(SHA2(DATABASE(), 256), 40))"

const CREATE_OPERATIONS_TABLE = `
  CREATE TABLE dsh_account_registration_operations (
    request_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    revision BIGINT UNSIGNED NOT NULL,
    stage ENUM('begun', 'user-created', 'identifier-added', 'password-set', 'completed', 'failed')
      CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    recovery_operation ENUM('registration', 'credential-issue', 'password-change', 'disable', 'password-reset')
      CHARACTER SET ascii COLLATE ascii_bin NULL,
    recovery_user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    recovery_user_status ENUM('active', 'disabled', 'deleted') CHARACTER SET ascii COLLATE ascii_bin NULL,
    recovery_credentials_configured BOOLEAN NULL,
    recovery_compensation_complete BOOLEAN NULL,
    result_user_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
    result_display_name VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    result_status ENUM('active', 'disabled', 'deleted') CHARACTER SET ascii COLLATE ascii_bin NULL,
    result_created_at BIGINT UNSIGNED NULL,
    result_updated_at BIGINT UNSIGNED NULL,
    result_revision BIGINT UNSIGNED NULL,
    result_extensions JSON NULL
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
    throw new Error('account-mysql: could not acquire schema initialization lock')
  }
  let initializationFailure: unknown
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS dsh_account_schema (
        schema_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        version INT UNSIGNED NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
    `)
    const [versions] = await connection.query<SchemaVersionRow[]>(
      'SELECT version FROM dsh_account_schema WHERE schema_name = ?',
      ['registration-operations'],
    )
    if (versions.length > 1
      || (versions.length === 1 && Number(versions[0]?.version) !== ACCOUNT_MYSQL_SCHEMA_VERSION)) {
      throw new Error(`account-mysql: incompatible schema version; expected ${String(ACCOUNT_MYSQL_SCHEMA_VERSION)}`)
    }
    const [tables] = await connection.query<ExistingTableRow[]>(
      `SELECT TABLE_NAME AS table_name FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      ['dsh_account_registration_operations'],
    )
    if (versions.length === 1) {
      if (tables.length !== 1) throw new Error('account-mysql: versioned registration operation table is missing')
      return
    }
    if (tables.length !== 0) throw new Error('account-mysql: unversioned registration operation table already exists')
    await connection.query(CREATE_OPERATIONS_TABLE)
    await connection.query(
      'INSERT INTO dsh_account_schema (schema_name, version) VALUES (?, ?)',
      ['registration-operations', ACCOUNT_MYSQL_SCHEMA_VERSION],
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
        throw new Error('account-mysql: could not release schema initialization lock')
      }
    } catch (releaseFailure) {
      if (initializationFailure !== undefined) {
        throw new AggregateError(
          [initializationFailure, releaseFailure],
          'account-mysql: schema initialization and lock release failed',
        )
      }
      throw releaseFailure
    }
  }
}
