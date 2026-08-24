/** MySQL persistence Provider for durable account registration operations.
 * @module @deepseek-ai/dsh-account-mysql
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  AccountError,
  type AccountRecoveryState,
  type RegistrationOperationAdvanceRequest,
  type RegistrationOperationProvider,
  type RegistrationOperationRecord,
} from '@deepseek-ai/dsh-account'
import { authenticationRequestId, type AuthenticationRequestId } from '@deepseek-ai/dsh-auth'
import type { Mysql, MysqlConnection } from '@deepseek-ai/dsh-mysql'
import { userExtensions, userId, type UserRecord, type UserStatus } from '@deepseek-ai/dsh-user'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { initializeSchema } from './schema.ts'

export { ACCOUNT_MYSQL_SCHEMA_VERSION } from './schema.ts'

interface OperationRow extends RowDataPacket {
  request_id: string
  revision: number | string
  stage: string
  user_id: string | null
  recovery_operation: string | null
  recovery_user_id: string | null
  recovery_user_status: string | null
  recovery_credentials_configured: boolean | number | string | null
  recovery_compensation_complete: boolean | number | string | null
  result_user_id: string | null
  result_display_name: string | null
  result_status: string | null
  result_created_at: number | string | null
  result_updated_at: number | string | null
  result_revision: number | string | null
  result_extensions: unknown
}

const SELECT_COLUMNS = `request_id, revision, stage, user_id, recovery_operation,
  recovery_user_id, recovery_user_status, recovery_credentials_configured,
  recovery_compensation_complete, result_user_id, result_display_name, result_status,
  result_created_at, result_updated_at, result_revision, result_extensions`
const STAGES = new Set<RegistrationOperationRecord['stage']>([
  'begun', 'user-created', 'identifier-added', 'password-set', 'completed', 'failed',
])
const RECOVERY_OPERATIONS = new Set<AccountRecoveryState['operation']>([
  'registration', 'credential-issue', 'password-change', 'disable', 'password-reset',
])
const USER_STATUSES = new Set<UserStatus>(['active', 'disabled', 'deleted'])

function unavailable(message: string): AccountError {
  return new AccountError('unavailable', `account-mysql: ${message}`)
}

function conflict(message: string): AccountError {
  return new AccountError('conflict', `account-mysql: ${message}`)
}

function safeInteger(value: number | string, field: string, positive = false): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < (positive ? 1 : 0)) {
    throw unavailable(`invalid stored ${field}`)
  }
  return numeric
}

function storedString(value: string, field: string): string {
  if (value.length === 0 || value.length > 128) throw unavailable(`invalid stored ${field}`)
  return value
}

function status(value: string, field: string): UserStatus {
  if (!USER_STATUSES.has(value as UserStatus)) throw unavailable(`invalid stored ${field}`)
  return value as UserStatus
}

function storedBoolean(value: boolean | number | string, field: string): boolean {
  if (value === true || value === 1 || value === '1') return true
  if (value === false || value === 0 || value === '0') return false
  throw unavailable(`invalid stored ${field}`)
}

function nullableGroup(values: readonly unknown[], field: string): 'empty' | 'full' {
  if (values.every(value => value === null)) return 'empty'
  if (values.some(value => value === null)) throw unavailable(`incomplete stored ${field}`)
  return 'full'
}

function parseExtensions(value: unknown): UserRecord['extensions'] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
    return userExtensions(parsed)
  } catch {
    throw unavailable('invalid stored result extensions')
  }
}

function recovery(row: OperationRow): AccountRecoveryState | undefined {
  const values = [
    row.recovery_operation,
    row.recovery_user_id,
    row.recovery_user_status,
    row.recovery_credentials_configured,
    row.recovery_compensation_complete,
  ]
  if (nullableGroup(values, 'recovery state') === 'empty') return undefined
  if (!RECOVERY_OPERATIONS.has(row.recovery_operation as AccountRecoveryState['operation'])) {
    throw unavailable('invalid stored recovery operation')
  }
  return {
    operation: row.recovery_operation as AccountRecoveryState['operation'],
    userId: userId(storedString(row.recovery_user_id as string, 'recovery user id')),
    userStatus: status(row.recovery_user_status as string, 'recovery user status'),
    credentialsConfigured: storedBoolean(
      row.recovery_credentials_configured as boolean | number | string,
      'credentials flag',
    ),
    compensationComplete: storedBoolean(
      row.recovery_compensation_complete as boolean | number | string,
      'compensation flag',
    ),
  }
}

function result(row: OperationRow): UserRecord | undefined {
  const values = [
    row.result_user_id,
    row.result_status,
    row.result_created_at,
    row.result_updated_at,
    row.result_revision,
    row.result_extensions,
  ]
  if (nullableGroup(values, 'registration result') === 'empty') {
    if (row.result_display_name !== null) throw unavailable('incomplete stored registration result')
    return undefined
  }
  const createdAt = safeInteger(row.result_created_at as number | string, 'result created_at')
  const updatedAt = safeInteger(row.result_updated_at as number | string, 'result updated_at')
  const revision = safeInteger(row.result_revision as number | string, 'result revision', true)
  if (updatedAt < createdAt) throw unavailable('invalid stored result chronology')
  if (row.result_display_name !== null
    && (row.result_display_name.length === 0
      || row.result_display_name.length > 200
      || row.result_display_name.trim() !== row.result_display_name)) {
    throw unavailable('invalid stored result display name')
  }
  return {
    userId: userId(storedString(row.result_user_id as string, 'result user id')),
    ...(row.result_display_name === null ? {} : { displayName: row.result_display_name }),
    status: status(row.result_status as string, 'result status'),
    createdAt,
    updatedAt,
    revision,
    extensions: parseExtensions(row.result_extensions),
  }
}

function record(row: OperationRow): RegistrationOperationRecord {
  const requestId = authenticationRequestId(storedString(row.request_id, 'request id'))
  const revision = safeInteger(row.revision, 'operation revision', true)
  if (!STAGES.has(row.stage as RegistrationOperationRecord['stage'])) {
    throw unavailable('invalid stored operation stage')
  }
  const stage = row.stage as RegistrationOperationRecord['stage']
  const validRevision = stage === 'begun' ? revision === 1
    : stage === 'user-created' ? revision === 2
      : stage === 'identifier-added' ? revision === 3
        : stage === 'password-set' ? revision === 4
          : stage === 'completed' ? revision === 5
            : revision >= 2 && revision <= 5
  if (!validRevision) throw unavailable('invalid stored operation stage revision')
  const operationUserId = row.user_id === null
    ? undefined
    : userId(storedString(row.user_id, 'operation user id'))
  const recoveryState = recovery(row)
  const completedResult = result(row)
  if (stage === 'begun') {
    if (revision !== 1 || operationUserId !== undefined || recoveryState !== undefined || completedResult !== undefined) {
      throw unavailable('invalid stored begun operation')
    }
  } else if (operationUserId === undefined) {
    throw unavailable('stored registration operation is missing its user id')
  }
  if (stage === 'failed') {
    if (recoveryState === undefined || completedResult !== undefined || recoveryState.userId !== operationUserId) {
      throw unavailable('invalid stored failed operation')
    }
  } else if (recoveryState !== undefined) {
    throw unavailable('unexpected stored recovery state')
  }
  if (stage === 'completed') {
    if (completedResult === undefined || completedResult.userId !== operationUserId) {
      throw unavailable('invalid stored completed operation')
    }
  } else if (completedResult !== undefined) {
    throw unavailable('unexpected stored registration result')
  }
  return {
    requestId,
    revision,
    stage,
    ...(operationUserId === undefined ? {} : { userId: operationUserId }),
    ...(recoveryState === undefined ? {} : { recovery: recoveryState }),
    ...(completedResult === undefined ? {} : { result: completedResult }),
  }
}

function requestedRecord(row: OperationRow, requestId: AuthenticationRequestId): RegistrationOperationRecord {
  const value = record(row)
  if (value.requestId !== requestId) throw unavailable('stored operation does not match the requested id')
  return value
}

function transitionAllowed(
  previous: RegistrationOperationRecord['stage'],
  next: RegistrationOperationAdvanceRequest['stage'],
): boolean {
  if (next === 'failed') return previous !== 'completed' && previous !== 'failed'
  return (previous === 'begun' && next === 'user-created')
    || (previous === 'user-created' && next === 'identifier-added')
    || (previous === 'identifier-added' && next === 'password-set')
}

async function rollback(connection: MysqlConnection, cause: unknown): Promise<never> {
  try {
    await connection.rollback()
  } catch {
    throw unavailable('transaction rollback failed')
  }
  if (cause instanceof AccountError) throw cause
  throw unavailable('storage operation failed')
}

async function transaction<T>(connection: MysqlConnection, callback: () => Promise<T>): Promise<T> {
  await connection.beginTransaction()
  try {
    const value = await callback()
    await connection.commit()
    return value
  } catch (cause) {
    return rollback(connection, cause)
  }
}

/** Registration-operation Provider backed by one injected MySQL service. */
export class AccountMysqlRegistrationOperations implements RegistrationOperationProvider {
  /** @param mysql - Host-only callback-scoped MySQL connection service. */
  constructor(private readonly mysql: Mysql) {}

  /** Begin or read the operation uniquely identified by a request id.
   * @param requestId - caller-owned idempotency key.
   * @returns the existing operation or a new `begun` operation.
   */
  begin(requestId: AuthenticationRequestId): Promise<RegistrationOperationRecord> {
    return this.storage(connection => transaction(connection, async () => {
      await connection.execute(
        `INSERT INTO dsh_account_registration_operations (request_id, revision, stage)
         VALUES (?, 1, 'begun') ON DUPLICATE KEY UPDATE request_id = request_id`,
        [requestId],
      )
      const current = await this.locked(connection, requestId)
      if (current === undefined) throw unavailable('begun operation disappeared')
      return current
    }))
  }

  /** Read one durable operation without modifying it.
   * @param requestId - exact idempotency key.
   * @returns the operation when it exists.
   */
  read(requestId: AuthenticationRequestId): Promise<RegistrationOperationRecord | undefined> {
    return this.storage(async (connection) => {
      const [rows] = await connection.execute<OperationRow[]>(
        `SELECT ${SELECT_COLUMNS} FROM dsh_account_registration_operations WHERE request_id = ?`,
        [requestId],
      )
      return rows[0] === undefined ? undefined : requestedRecord(rows[0], requestId)
    })
  }

  /** Atomically advance one non-terminal registration operation.
   * @param request - expected state and next durable stage.
   * @returns the committed operation.
   */
  advance(request: RegistrationOperationAdvanceRequest): Promise<RegistrationOperationRecord> {
    return this.storage(connection => transaction(connection, async () => {
      const previous = await this.locked(connection, request.requestId)
      if (previous === undefined) throw conflict('registration operation does not exist')
      if (previous.revision !== request.expectedRevision || previous.stage !== request.expectedStage) {
        throw conflict('registration operation revision or stage changed')
      }
      if (!transitionAllowed(previous.stage, request.stage)) {
        throw conflict('registration operation transition is invalid')
      }
      if (previous.userId !== undefined && previous.userId !== request.userId) {
        throw conflict('registration operation user changed')
      }
      if (request.stage === 'failed' ? request.recovery === undefined : request.recovery !== undefined) {
        throw conflict('registration operation recovery state is invalid')
      }
      if (request.recovery !== undefined && request.recovery.userId !== request.userId) {
        throw conflict('registration recovery user does not match')
      }
      const nextRevision = previous.revision + 1
      const recoveryState = request.recovery
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE dsh_account_registration_operations SET revision = ?, stage = ?, user_id = ?,
         recovery_operation = ?, recovery_user_id = ?, recovery_user_status = ?,
         recovery_credentials_configured = ?, recovery_compensation_complete = ?
         WHERE request_id = ? AND revision = ? AND stage = ?`,
        [nextRevision, request.stage, request.userId,
          recoveryState?.operation ?? null, recoveryState?.userId ?? null, recoveryState?.userStatus ?? null,
          recoveryState === undefined ? null : Number(recoveryState.credentialsConfigured),
          recoveryState === undefined ? null : Number(recoveryState.compensationComplete),
          request.requestId, request.expectedRevision, request.expectedStage],
      )
      if (updated.affectedRows !== 1) throw unavailable('locked operation was not advanced')
      const current = await this.locked(connection, request.requestId)
      if (current === undefined) throw unavailable('advanced operation disappeared')
      return current
    }))
  }

  /** Atomically store the immutable registration result.
   * @param requestId - exact idempotency key.
   * @param expectedRevision - revision observed at `password-set`.
   * @param result - non-secret committed user record.
   * @returns the terminal operation.
   */
  complete(
    requestId: AuthenticationRequestId,
    expectedRevision: number,
    result: UserRecord,
  ): Promise<RegistrationOperationRecord> {
    return this.storage(connection => transaction(connection, async () => {
      const previous = await this.locked(connection, requestId)
      if (previous === undefined) throw conflict('registration operation does not exist')
      if (previous.revision !== expectedRevision || previous.stage !== 'password-set') {
        throw conflict('registration operation cannot be completed from its current state')
      }
      if (previous.userId !== result.userId) throw conflict('registration result user does not match')
      const [updated] = await connection.execute<ResultSetHeader>(
        `UPDATE dsh_account_registration_operations SET revision = revision + 1, stage = 'completed',
         result_user_id = ?, result_display_name = ?, result_status = ?, result_created_at = ?,
         result_updated_at = ?, result_revision = ?, result_extensions = ?
         WHERE request_id = ? AND revision = ? AND stage = 'password-set'`,
        [result.userId, result.displayName ?? null, result.status, result.createdAt, result.updatedAt,
          result.revision, JSON.stringify(result.extensions), requestId, expectedRevision],
      )
      if (updated.affectedRows !== 1) throw unavailable('locked operation was not completed')
      const current = await this.locked(connection, requestId)
      if (current === undefined) throw unavailable('completed operation disappeared')
      return current
    }))
  }

  private async locked(
    connection: MysqlConnection,
    requestId: AuthenticationRequestId,
  ): Promise<RegistrationOperationRecord | undefined> {
    const [rows] = await connection.execute<OperationRow[]>(
      `SELECT ${SELECT_COLUMNS} FROM dsh_account_registration_operations WHERE request_id = ? FOR UPDATE`,
      [requestId],
    )
    return rows[0] === undefined ? undefined : requestedRecord(rows[0], requestId)
  }

  private async storage<T>(callback: (connection: MysqlConnection) => Promise<T>): Promise<T> {
    try {
      return await this.mysql.connection(callback)
    } catch (cause) {
      if (cause instanceof AccountError) throw cause
      throw unavailable('storage operation failed')
    }
  }
}

/** Cordis plugin name. */
export const name = 'account-mysql'
/** Services required before schema initialization and Provider registration. */
export const inject = ['accounts', 'mysql']

/** Initialize the schema and register the sole durable account-operation Provider.
 * @param ctx - Host context carrying account and MySQL services.
 */
export async function apply(ctx: Context): Promise<void> {
  try {
    await ctx.mysql.connection(initializeSchema)
  } catch {
    throw unavailable('schema initialization failed')
  }
  const provider = new AccountMysqlRegistrationOperations(ctx.mysql)
  ctx.effect(
    () => ctx.accounts.registrationOperations.register(provider),
    'account-mysql: registration operation Provider',
  )
}

export default apply
