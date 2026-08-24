import type { Mysql, MysqlConnection } from '@deepseek-ai/dsh-mysql'

export interface FakeFamilyRow {
  token_family_id: string
  principal_kind: 'user' | 'service-account' | 'local'
  principal_id: string
  status: 'active' | 'revoked'
  created_at: number | string
  updated_at: number | string
  expires_at: number | string
  revision: number | string
  revoked_at: number | string | null
  revocation_reason: 'requested' | 'refresh-token-reuse' | null
}

export interface FakeCredentialRow {
  credential_id: string
  token_family_id: string
  digest: string
  status: 'active' | 'rotated' | 'revoked'
  issued_at: number | string
  expires_at: number | string
  rotated_at: number | string | null
  replaced_by: string | null
  revoked_at: number | string | null
}

function copies<T>(rows: Map<string, T>): Map<string, T> {
  return new Map([...rows].map(([id, row]) => [id, structuredClone(row)]))
}

/** Stateful serialized MySQL test service for Provider-owned statements. */
export class FakeMysql {
  readonly families = new Map<string, FakeFamilyRow>()
  readonly credentials = new Map<string, FakeCredentialRow>()
  readonly queries: string[] = []
  schemaVersion: number | undefined
  familyTableExists = false
  credentialTableExists = false
  failNext: Error | undefined
  rollbackFailure: Error | undefined
  zeroNextUpdate = false
  zeroUpdateCountdown: number | undefined
  rejectNextConnection: Error | undefined
  hideNextLockedCredential = false
  mutateNextLockedCredentialDigest: string | undefined
  mutateNextLockedCredentialFamily: string | undefined
  private transactionFamilies: Map<string, FakeFamilyRow> | undefined
  private transactionCredentials: Map<string, FakeCredentialRow> | undefined
  private tail: Promise<void> = Promise.resolve()

  readonly connection = <T>(callback: (connection: MysqlConnection) => T | Promise<T>): Promise<T> => {
    const result = this.tail.then(() => {
      if (this.rejectNextConnection !== undefined) {
        const failure = this.rejectNextConnection
        this.rejectNextConnection = undefined
        throw failure
      }
      return callback(this.driver())
    })
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  asService(): Mysql {
    return this as unknown as Mysql
  }

  private activeFamilies(): Map<string, FakeFamilyRow> {
    return this.transactionFamilies ?? this.families
  }

  private activeCredentials(): Map<string, FakeCredentialRow> {
    return this.transactionCredentials ?? this.credentials
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
      if (normalized.startsWith('CREATE TABLE IF NOT EXISTS dsh_auth_token_schema')) return [{ affectedRows: 0 }, []]
      if (normalized.startsWith('SELECT version FROM dsh_auth_token_schema')) {
        return [this.schemaVersion === undefined ? [] : [{ version: this.schemaVersion }], []]
      }
      if (normalized.startsWith('SELECT TABLE_NAME AS table_name FROM information_schema.TABLES')) {
        const rows = [
          ...(this.familyTableExists ? [{ table_name: 'dsh_auth_token_families' }] : []),
          ...(this.credentialTableExists ? [{ table_name: 'dsh_auth_refresh_credentials' }] : []),
        ]
        return [rows, []]
      }
      if (normalized.startsWith('CREATE TABLE dsh_auth_token_families')) {
        this.familyTableExists = true
        return [{ affectedRows: 0 }, []]
      }
      if (normalized.startsWith('CREATE TABLE dsh_auth_refresh_credentials')) {
        this.credentialTableExists = true
        return [{ affectedRows: 0 }, []]
      }
      if (normalized.startsWith('INSERT INTO dsh_auth_token_schema')) {
        this.schemaVersion = parameters[1] as number
        return [{ affectedRows: 1 }, []]
      }
      return this.executeSql(normalized, parameters)
    }
    return {
      query,
      execute: query,
      beginTransaction: async () => {
        this.transactionFamilies = copies(this.families)
        this.transactionCredentials = copies(this.credentials)
      },
      commit: async () => {
        if (this.transactionFamilies === undefined || this.transactionCredentials === undefined) throw new Error('no transaction')
        this.replace(this.families, this.transactionFamilies)
        this.replace(this.credentials, this.transactionCredentials)
        this.transactionFamilies = undefined
        this.transactionCredentials = undefined
      },
      rollback: async () => {
        if (this.rollbackFailure !== undefined) throw this.rollbackFailure
        this.transactionFamilies = undefined
        this.transactionCredentials = undefined
      },
    } as unknown as MysqlConnection
  }

  private replace<T>(target: Map<string, T>, source: Map<string, T>): void {
    target.clear()
    for (const [id, row] of source) target.set(id, row)
  }

  private executeSql(sql: string, parameters: unknown[]): unknown {
    const families = this.activeFamilies()
    const credentials = this.activeCredentials()
    if (sql.startsWith('INSERT INTO dsh_auth_token_families')) {
      const [id, kind, principalId, status, createdAt, updatedAt, expiresAt, revision] = parameters
      families.set(id as string, {
        token_family_id: id as string,
        principal_kind: kind as FakeFamilyRow['principal_kind'],
        principal_id: principalId as string,
        status: status as FakeFamilyRow['status'],
        created_at: createdAt as number,
        updated_at: updatedAt as number,
        expires_at: expiresAt as number,
        revision: revision as number,
        revoked_at: null,
        revocation_reason: null,
      })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('INSERT INTO dsh_auth_refresh_credentials')) {
      const [id, familyId, digest, fourth, fifth, sixth] = parameters
      const hasStatusParameter = parameters.length === 6
      const status = hasStatusParameter ? fourth as FakeCredentialRow['status'] : 'active'
      const issuedAt = (hasStatusParameter ? fifth : fourth) as number
      const expiresAt = (hasStatusParameter ? sixth : fifth) as number
      if ([...credentials.values()].some(row => row.digest === digest)) throw new Error('duplicate digest')
      credentials.set(id as string, {
        credential_id: id as string,
        token_family_id: familyId as string,
        digest: digest as string,
        status,
        issued_at: issuedAt,
        expires_at: expiresAt,
        rotated_at: null,
        replaced_by: null,
        revoked_at: null,
      })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM dsh_auth_token_families')) {
      let rows = [...families.values()]
      if (sql.includes('token_family_id = ?')) rows = rows.filter(row => row.token_family_id === parameters[0])
      else if (sql.includes('principal_kind = ?')) {
        rows = rows.filter(row => row.principal_kind === parameters[0] && row.principal_id === parameters[1])
      }
      rows.sort((left, right) => left.token_family_id.localeCompare(right.token_family_id))
      return [structuredClone(rows), []]
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM dsh_auth_refresh_credentials')) {
      let rows = [...credentials.values()]
      if (sql.includes('credential_id = ?')) rows = rows.filter(row => row.credential_id === parameters[0])
      else if (sql.includes('digest = ?')) rows = rows.filter(row => row.digest === parameters[0])
      else if (sql.includes('token_family_id IN')) rows = rows.filter(row => parameters.includes(row.token_family_id))
      rows.sort((left, right) => Number(left.issued_at) - Number(right.issued_at)
        || left.credential_id.localeCompare(right.credential_id))
      if (sql.includes('credential_id = ?') && sql.endsWith('FOR UPDATE') && this.hideNextLockedCredential) {
        this.hideNextLockedCredential = false
        rows = []
      }
      if (sql.includes('credential_id = ?') && sql.endsWith('FOR UPDATE') && rows[0] !== undefined) {
        const row = rows[0]
        if (this.mutateNextLockedCredentialDigest !== undefined) {
          row.digest = this.mutateNextLockedCredentialDigest
          this.mutateNextLockedCredentialDigest = undefined
        }
        if (this.mutateNextLockedCredentialFamily !== undefined) {
          row.token_family_id = this.mutateNextLockedCredentialFamily
          this.mutateNextLockedCredentialFamily = undefined
        }
      }
      return [structuredClone(rows), []]
    }
    if (sql.startsWith("UPDATE dsh_auth_refresh_credentials SET status = 'rotated'")) {
      const [time, replacementId, id] = parameters
      const row = credentials.get(id as string)
      if (row === undefined || row.status !== 'active') return [{ affectedRows: 0 }, []]
      row.status = 'rotated'
      row.rotated_at = time as number
      row.replaced_by = replacementId as string
      return [{ affectedRows: this.consumeZeroUpdate() ? 0 : 1 }, []]
    }
    if (sql.startsWith('UPDATE dsh_auth_token_families SET updated_at')) {
      const [time, id, revision] = parameters
      const row = families.get(id as string)
      if (row === undefined || Number(row.revision) !== revision) return [{ affectedRows: 0 }, []]
      row.updated_at = time as number
      row.revision = Number(row.revision) + 1
      return [{ affectedRows: this.consumeZeroUpdate() ? 0 : 1 }, []]
    }
    if (sql.startsWith("UPDATE dsh_auth_token_families SET status = 'revoked'")) {
      const [time, revision, revokedAt, reason, id, expectedRevision] = parameters
      const row = families.get(id as string)
      if (row === undefined || row.status !== 'active' || Number(row.revision) !== expectedRevision) {
        return [{ affectedRows: 0 }, []]
      }
      row.status = 'revoked'
      row.updated_at = time as number
      row.revision = revision as number
      row.revoked_at = revokedAt as number
      row.revocation_reason = reason as FakeFamilyRow['revocation_reason']
      return [{ affectedRows: this.consumeZeroUpdate() ? 0 : 1 }, []]
    }
    if (sql.startsWith("UPDATE dsh_auth_refresh_credentials SET status = 'revoked'")) {
      const [time, familyId] = parameters
      let affectedRows = 0
      for (const row of credentials.values()) {
        if (row.token_family_id === familyId && row.status === 'active') {
          row.status = 'revoked'
          row.revoked_at = time as number
          affectedRows += 1
        }
      }
      return [{ affectedRows }, []]
    }
    throw new Error(`unexpected SQL: ${sql}`)
  }

  private consumeZeroUpdate(): boolean {
    if (this.zeroUpdateCountdown !== undefined) {
      this.zeroUpdateCountdown -= 1
      if (this.zeroUpdateCountdown === 0) {
        this.zeroUpdateCountdown = undefined
        return true
      }
    }
    if (!this.zeroNextUpdate) return false
    this.zeroNextUpdate = false
    return true
  }
}
