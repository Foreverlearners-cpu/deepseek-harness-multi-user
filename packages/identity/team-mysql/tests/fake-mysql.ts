import type { Mysql, MysqlConnection } from '@deepseek-ai/dsh-mysql'

export interface FakeTeamRow {
  team_id: string
  tenant_id: string
  display_name: string | null
  status: 'active' | 'disabled' | 'deleted'
  created_at: number | string
  updated_at: number | string
  revision: number | string
}

export interface FakeMembershipRow {
  team_id: string
  user_id: string
  tenant_id: string
  membership_id: string
  status: 'active' | 'disabled' | 'removed'
  created_at: number | string
  updated_at: number | string
  revision: number | string
}

function membershipKey(teamId: string, userId: string): string {
  return `${teamId}\0${userId}`
}

function copyTeams(rows: Map<string, FakeTeamRow>): Map<string, FakeTeamRow> {
  return new Map([...rows].map(([id, row]) => [id, structuredClone(row)]))
}

function copyMemberships(rows: Map<string, FakeMembershipRow>): Map<string, FakeMembershipRow> {
  return new Map([...rows].map(([id, row]) => [id, structuredClone(row)]))
}

/** Minimal stateful MySQL service that executes this Provider's owned SQL. */
export class FakeMysql {
  readonly teams = new Map<string, FakeTeamRow>()
  readonly memberships = new Map<string, FakeMembershipRow>()
  readonly queries: string[] = []
  schemaVersion: number | undefined
  duplicateSchemaRows = false
  teamTableExists = false
  membershipTableExists = false
  failNext: Error | undefined
  failSql: string | undefined
  rollbackFailure: Error | undefined
  zeroNextUpdate = false
  hideNextPostUpdate = false
  hideNextMembershipRead = false
  emptyTeamOnLock = false
  lockTeamStatus: FakeTeamRow['status'] | undefined
  lockTeamTenantId: string | undefined
  duplicateNextMembershipInsert = false
  private transactionTeams: Map<string, FakeTeamRow> | undefined
  private transactionMemberships: Map<string, FakeMembershipRow> | undefined

  readonly connection = async <T>(callback: (connection: MysqlConnection) => T | Promise<T>): Promise<T> =>
    callback(this.driver())

  asService(): Mysql {
    return this as unknown as Mysql
  }

  private activeTeams(): Map<string, FakeTeamRow> {
    return this.transactionTeams ?? this.teams
  }

  private activeMemberships(): Map<string, FakeMembershipRow> {
    return this.transactionMemberships ?? this.memberships
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
      if (normalized.startsWith('CREATE TABLE IF NOT EXISTS dsh_team_schema')) return [{ affectedRows: 0 }, []]
      if (normalized.startsWith('CREATE TABLE dsh_teams')) {
        this.teamTableExists = true
        return [{ affectedRows: 0 }, []]
      }
      if (normalized.startsWith('CREATE TABLE dsh_team_memberships')) {
        this.membershipTableExists = true
        return [{ affectedRows: 0 }, []]
      }
      if (normalized.startsWith('INSERT INTO dsh_team_schema')) {
        this.schemaVersion = parameters[1] as number
        return [{ affectedRows: 1 }, []]
      }
      if (normalized.startsWith('SELECT version FROM dsh_team_schema')) {
        if (this.duplicateSchemaRows) return [[{ version: 1 }, { version: 1 }], []]
        return [this.schemaVersion === undefined ? [] : [{ version: this.schemaVersion }], []]
      }
      if (normalized.startsWith('SELECT TABLE_NAME AS table_name FROM information_schema.TABLES')) {
        const names: { table_name: string }[] = []
        if (this.teamTableExists) names.push({ table_name: 'dsh_teams' })
        if (this.membershipTableExists) names.push({ table_name: 'dsh_team_memberships' })
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
        this.transactionTeams = copyTeams(this.teams)
        this.transactionMemberships = copyMemberships(this.memberships)
      },
      commit: async () => {
        if (this.transactionTeams === undefined || this.transactionMemberships === undefined) {
          throw new Error('no transaction')
        }
        this.teams.clear()
        for (const [id, row] of this.transactionTeams) this.teams.set(id, row)
        this.memberships.clear()
        for (const [id, row] of this.transactionMemberships) this.memberships.set(id, row)
        this.transactionTeams = undefined
        this.transactionMemberships = undefined
      },
      rollback: async () => {
        if (this.rollbackFailure !== undefined) throw this.rollbackFailure
        this.transactionTeams = undefined
        this.transactionMemberships = undefined
      },
    } as unknown as MysqlConnection
  }

  private executeSql(sql: string, parameters: unknown[]): unknown {
    if (sql.startsWith('INSERT INTO dsh_teams')) {
      const [id, tenantId, name, createdAt, updatedAt] = parameters as
        [string, string, string | null, number, number]
      const rows = this.activeTeams()
      if (rows.has(id)) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
      rows.set(id, {
        team_id: id,
        tenant_id: tenantId,
        display_name: name,
        status: 'active',
        created_at: createdAt,
        updated_at: updatedAt,
        revision: 1,
      })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('INSERT INTO dsh_team_memberships')) {
      const [teamId, userId, tenantId, membershipId, createdAt, updatedAt] = parameters as
        [string, string, string, string, number, number]
      const rows = this.activeMemberships()
      const key = membershipKey(teamId, userId)
      if (this.duplicateNextMembershipInsert) {
        this.duplicateNextMembershipInsert = false
        throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
      }
      if (rows.has(key) || [...rows.values()].some(row => row.membership_id === membershipId)) {
        throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
      }
      rows.set(key, {
        team_id: teamId,
        user_id: userId,
        tenant_id: tenantId,
        membership_id: membershipId,
        status: 'active',
        created_at: createdAt,
        updated_at: updatedAt,
        revision: 1,
      })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM dsh_teams WHERE team_id = ?')) {
      if (sql.includes('FOR UPDATE') && this.emptyTeamOnLock) {
        this.emptyTeamOnLock = false
        return [[], []]
      }
      const row = this.activeTeams().get(parameters[0] as string)
      if (!sql.includes('FOR UPDATE') && this.hideNextPostUpdate) {
        this.hideNextPostUpdate = false
        return [[], []]
      }
      if (row === undefined) return [[], []]
      const current = structuredClone(row)
      if (sql.includes('FOR UPDATE') && this.lockTeamStatus !== undefined) {
        current.status = this.lockTeamStatus
        this.lockTeamStatus = undefined
      }
      if (sql.includes('FOR UPDATE') && this.lockTeamTenantId !== undefined) {
        current.tenant_id = this.lockTeamTenantId
        this.lockTeamTenantId = undefined
      }
      return [[current], []]
    }
    if (sql.startsWith('UPDATE dsh_teams SET status')) {
      const [status, updatedAt, id, revision] = parameters as [FakeTeamRow['status'], number, string, number]
      const row = this.activeTeams().get(id)
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
    if (sql.startsWith('SELECT') && sql.includes('FROM dsh_team_memberships') && sql.includes('ORDER BY')) {
      return this.listMemberships(sql, parameters)
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM dsh_team_memberships WHERE team_id = ? AND user_id = ?')) {
      const row = this.activeMemberships().get(membershipKey(parameters[0] as string, parameters[1] as string))
      if (!sql.includes('FOR UPDATE') && (this.hideNextPostUpdate || this.hideNextMembershipRead)) {
        this.hideNextPostUpdate = false
        this.hideNextMembershipRead = false
        return [[], []]
      }
      return [row === undefined ? [] : [structuredClone(row)], []]
    }
    if (sql.startsWith('UPDATE dsh_team_memberships SET membership_id')) {
      const [membershipId, tenantId, createdAt, updatedAt, teamId, userId] = parameters as
        [string, string, number, number, string, string]
      const row = this.activeMemberships().get(membershipKey(teamId, userId))
      if (row === undefined || row.status !== 'removed') return [{ affectedRows: 0 }, []]
      row.membership_id = membershipId
      row.tenant_id = tenantId
      row.status = 'active'
      row.created_at = createdAt
      row.updated_at = updatedAt
      row.revision = 1
      if (this.zeroNextUpdate) {
        this.zeroNextUpdate = false
        return [{ affectedRows: 0 }, []]
      }
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('UPDATE dsh_team_memberships SET status')) {
      const [status, updatedAt, teamId, userId, revision] = parameters as
        [FakeMembershipRow['status'], number, string, string, number]
      const row = this.activeMemberships().get(membershipKey(teamId, userId))
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
    throw new Error(`unexpected SQL: ${sql}`)
  }

  private listMemberships(sql: string, parameters: unknown[]): unknown {
    let index = 0
    const teamId = sql.includes('team_id = ?') ? parameters[index++] as string : undefined
    const userId = sql.includes('user_id = ?') ? parameters[index++] as string : undefined
    const tenantId = sql.includes('tenant_id = ?') ? parameters[index++] as string : undefined
    const status = sql.includes('status = ?') ? parameters[index++] as FakeMembershipRow['status'] : undefined
    const after = sql.includes('membership_id > ?') ? parameters[index++] as string : undefined
    const limit = parameters[index] as number
    const page = [...this.activeMemberships().values()]
      .filter(row => teamId === undefined || row.team_id === teamId)
      .filter(row => userId === undefined || row.user_id === userId)
      .filter(row => tenantId === undefined || row.tenant_id === tenantId)
      .filter(row => status === undefined || row.status === status)
      .filter(row => after === undefined || row.membership_id > after)
      .sort((left, right) => left.membership_id.localeCompare(right.membership_id))
      .slice(0, limit)
      .map(row => structuredClone(row))
    return [page, []]
  }
}
