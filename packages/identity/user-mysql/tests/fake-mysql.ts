import type { Mysql, MysqlConnection } from '@deepseek-ai/dsh-mysql'

export interface FakeUserRow {
  user_id: string
  display_name: string | null
  status: 'active' | 'disabled' | 'deleted'
  created_at: number | string
  updated_at: number | string
  revision: number | string
  extensions: unknown
}

function copyRows(rows: Map<string, FakeUserRow>): Map<string, FakeUserRow> {
  return new Map([...rows].map(([id, row]) => [id, structuredClone(row)]))
}

/** Minimal stateful MySQL service that executes this Provider's owned SQL. */
export class FakeMysql {
  readonly rows = new Map<string, FakeUserRow>()
  schemaVersion = 1
  failNext: Error | undefined
  failSql: string | undefined
  rollbackFailure: Error | undefined
  zeroNextUpdate = false
  hideNextPostUpdate = false
  private transactionRows: Map<string, FakeUserRow> | undefined

  readonly connection = async <T>(callback: (connection: MysqlConnection) => T | Promise<T>): Promise<T> =>
    callback(this.driver())

  asService(): Mysql {
    return this as unknown as Mysql
  }

  private activeRows(): Map<string, FakeUserRow> {
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
      if (this.failSql !== undefined && normalized.includes(this.failSql)) {
        this.failSql = undefined
        throw new Error('targeted SQL failure')
      }
      if (normalized.startsWith('CREATE TABLE')) return [{ affectedRows: 0 }, []]
      if (normalized.startsWith('INSERT IGNORE INTO dsh_user_schema')) return [{ affectedRows: 1 }, []]
      if (normalized.startsWith('SELECT version FROM dsh_user_schema')) {
        return [[{ version: this.schemaVersion }], []]
      }
      return this.executeSql(normalized, parameters)
    }
    const execute = (sql: string, parameters: unknown[] = []): Promise<unknown> =>
      query(sql, parameters)
    return {
      query,
      execute,
      beginTransaction: async () => {
        this.transactionRows = copyRows(this.rows)
      },
      commit: async () => {
        if (this.transactionRows === undefined) throw new Error('no transaction')
        this.rows.clear()
        for (const [id, row] of this.transactionRows) this.rows.set(id, row)
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
    if (sql.startsWith('INSERT INTO dsh_users')) {
      const [id, name, createdAt, updatedAt, extensions] = parameters as [string, string | null, number, number, string]
      if (rows.has(id)) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
      rows.set(id, {
        user_id: id,
        display_name: name,
        status: 'active',
        created_at: createdAt,
        updated_at: updatedAt,
        revision: 1,
        extensions: JSON.parse(extensions) as unknown,
      })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.includes('WHERE user_id = ?') && !sql.includes('ORDER BY')) {
      if (sql.startsWith('SELECT')) {
        const row = rows.get(parameters[0] as string)
        if (!sql.includes('FOR UPDATE') && this.hideNextPostUpdate) {
          this.hideNextPostUpdate = false
          return [[], []]
        }
        return [row === undefined ? [] : [structuredClone(row)], []]
      }
      if (sql.startsWith('UPDATE dsh_users SET display_name')) {
        const [name, extensionJson, updatedAt, id, revision] = parameters as [string | null, string, number, string, number]
        const row = rows.get(id)
        if (row === undefined || Number(row.revision) !== revision) return [{ affectedRows: 0 }, []]
        row.display_name = name
        row.extensions = JSON.parse(extensionJson) as unknown
        row.updated_at = updatedAt
        row.revision = Number(row.revision) + 1
        if (this.zeroNextUpdate) {
          this.zeroNextUpdate = false
          return [{ affectedRows: 0 }, []]
        }
        return [{ affectedRows: 1 }, []]
      }
      if (sql.startsWith('UPDATE dsh_users SET status')) {
        const [status, updatedAt, id, revision] = parameters as [FakeUserRow['status'], number, string, number]
        const row = rows.get(id)
        if (row === undefined || Number(row.revision) !== revision) return [{ affectedRows: 0 }, []]
        row.status = status
        row.updated_at = updatedAt
        row.revision = Number(row.revision) + 1
        if (this.zeroNextUpdate) {
          this.zeroNextUpdate = false
          return [{ affectedRows: 0 }, []]
        }
        return [{ affectedRows: 1 }, []]
      }
    }
    if (sql.includes('ORDER BY user_id ASC LIMIT ?')) {
      let index = 0
      const status = sql.includes('status = ?') ? parameters[index++] as FakeUserRow['status'] : undefined
      const after = sql.includes('user_id > ?') ? parameters[index++] as string : undefined
      const limit = parameters[index] as number
      const page = [...rows.values()]
        .filter(row => status === undefined || row.status === status)
        .filter(row => after === undefined || row.user_id > after)
        .sort((left, right) => left.user_id.localeCompare(right.user_id))
        .slice(0, limit)
        .map(row => structuredClone(row))
      return [page, []]
    }
    throw new Error(`unexpected SQL: ${sql}`)
  }
}
