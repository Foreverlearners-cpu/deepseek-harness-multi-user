import type { Mysql, MysqlConnection } from '@deepseek-ai/dsh-mysql'

export interface FakeCredentialRow {
  user_id: string
  revision: number | string
  password_version: number | string | null
  password_cost: number | string | null
  password_block_size: number | string | null
  password_parallelization: number | string | null
  password_salt: Buffer | null
  password_derived_key: Buffer | null
  password_changed_at: number | string | null
  updated_at: number | string
}

interface FakeIdentifierRow {
  identifier_id: number
  user_id: string
  kind: string
  normalized_value: string
  created_at: number | string
}

function copyCredential(row: FakeCredentialRow): FakeCredentialRow {
  return {
    ...row,
    password_salt: row.password_salt === null ? null : Buffer.from(row.password_salt),
    password_derived_key: row.password_derived_key === null ? null : Buffer.from(row.password_derived_key),
  }
}

function copyCredentials(rows: Map<string, FakeCredentialRow>): Map<string, FakeCredentialRow> {
  return new Map([...rows].map(([id, row]) => [id, copyCredential(row)]))
}

class AsyncLock {
  private tail = Promise.resolve()

  async acquire(): Promise<() => void> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise((resolve) => { release = resolve })
    await previous
    return release
  }
}

/** Stateful MySQL test service restricted to SQL owned by this Provider. */
export class FakeMysql {
  readonly credentials = new Map<string, FakeCredentialRow>()
  readonly identifiers: FakeIdentifierRow[] = []
  readonly queries: string[] = []
  schemaVersion: number | undefined
  credentialTableExists = false
  identifierTableExists = false
  failNext: Error | undefined
  failSql: string | undefined
  rollbackFailure: Error | undefined
  zeroNextRevisionUpdate = false
  hideNextPostUpdate = false
  duplicateNextCredential = false
  duplicateNextIdentifier = false
  schemaLockResult: number | null = 1
  schemaUnlockResult: number | null = 1
  afterSchemaLock: (() => Promise<void>) | undefined
  afterSharedCredentialRead: (() => Promise<void>) | undefined
  private nextIdentifierId = 1
  private readonly transactionLock = new AsyncLock()
  private readonly schemaLock = new AsyncLock()

  readonly connection = async <T>(callback: (connection: MysqlConnection) => T | Promise<T>): Promise<T> => {
    return callback(this.driver())
  }

  asService(): Mysql {
    return this as unknown as Mysql
  }

  private driver(): MysqlConnection {
    let inTransaction = false
    let transactionDirty = false
    let transactionCredentials: Map<string, FakeCredentialRow> | undefined
    let transactionIdentifiers: FakeIdentifierRow[] | undefined
    let releaseTransactionLock: (() => void) | undefined
    let releaseSchemaLock: (() => void) | undefined

    const acquireTransactionLock = async (): Promise<void> => {
      if (!inTransaction) throw new Error('transaction lock requested outside transaction')
      if (releaseTransactionLock !== undefined) return
      releaseTransactionLock = await this.transactionLock.acquire()
      transactionCredentials = copyCredentials(this.credentials)
      transactionIdentifiers = structuredClone(this.identifiers)
    }

    const query = async (sql: string, parameters: unknown[] = []): Promise<unknown> => {
      if (this.failNext !== undefined) {
        const failure = this.failNext
        this.failNext = undefined
        throw failure
      }
      const normalized = sql.replaceAll(/\s+/g, ' ').trim()
      this.queries.push(normalized)
      if (this.failSql !== undefined && normalized.includes(this.failSql)) {
        this.failSql = undefined
        throw new Error('targeted SQL failure')
      }
      if (normalized.startsWith('SELECT GET_LOCK(')) {
        if (this.schemaLockResult !== 1) return [[{ acquired: this.schemaLockResult }], []]
        releaseSchemaLock = await this.schemaLock.acquire()
        await this.afterSchemaLock?.()
        return [[{ acquired: this.schemaLockResult }], []]
      }
      if (normalized.startsWith('SELECT RELEASE_LOCK(')) {
        if (releaseSchemaLock === undefined) return [[{ released: 0 }], []]
        releaseSchemaLock()
        releaseSchemaLock = undefined
        return [[{ released: this.schemaUnlockResult }], []]
      }
      if (normalized.startsWith('CREATE TABLE IF NOT EXISTS dsh_user_credential_schema')) return [{ affectedRows: 0 }, []]
      if (normalized.startsWith('SELECT version FROM dsh_user_credential_schema')) {
        return [this.schemaVersion === undefined ? [] : [{ version: this.schemaVersion }], []]
      }
      if (normalized.startsWith('SELECT TABLE_NAME AS table_name FROM information_schema.TABLES')) {
        return [[
          ...(this.credentialTableExists ? [{ table_name: 'dsh_user_credentials' }] : []),
          ...(this.identifierTableExists ? [{ table_name: 'dsh_user_login_identifiers' }] : []),
        ], []]
      }
      if (normalized.startsWith('CREATE TABLE dsh_user_credentials')) {
        this.credentialTableExists = true
        return [{ affectedRows: 0 }, []]
      }
      if (normalized.startsWith('CREATE TABLE dsh_user_login_identifiers')) {
        this.identifierTableExists = true
        return [{ affectedRows: 0 }, []]
      }
      if (normalized.startsWith('INSERT INTO dsh_user_credential_schema')) {
        this.schemaVersion = parameters[1] as number
        return [{ affectedRows: 1 }, []]
      }
      if (normalized.startsWith('SELECT user_id, revision, password_version')
        && (normalized.includes('FOR UPDATE') || normalized.includes('FOR SHARE'))) {
        await acquireTransactionLock()
      }
      const result = this.executeSql(
        normalized,
        parameters,
        transactionCredentials ?? this.credentials,
        transactionIdentifiers ?? this.identifiers,
      )
      if (inTransaction && /^(?:INSERT|DELETE|UPDATE) /.test(normalized)) transactionDirty = true
      if (normalized.includes('FOR SHARE')) await this.afterSharedCredentialRead?.()
      return result
    }
    return {
      query,
      execute: query,
      beginTransaction: async () => {
        if (inTransaction) throw new Error('transaction already active')
        inTransaction = true
      },
      commit: async () => {
        if (!inTransaction || transactionCredentials === undefined || transactionIdentifiers === undefined) throw new Error('no transaction')
        if (transactionDirty) {
          this.credentials.clear()
          for (const [id, row] of transactionCredentials) this.credentials.set(id, row)
          this.identifiers.splice(0, this.identifiers.length, ...transactionIdentifiers)
        }
        inTransaction = false
        releaseTransactionLock?.()
        releaseTransactionLock = undefined
      },
      rollback: async () => {
        const failure = this.rollbackFailure
        inTransaction = false
        transactionCredentials = undefined
        transactionIdentifiers = undefined
        releaseTransactionLock?.()
        releaseTransactionLock = undefined
        if (failure !== undefined) throw failure
      },
    } as unknown as MysqlConnection
  }

  private executeSql(
    sql: string,
    parameters: unknown[],
    credentials: Map<string, FakeCredentialRow>,
    identifiers: FakeIdentifierRow[],
  ): unknown {
    if (sql.startsWith('SELECT user_id, revision, password_version')) {
      const row = credentials.get(parameters[0] as string)
      if (!sql.includes('FOR UPDATE') && this.hideNextPostUpdate) {
        this.hideNextPostUpdate = false
        return [[], []]
      }
      return [row === undefined ? [] : [copyCredential(row)], []]
    }
    if (sql.startsWith('SELECT user_id, kind, normalized_value')) {
      const selected = sql.includes('WHERE user_id = ?')
        ? identifiers.filter(row => row.user_id === parameters[0])
        : identifiers.filter(row => row.kind === parameters[0] && row.normalized_value === parameters[1])
      return [selected.map(row => structuredClone(row)), []]
    }
    if (sql.startsWith('INSERT INTO dsh_user_credentials')) {
      const [userId, updatedAt] = parameters as [string, number]
      if (this.duplicateNextCredential || credentials.has(userId)) {
        this.duplicateNextCredential = false
        throw Object.assign(new Error('duplicate credential'), { code: 'ER_DUP_ENTRY' })
      }
      credentials.set(userId, {
        user_id: userId,
        revision: 0,
        password_version: null,
        password_cost: null,
        password_block_size: null,
        password_parallelization: null,
        password_salt: null,
        password_derived_key: null,
        password_changed_at: null,
        updated_at: updatedAt,
      })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('INSERT INTO dsh_user_login_identifiers')) {
      const [userId, kind, value, createdAt] = parameters as [string, string, string, number]
      if (this.duplicateNextIdentifier || identifiers.some(row => row.kind === kind && row.normalized_value === value)) {
        this.duplicateNextIdentifier = false
        throw Object.assign(new Error('duplicate identifier'), { code: 'ER_DUP_ENTRY' })
      }
      identifiers.push({ identifier_id: this.nextIdentifierId++, user_id: userId, kind, normalized_value: value, created_at: createdAt })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('DELETE FROM dsh_user_login_identifiers')) {
      const [userId, kind, value] = parameters as [string, string, string]
      const index = identifiers.findIndex(row => row.user_id === userId && row.kind === kind && row.normalized_value === value)
      if (index === -1) return [{ affectedRows: 0 }, []]
      identifiers.splice(index, 1)
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('UPDATE dsh_user_credentials SET password_version')) {
      const [version, cost, blockSize, parallelization, salt, derivedKey, changedAt, userId] = parameters as [
        number | null, number | null, number | null, number | null, Buffer | null, Buffer | null, number | null, string,
      ]
      const row = credentials.get(userId)!
      Object.assign(row, {
        password_version: version,
        password_cost: cost,
        password_block_size: blockSize,
        password_parallelization: parallelization,
        password_salt: salt,
        password_derived_key: derivedKey,
        password_changed_at: changedAt,
      })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('UPDATE dsh_user_credentials SET revision')) {
      const [updatedAt, userId, revision] = parameters as [number, string, number]
      const row = credentials.get(userId)
      if (row === undefined || Number(row.revision) !== revision || this.zeroNextRevisionUpdate) {
        this.zeroNextRevisionUpdate = false
        return [{ affectedRows: 0 }, []]
      }
      row.revision = Number(row.revision) + 1
      row.updated_at = updatedAt
      return [{ affectedRows: 1 }, []]
    }
    throw new Error(`unexpected SQL: ${sql}`)
  }
}
