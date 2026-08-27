import type { Mysql, MysqlConnection } from '@deepseek-ai/dsh-mysql'

export interface FakeGrantRow {
  resource_type: string
  resource_id: string
  resource_revision: number | string
  subject_ref: string
  use_actions: unknown
  delegate_actions: unknown
  status: 'active' | 'revoked'
  created_at: number | string
  updated_at: number | string
  revision: number | string
}

function grantKey(type: string, id: string, revision: number | string, subject: string): string {
  return `${type}\0${id}\0${String(revision)}\0${subject}`
}

function copyGrants(rows: Map<string, FakeGrantRow>): Map<string, FakeGrantRow> {
  return new Map([...rows].map(([id, row]) => [id, structuredClone(row)]))
}

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value
}

/** Minimal stateful MySQL service that executes this Provider's owned SQL. */
export class FakeMysql {
  readonly grants = new Map<string, FakeGrantRow>()
  readonly queries: string[] = []
  schemaVersion: number | undefined
  duplicateSchemaRows = false
  grantTableExists = false
  failNext: Error | undefined
  failSql: string | undefined
  rollbackFailure: Error | undefined
  zeroNextUpdate = false
  hideNextPostWrite = false
  duplicateNextInsert = false
  corruptNextGrant = false
  private transactionGrants: Map<string, FakeGrantRow> | undefined

  readonly connection = async <T>(callback: (connection: MysqlConnection) => T | Promise<T>): Promise<T> =>
    callback(this.driver())

  asService(): Mysql {
    return this as unknown as Mysql
  }

  private activeGrants(): Map<string, FakeGrantRow> {
    return this.transactionGrants ?? this.grants
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
      if (this.failSql !== undefined && normalized.includes(this.failSql)) {
        this.failSql = undefined
        throw new Error('targeted SQL failure')
      }
      if (normalized.startsWith('CREATE TABLE IF NOT EXISTS dsh_acl_schema')) return [{ affectedRows: 0 }, []]
      if (normalized.startsWith('CREATE TABLE dsh_resource_action_grants')) {
        this.grantTableExists = true
        return [{ affectedRows: 0 }, []]
      }
      if (normalized.startsWith('INSERT INTO dsh_acl_schema')) {
        this.schemaVersion = parameters[1] as number
        return [{ affectedRows: 1 }, []]
      }
      if (normalized.startsWith('SELECT version FROM dsh_acl_schema')) {
        if (this.duplicateSchemaRows) return [[{ version: 1 }, { version: 1 }], []]
        return [this.schemaVersion === undefined ? [] : [{ version: this.schemaVersion }], []]
      }
      if (normalized.startsWith('SELECT TABLE_NAME AS table_name FROM information_schema.TABLES')) {
        return [this.grantTableExists ? [{ table_name: 'dsh_resource_action_grants' }] : [], []]
      }
      return this.executeSql(normalized, parameters)
    }
    const execute = (sql: string, parameters: unknown[] = []): Promise<unknown> =>
      query(sql, parameters)
    return {
      query,
      execute,
      beginTransaction: async () => {
        this.transactionGrants = copyGrants(this.grants)
      },
      commit: async () => {
        if (this.transactionGrants === undefined) throw new Error('no transaction')
        this.grants.clear()
        for (const [id, row] of this.transactionGrants) this.grants.set(id, row)
        this.transactionGrants = undefined
      },
      rollback: async () => {
        if (this.rollbackFailure !== undefined) throw this.rollbackFailure
        this.transactionGrants = undefined
      },
    } as unknown as MysqlConnection
  }

  private executeSql(sql: string, parameters: unknown[]): unknown {
    if (sql.startsWith('INSERT INTO dsh_resource_action_grants')) {
      if (this.duplicateNextInsert) {
        this.duplicateNextInsert = false
        throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
      }
      const [type, id, revision, subject, use, delegate, createdAt, updatedAt] = parameters as
        [string, string, number, string, string, string, number, number]
      const rows = this.activeGrants()
      const key = grantKey(type, id, revision, subject)
      if (rows.has(key)) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
      rows.set(key, {
        resource_type: type,
        resource_id: id,
        resource_revision: revision,
        subject_ref: subject,
        use_actions: parseJson(use),
        delegate_actions: parseJson(delegate),
        status: 'active',
        created_at: createdAt,
        updated_at: updatedAt,
        revision: 1,
      })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.includes('SET use_actions = ?, delegate_actions = ?, status = \'active\'')) {
      const [use, delegate, createdAt, updatedAt, type, id, revision, subject] = parameters as
        [string, string, number, number, string, string, number, string]
      return this.updateGrant(type, id, revision, subject, row => ({
        ...row,
        use_actions: parseJson(use),
        delegate_actions: parseJson(delegate),
        status: 'active',
        created_at: createdAt,
        updated_at: updatedAt,
        revision: 1,
      }), row => row.status === 'revoked')
    }
    if (sql.includes('SET use_actions = ?, delegate_actions = ?, updated_at = ?')) {
      const [use, delegate, updatedAt, type, id, revision, subject] = parameters as
        [string, string, number, string, string, number, string]
      return this.updateGrant(type, id, revision, subject, row => ({
        ...row,
        use_actions: parseJson(use),
        delegate_actions: parseJson(delegate),
        updated_at: updatedAt,
        revision: Number(row.revision) + 1,
      }), row => row.status === 'active')
    }
    if (sql.includes('SET status = \'revoked\'')) {
      const [updatedAt, type, id, revision, subject] = parameters as
        [number, string, string, number, string]
      return this.updateGrant(type, id, revision, subject, row => ({
        ...row,
        status: 'revoked',
        updated_at: updatedAt,
        revision: Number(row.revision) + 1,
      }), row => row.status === 'active')
    }
    if (sql.startsWith('SELECT resource_type, resource_id, resource_revision, subject_ref')) {
      return this.selectGrants(sql, parameters)
    }
    throw new Error(`authority-acl-mysql fake: unsupported SQL ${sql}`)
  }

  private updateGrant(
    type: string,
    id: string,
    revision: number,
    subject: string,
    next: (row: FakeGrantRow) => FakeGrantRow,
    allowed: (row: FakeGrantRow) => boolean,
  ): unknown {
    const rows = this.activeGrants()
    const key = grantKey(type, id, revision, subject)
    const previous = rows.get(key)
    if (this.zeroNextUpdate) {
      this.zeroNextUpdate = false
      return [{ affectedRows: 0 }, []]
    }
    if (previous === undefined || !allowed(previous)) return [{ affectedRows: 0 }, []]
    rows.set(key, next(previous))
    return [{ affectedRows: 1 }, []]
  }

  private selectGrants(sql: string, parameters: unknown[]): unknown {
    const postWrite = !sql.includes('FOR UPDATE')
    if (postWrite && this.hideNextPostWrite && sql.includes('subject_ref = ?')) {
      this.hideNextPostWrite = false
      return [[], []]
    }
    const rows = [...this.activeGrants().values()]
    let matched: FakeGrantRow[]
    if (sql.includes('subject_ref = ?')) {
      const [type, id, revision, subject] = parameters as [string, string, number, string]
      const row = this.activeGrants().get(grantKey(type, id, revision, subject))
      matched = row === undefined ? [] : [row]
    } else if (sql.includes('resource_revision = ?')) {
      const [type, id, revision] = parameters as [string, string, number]
      matched = rows.filter(row => row.resource_type === type
        && row.resource_id === id
        && Number(row.resource_revision) === revision
        && row.status === 'active')
        .sort((left, right) => left.subject_ref.localeCompare(right.subject_ref))
    } else {
      const [type, id] = parameters as [string, string]
      matched = rows.filter(row => row.resource_type === type
        && row.resource_id === id
        && row.status === 'active')
        .sort((left, right) => {
          const revision = Number(left.resource_revision) - Number(right.resource_revision)
          return revision === 0 ? left.subject_ref.localeCompare(right.subject_ref) : revision
        })
    }
    if (postWrite && this.corruptNextGrant && matched[0] !== undefined) {
      this.corruptNextGrant = false
      return [[{ ...matched[0], use_actions: '{' }], []]
    }
    return [[...matched.map(row => ({ ...row }))], []]
  }
}
