import type { Mysql, MysqlConnection } from '@deepseek-ai/dsh-mysql'

export interface FakeOperationRow {
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

function begun(requestId: string): FakeOperationRow {
  return {
    request_id: requestId,
    revision: 1,
    stage: 'begun',
    user_id: null,
    recovery_operation: null,
    recovery_user_id: null,
    recovery_user_status: null,
    recovery_credentials_configured: null,
    recovery_compensation_complete: null,
    result_user_id: null,
    result_display_name: null,
    result_status: null,
    result_created_at: null,
    result_updated_at: null,
    result_revision: null,
    result_extensions: null,
  }
}

function copy(rows: Map<string, FakeOperationRow>): Map<string, FakeOperationRow> {
  return new Map([...rows].map(([key, value]) => [key, structuredClone(value)]))
}

/** Stateful MySQL test double for this package's owned SQL. */
export class FakeMysql {
  readonly rows = new Map<string, FakeOperationRow>()
  readonly queries: string[] = []
  schemaVersion: number | undefined
  operationTableExists = false
  schemaLockResult: number | string | null = 1
  schemaUnlockResult: number | string | null = 1
  failNext: Error | undefined
  rejectNextConnection: Error | undefined
  rollbackFailure: Error | undefined
  zeroNextUpdate = false
  hideNextLockedRead = false
  hideLockedReadCountdown: number | undefined
  private transactionRows: Map<string, FakeOperationRow> | undefined

  readonly connection = async <T>(callback: (connection: MysqlConnection) => T | Promise<T>): Promise<T> => {
    if (this.rejectNextConnection !== undefined) {
      const failure = this.rejectNextConnection
      this.rejectNextConnection = undefined
      throw failure
    }
    return callback(this.driver())
  }

  asService(): Mysql {
    return this as unknown as Mysql
  }

  private activeRows(): Map<string, FakeOperationRow> {
    return this.transactionRows ?? this.rows
  }

  private driver(): MysqlConnection {
    const query = async (sql: string, parameters: unknown[] = []): Promise<unknown> => {
      if (this.failNext !== undefined) {
        const failure = this.failNext
        this.failNext = undefined
        throw failure
      }
      const normalized = sql.replaceAll(/\s+/g, ' ').trim()
      this.queries.push(normalized)
      if (normalized.startsWith('SELECT GET_LOCK(')) return [[{ acquired: this.schemaLockResult }], []]
      if (normalized.startsWith('SELECT RELEASE_LOCK(')) return [[{ released: this.schemaUnlockResult }], []]
      if (normalized.startsWith('CREATE TABLE IF NOT EXISTS dsh_account_schema')) return [{ affectedRows: 0 }, []]
      if (normalized.startsWith('SELECT version FROM dsh_account_schema')) {
        return [this.schemaVersion === undefined ? [] : [{ version: this.schemaVersion }], []]
      }
      if (normalized.startsWith('SELECT TABLE_NAME AS table_name FROM information_schema.TABLES')) {
        return [this.operationTableExists ? [{ table_name: 'dsh_account_registration_operations' }] : [], []]
      }
      if (normalized.startsWith('CREATE TABLE dsh_account_registration_operations')) {
        this.operationTableExists = true
        return [{ affectedRows: 0 }, []]
      }
      if (normalized.startsWith('INSERT INTO dsh_account_schema')) {
        this.schemaVersion = parameters[1] as number
        return [{ affectedRows: 1 }, []]
      }
      return this.executeSql(normalized, parameters)
    }
    return {
      query,
      execute: query,
      beginTransaction: async () => { this.transactionRows = copy(this.rows) },
      commit: async () => {
        if (this.transactionRows === undefined) throw new Error('no transaction')
        this.rows.clear()
        for (const [key, value] of this.transactionRows) this.rows.set(key, value)
        this.transactionRows = undefined
      },
      rollback: async () => {
        if (this.rollbackFailure !== undefined) throw this.rollbackFailure
        this.transactionRows = undefined
      },
    } as unknown as MysqlConnection
  }

  private executeSql(sql: string, parameters: unknown[]): unknown {
    const rows = this.activeRows()
    if (sql.startsWith('INSERT INTO dsh_account_registration_operations')) {
      const requestId = parameters[0] as string
      if (!rows.has(requestId)) rows.set(requestId, begun(requestId))
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM dsh_account_registration_operations')) {
      if (sql.endsWith('FOR UPDATE') && this.hideLockedReadCountdown !== undefined) {
        this.hideLockedReadCountdown -= 1
        if (this.hideLockedReadCountdown === 0) {
          this.hideLockedReadCountdown = undefined
          return [[], []]
        }
      }
      if (sql.endsWith('FOR UPDATE') && this.hideNextLockedRead) {
        this.hideNextLockedRead = false
        return [[], []]
      }
      const row = rows.get(parameters[0] as string)
      return [row === undefined ? [] : [structuredClone(row)], []]
    }
    if (sql.startsWith('UPDATE dsh_account_registration_operations SET revision = ?, stage = ?')) {
      const [revision, stage, id, recoveryOperation, recoveryUserId, recoveryStatus,
        credentialsConfigured, compensationComplete, requestId, expectedRevision, expectedStage] = parameters as [
        number, string, string, string | null, string | null, string | null,
        number | null, number | null, string, number, string,
      ]
      const row = rows.get(requestId)
      if (row === undefined || Number(row.revision) !== expectedRevision || row.stage !== expectedStage) {
        return [{ affectedRows: 0 }, []]
      }
      row.revision = revision
      row.stage = stage
      row.user_id = id
      row.recovery_operation = recoveryOperation
      row.recovery_user_id = recoveryUserId
      row.recovery_user_status = recoveryStatus
      row.recovery_credentials_configured = credentialsConfigured
      row.recovery_compensation_complete = compensationComplete
      if (this.zeroNextUpdate) {
        this.zeroNextUpdate = false
        return [{ affectedRows: 0 }, []]
      }
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith("UPDATE dsh_account_registration_operations SET revision = revision + 1, stage = 'completed'")) {
      const [resultUserId, displayName, resultStatus, createdAt, updatedAt, resultRevision,
        resultExtensions, requestId, expectedRevision] = parameters as [
        string, string | null, string, number, number, number, string, string, number,
      ]
      const row = rows.get(requestId)
      if (row === undefined || Number(row.revision) !== expectedRevision || row.stage !== 'password-set') {
        return [{ affectedRows: 0 }, []]
      }
      row.revision = Number(row.revision) + 1
      row.stage = 'completed'
      row.result_user_id = resultUserId
      row.result_display_name = displayName
      row.result_status = resultStatus
      row.result_created_at = createdAt
      row.result_updated_at = updatedAt
      row.result_revision = resultRevision
      row.result_extensions = JSON.parse(resultExtensions) as unknown
      if (this.zeroNextUpdate) {
        this.zeroNextUpdate = false
        return [{ affectedRows: 0 }, []]
      }
      return [{ affectedRows: 1 }, []]
    }
    throw new Error(`unexpected SQL: ${sql}`)
  }
}
