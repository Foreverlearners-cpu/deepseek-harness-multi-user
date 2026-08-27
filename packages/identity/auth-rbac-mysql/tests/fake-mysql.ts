import type { Mysql, MysqlConnection } from '@deepseek-ai/dsh-mysql'

export interface FakeRoleRow {
  role_id: string
  use_actions: unknown
  delegate_actions: unknown
  revision: number | string
  updated_at: number | string
}

export interface FakeBindingRow {
  user_id: string
  tenant_id: string
  team_id: string
  role_id: string
  status: 'active' | 'revoked'
  created_at: number | string
  updated_at: number | string
  revision: number | string
}

function bindingKey(userId: string, tenantId: string, teamId: string, roleId: string): string {
  return `${userId}\0${tenantId}\0${teamId}\0${roleId}`
}

function copyRoles(rows: Map<string, FakeRoleRow>): Map<string, FakeRoleRow> {
  return new Map([...rows].map(([id, row]) => [id, structuredClone(row)]))
}

function copyBindings(rows: Map<string, FakeBindingRow>): Map<string, FakeBindingRow> {
  return new Map([...rows].map(([id, row]) => [id, structuredClone(row)]))
}

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value
}

/** Minimal stateful MySQL service that executes this Provider's owned SQL. */
export class FakeMysql {
  readonly roles = new Map<string, FakeRoleRow>()
  readonly bindings = new Map<string, FakeBindingRow>()
  readonly queries: string[] = []
  schemaVersion: number | undefined
  duplicateSchemaRows = false
  roleTableExists = false
  bindingTableExists = false
  failNext: Error | undefined
  failSql: string | undefined
  rollbackFailure: Error | undefined
  zeroNextUpdate = false
  hideNextPostWrite = false
  duplicateNextRoleInsert = false
  corruptNextRoleActions = false
  private transactionRoles: Map<string, FakeRoleRow> | undefined
  private transactionBindings: Map<string, FakeBindingRow> | undefined

  readonly connection = async <T>(callback: (connection: MysqlConnection) => T | Promise<T>): Promise<T> =>
    callback(this.driver())

  asService(): Mysql {
    return this as unknown as Mysql
  }

  private activeRoles(): Map<string, FakeRoleRow> {
    return this.transactionRoles ?? this.roles
  }

  private activeBindings(): Map<string, FakeBindingRow> {
    return this.transactionBindings ?? this.bindings
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
      if (normalized.startsWith('CREATE TABLE IF NOT EXISTS dsh_rbac_schema')) return [{ affectedRows: 0 }, []]
      if (normalized.startsWith('CREATE TABLE dsh_role_action_grants')) {
        this.roleTableExists = true
        return [{ affectedRows: 0 }, []]
      }
      if (normalized.startsWith('CREATE TABLE dsh_principal_roles')) {
        this.bindingTableExists = true
        return [{ affectedRows: 0 }, []]
      }
      if (normalized.startsWith('INSERT INTO dsh_rbac_schema')) {
        this.schemaVersion = parameters[1] as number
        return [{ affectedRows: 1 }, []]
      }
      if (normalized.startsWith('SELECT version FROM dsh_rbac_schema')) {
        if (this.duplicateSchemaRows) return [[{ version: 1 }, { version: 1 }], []]
        return [this.schemaVersion === undefined ? [] : [{ version: this.schemaVersion }], []]
      }
      if (normalized.startsWith('SELECT TABLE_NAME AS table_name FROM information_schema.TABLES')) {
        const names: { table_name: string }[] = []
        if (this.roleTableExists) names.push({ table_name: 'dsh_role_action_grants' })
        if (this.bindingTableExists) names.push({ table_name: 'dsh_principal_roles' })
        return [names, []]
      }
      return this.executeSql(normalized, parameters)
    }
    const execute = (sql: string, parameters: unknown[] = []): Promise<unknown> =>
      query(sql, parameters)
    return {
      query,
      execute,
      beginTransaction: async () => {
        this.transactionRoles = copyRoles(this.roles)
        this.transactionBindings = copyBindings(this.bindings)
      },
      commit: async () => {
        if (this.transactionRoles === undefined || this.transactionBindings === undefined) {
          throw new Error('no transaction')
        }
        this.roles.clear()
        for (const [id, row] of this.transactionRoles) this.roles.set(id, row)
        this.bindings.clear()
        for (const [id, row] of this.transactionBindings) this.bindings.set(id, row)
        this.transactionRoles = undefined
        this.transactionBindings = undefined
      },
      rollback: async () => {
        if (this.rollbackFailure !== undefined) throw this.rollbackFailure
        this.transactionRoles = undefined
        this.transactionBindings = undefined
      },
    } as unknown as MysqlConnection
  }

  private executeSql(sql: string, parameters: unknown[]): unknown {
    if (sql.startsWith('INSERT INTO dsh_role_action_grants')) {
      if (this.duplicateNextRoleInsert) {
        this.duplicateNextRoleInsert = false
        throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
      }
      const [id, use, delegate, now] = parameters as [string, string, string, number]
      const rows = this.activeRoles()
      if (rows.has(id)) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
      rows.set(id, {
        role_id: id,
        use_actions: parseJson(use),
        delegate_actions: parseJson(delegate),
        revision: 1,
        updated_at: now,
      })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('UPDATE dsh_role_action_grants')) {
      const [use, delegate, now, id] = parameters as [string, string, number, string]
      const rows = this.activeRoles()
      const previous = rows.get(id)
      if (this.zeroNextUpdate) {
        this.zeroNextUpdate = false
        return [{ affectedRows: 0 }, []]
      }
      if (previous === undefined) return [{ affectedRows: 0 }, []]
      rows.set(id, {
        ...previous,
        use_actions: parseJson(use),
        delegate_actions: parseJson(delegate),
        revision: Number(previous.revision) + 1,
        updated_at: now,
      })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('SELECT role_id, use_actions, delegate_actions, revision, updated_at FROM dsh_role_action_grants')) {
      const id = parameters[0] as string
      const postWrite = !sql.includes('FOR UPDATE')
      if (postWrite && this.hideNextPostWrite) {
        this.hideNextPostWrite = false
        return [[], []]
      }
      const row = this.activeRoles().get(id)
      if (row === undefined) return [[], []]
      if (postWrite && this.corruptNextRoleActions) {
        this.corruptNextRoleActions = false
        return [[{ ...row, use_actions: '{' }], []]
      }
      return [[{ ...row }], []]
    }
    if (sql.startsWith('INSERT INTO dsh_principal_roles')) {
      const [user, tenant, team, role, createdAt, updatedAt] = parameters as
        [string, string, string, string, number, number]
      const rows = this.activeBindings()
      const key = bindingKey(user, tenant, team, role)
      if (rows.has(key)) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
      rows.set(key, {
        user_id: user,
        tenant_id: tenant,
        team_id: team,
        role_id: role,
        status: 'active',
        created_at: createdAt,
        updated_at: updatedAt,
        revision: 1,
      })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('UPDATE dsh_principal_roles SET status = \'active\'')) {
      const [createdAt, updatedAt, user, tenant, team, role] = parameters as
        [number, number, string, string, string, string]
      const rows = this.activeBindings()
      const key = bindingKey(user, tenant, team, role)
      const previous = rows.get(key)
      if (this.zeroNextUpdate) {
        this.zeroNextUpdate = false
        return [{ affectedRows: 0 }, []]
      }
      if (previous === undefined || previous.status !== 'revoked') return [{ affectedRows: 0 }, []]
      rows.set(key, {
        ...previous,
        status: 'active',
        created_at: createdAt,
        updated_at: updatedAt,
        revision: 1,
      })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('UPDATE dsh_principal_roles SET status = \'revoked\'')) {
      const [updatedAt, user, tenant, team, role] = parameters as
        [number, string, string, string, string]
      const rows = this.activeBindings()
      const key = bindingKey(user, tenant, team, role)
      const previous = rows.get(key)
      if (this.zeroNextUpdate) {
        this.zeroNextUpdate = false
        return [{ affectedRows: 0 }, []]
      }
      if (previous === undefined || previous.status !== 'active') return [{ affectedRows: 0 }, []]
      rows.set(key, {
        ...previous,
        status: 'revoked',
        updated_at: updatedAt,
        revision: Number(previous.revision) + 1,
      })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('UPDATE dsh_principal_roles SET updated_at = ?')) {
      const [updatedAt, user, tenant, team, role] = parameters as
        [number, string, string, string, string]
      const rows = this.activeBindings()
      const key = bindingKey(user, tenant, team, role)
      const previous = rows.get(key)
      if (this.zeroNextUpdate) {
        this.zeroNextUpdate = false
        return [{ affectedRows: 0 }, []]
      }
      if (previous === undefined || previous.status !== 'active') return [{ affectedRows: 0 }, []]
      rows.set(key, {
        ...previous,
        updated_at: updatedAt,
        revision: Number(previous.revision) + 1,
      })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('SELECT user_id, tenant_id, team_id, role_id, status, created_at, updated_at, revision FROM dsh_principal_roles')) {
      const [user, tenant, team, role] = parameters as [string, string, string, string]
      if (!sql.includes('FOR UPDATE') && this.hideNextPostWrite) {
        this.hideNextPostWrite = false
        return [[], []]
      }
      const row = this.activeBindings().get(bindingKey(user, tenant, team, role))
      return [row === undefined ? [] : [{ ...row }], []]
    }
    if (sql.startsWith('SELECT role_id FROM dsh_principal_roles')) {
      const [user, tenant, team] = parameters as [string, string, string]
      const matches = [...this.activeBindings().values()]
        .filter(row => row.user_id === user
          && row.tenant_id === tenant
          && row.team_id === team
          && row.status === 'active')
        .map(row => ({ role_id: row.role_id }))
        .sort((left, right) => left.role_id.localeCompare(right.role_id))
      return [matches, []]
    }
    throw new Error(`auth-rbac-mysql fake: unsupported SQL ${sql}`)
  }
}
