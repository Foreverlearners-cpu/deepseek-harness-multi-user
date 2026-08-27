/** MySQL persistence Provider for the tenant and membership directory.
 * @module @deepseek-ai/dsh-tenant-mysql
 */

import { Service } from '@deepseek-ai/cordis'
import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import TenantDirectory, {
  TenantDirectoryError,
  membershipId,
  tenantId,
  type MembershipCreateRecordInput,
  type MembershipListQuery,
  type MembershipMutation,
  type MembershipMutationCommit,
  type MembershipPage,
  type MembershipRecord,
  type MembershipStatus,
  type TenantCreateRecordInput,
  type TenantId,
  type TenantMutation,
  type TenantMutationCommit,
  type TenantRecord,
  type TenantStatus,
} from '@deepseek-ai/dsh-tenant'
import { userId, type UserId } from '@deepseek-ai/dsh-user'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { decodeCursor, encodeCursor } from './cursor.ts'
import { newMembershipId, newTenantId } from './ids.ts'
import { initializeSchema } from './schema.ts'

export { TENANT_MYSQL_SCHEMA_VERSION } from './schema.ts'

interface TenantRow extends RowDataPacket {
  tenant_id: string
  display_name: string | null
  status: TenantStatus
  created_at: number | string
  updated_at: number | string
  revision: number | string
}

interface MembershipRow extends RowDataPacket {
  tenant_id: string
  user_id: string
  membership_id: string
  status: MembershipStatus
  created_at: number | string
  updated_at: number | string
  revision: number | string
}

const TENANT_COLUMNS = 'tenant_id, display_name, status, created_at, updated_at, revision'
const MEMBERSHIP_COLUMNS = 'tenant_id, user_id, membership_id, status, created_at, updated_at, revision'

function safeInteger(value: number | string, field: string): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error(`tenant-mysql: invalid ${field}`)
  return numeric
}

function tenantRecord(row: TenantRow): TenantRecord {
  return {
    tenantId: tenantId(row.tenant_id),
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    status: row.status,
    createdAt: safeInteger(row.created_at, 'created_at'),
    updatedAt: safeInteger(row.updated_at, 'updated_at'),
    revision: safeInteger(row.revision, 'revision'),
  }
}

function membershipRecord(row: MembershipRow): MembershipRecord {
  return {
    membershipId: membershipId(row.membership_id),
    tenantId: tenantId(row.tenant_id),
    userId: userId(row.user_id),
    status: row.status,
    createdAt: safeInteger(row.created_at, 'created_at'),
    updatedAt: safeInteger(row.updated_at, 'updated_at'),
    revision: safeInteger(row.revision, 'revision'),
  }
}

function tenantConflict(previous: TenantRecord, mutation: TenantMutation): void {
  if (previous.revision !== mutation.expectedRevision) {
    throw new TenantDirectoryError('revision-conflict', 'tenant-mysql: tenant revision changed')
  }
  if (previous.status === 'deleted') {
    throw new TenantDirectoryError('tenant-deleted', 'tenant-mysql: tenant is deleted')
  }
  const allowed = mutation.status === 'disabled'
    ? previous.status === 'active'
    : mutation.status === 'active'
      ? previous.status === 'disabled'
      : true
  if (!allowed) throw new TenantDirectoryError('status-conflict', 'tenant-mysql: tenant status conflicts')
}

function membershipConflict(previous: MembershipRecord, mutation: MembershipMutation): void {
  if (previous.revision !== mutation.expectedRevision) {
    throw new TenantDirectoryError('revision-conflict', 'tenant-mysql: membership revision changed')
  }
  if (previous.status === 'removed') {
    throw new TenantDirectoryError('membership-removed', 'tenant-mysql: membership is removed')
  }
  const allowed = mutation.status === 'disabled'
    ? previous.status === 'active'
    : mutation.status === 'active'
      ? previous.status === 'disabled'
      : true
  if (!allowed) throw new TenantDirectoryError('status-conflict', 'tenant-mysql: membership status conflicts')
}

async function rollback(connection: MysqlConnection, cause: unknown): Promise<never> {
  try {
    await connection.rollback()
  } catch (rollbackCause) {
    throw new TenantDirectoryError('provider-unavailable', 'tenant-mysql: transaction rollback failed', {
      cause: new AggregateError([cause, rollbackCause]),
    })
  }
  throw cause
}

function isDuplicate(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'ER_DUP_ENTRY'
}

/** Durable `ctx.tenants` Provider backed by the injected MySQL connection service. */
export class TenantMysqlDirectory extends TenantDirectory {
  static inject = ['mysql']

  /** Initialize and verify the Provider-owned schema before serving requests. */
  async [Service.init](): Promise<void> {
    await this.ctx.mysql.connection(initializeSchema)
  }

  protected async createTenantRecord(input: TenantCreateRecordInput): Promise<TenantRecord> {
    const id = newTenantId()
    const now = Date.now()
    await this.ctx.mysql.connection(async (connection) => {
      await connection.execute(
        `INSERT INTO dsh_tenants
          (tenant_id, display_name, status, created_at, updated_at, revision)
         VALUES (?, ?, 'active', ?, ?, 1)`,
        [id, input.displayName ?? null, now, now],
      )
    })
    return {
      tenantId: id,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      revision: 1,
    }
  }

  protected async readTenantRecord(id: TenantId): Promise<TenantRecord | undefined> {
    return this.ctx.mysql.connection(async (connection) => {
      const [rows] = await connection.execute<TenantRow[]>(
        `SELECT ${TENANT_COLUMNS} FROM dsh_tenants WHERE tenant_id = ?`,
        [id],
      )
      const row = rows[0]
      return row === undefined ? undefined : tenantRecord(row)
    })
  }

  protected async mutateTenantRecord(mutation: TenantMutation): Promise<TenantMutationCommit> {
    return this.ctx.mysql.connection(async (connection) => {
      await connection.beginTransaction()
      try {
        const [rows] = await connection.execute<TenantRow[]>(
          `SELECT ${TENANT_COLUMNS} FROM dsh_tenants WHERE tenant_id = ? FOR UPDATE`,
          [mutation.tenantId],
        )
        const row = rows[0]
        if (row === undefined) throw new TenantDirectoryError('tenant-not-found', 'tenant-mysql: tenant was not found')
        const previous = tenantRecord(row)
        tenantConflict(previous, mutation)
        const now = Math.max(Date.now(), previous.updatedAt)
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE dsh_tenants SET status = ?, updated_at = ?, revision = revision + 1
           WHERE tenant_id = ? AND revision = ?`,
          [mutation.status, now, mutation.tenantId, mutation.expectedRevision],
        )
        if (result.affectedRows !== 1) throw new Error('tenant-mysql: locked tenant update affected no row')
        const [currentRows] = await connection.execute<TenantRow[]>(
          `SELECT ${TENANT_COLUMNS} FROM dsh_tenants WHERE tenant_id = ?`,
          [mutation.tenantId],
        )
        const currentRow = currentRows[0]
        if (currentRow === undefined) throw new Error('tenant-mysql: committed tenant row disappeared')
        const current = tenantRecord(currentRow)
        await connection.commit()
        return { previous, current }
      } catch (cause) {
        return rollback(connection, cause)
      }
    })
  }

  protected async createMembershipRecord(input: MembershipCreateRecordInput): Promise<MembershipRecord> {
    return this.ctx.mysql.connection(async (connection) => {
      await connection.beginTransaction()
      try {
        // Lock the tenant row first, then the (tenant_id, user_id) membership slot.
        const [tenantRows] = await connection.execute<TenantRow[]>(
          `SELECT ${TENANT_COLUMNS} FROM dsh_tenants WHERE tenant_id = ? FOR UPDATE`,
          [input.tenantId],
        )
        const tenantRow = tenantRows[0]
        if (tenantRow === undefined) {
          throw new TenantDirectoryError('tenant-not-found', 'tenant-mysql: tenant was not found')
        }
        const tenant = tenantRecord(tenantRow)
        if (tenant.status === 'disabled') {
          throw new TenantDirectoryError('tenant-disabled', 'tenant-mysql: tenant is disabled')
        }
        if (tenant.status === 'deleted') {
          throw new TenantDirectoryError('tenant-deleted', 'tenant-mysql: tenant is deleted')
        }
        const [existingRows] = await connection.execute<MembershipRow[]>(
          `SELECT ${MEMBERSHIP_COLUMNS} FROM dsh_tenant_memberships
           WHERE tenant_id = ? AND user_id = ? FOR UPDATE`,
          [input.tenantId, input.userId],
        )
        const existing = existingRows[0]
        if (existing !== undefined && existing.status !== 'removed') {
          throw new TenantDirectoryError('membership-conflict', 'tenant-mysql: membership already exists')
        }
        const id = newMembershipId()
        const now = Date.now()
        if (existing === undefined) {
          try {
            await connection.execute(
              `INSERT INTO dsh_tenant_memberships
                (tenant_id, user_id, membership_id, status, created_at, updated_at, revision)
               VALUES (?, ?, ?, 'active', ?, ?, 1)`,
              [input.tenantId, input.userId, id, now, now],
            )
          } catch (cause) {
            if (isDuplicate(cause)) {
              throw new TenantDirectoryError('membership-conflict', 'tenant-mysql: membership already exists', { cause })
            }
            throw cause
          }
        } else {
          const [result] = await connection.execute<ResultSetHeader>(
            `UPDATE dsh_tenant_memberships
             SET membership_id = ?, status = 'active', created_at = ?, updated_at = ?, revision = 1
             WHERE tenant_id = ? AND user_id = ? AND status = 'removed'`,
            [id, now, now, input.tenantId, input.userId],
          )
          if (result.affectedRows !== 1) throw new Error('tenant-mysql: locked membership re-add affected no row')
        }
        const [currentRows] = await connection.execute<MembershipRow[]>(
          `SELECT ${MEMBERSHIP_COLUMNS} FROM dsh_tenant_memberships WHERE tenant_id = ? AND user_id = ?`,
          [input.tenantId, input.userId],
        )
        const currentRow = currentRows[0]
        if (currentRow === undefined) throw new Error('tenant-mysql: committed membership row disappeared')
        const current = membershipRecord(currentRow)
        await connection.commit()
        return current
      } catch (cause) {
        return rollback(connection, cause)
      }
    })
  }

  protected async readMembershipRecord(id: TenantId, member: UserId): Promise<MembershipRecord | undefined> {
    return this.ctx.mysql.connection(async (connection) => {
      const [rows] = await connection.execute<MembershipRow[]>(
        `SELECT ${MEMBERSHIP_COLUMNS} FROM dsh_tenant_memberships WHERE tenant_id = ? AND user_id = ?`,
        [id, member],
      )
      const row = rows[0]
      return row === undefined ? undefined : membershipRecord(row)
    })
  }

  protected async mutateMembershipRecord(mutation: MembershipMutation): Promise<MembershipMutationCommit> {
    return this.ctx.mysql.connection(async (connection) => {
      await connection.beginTransaction()
      try {
        const [rows] = await connection.execute<MembershipRow[]>(
          `SELECT ${MEMBERSHIP_COLUMNS} FROM dsh_tenant_memberships
           WHERE tenant_id = ? AND user_id = ? FOR UPDATE`,
          [mutation.tenantId, mutation.userId],
        )
        const row = rows[0]
        if (row === undefined) {
          throw new TenantDirectoryError('membership-not-found', 'tenant-mysql: membership was not found')
        }
        const previous = membershipRecord(row)
        membershipConflict(previous, mutation)
        const now = Math.max(Date.now(), previous.updatedAt)
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE dsh_tenant_memberships SET status = ?, updated_at = ?, revision = revision + 1
           WHERE tenant_id = ? AND user_id = ? AND revision = ?`,
          [mutation.status, now, mutation.tenantId, mutation.userId, mutation.expectedRevision],
        )
        if (result.affectedRows !== 1) throw new Error('tenant-mysql: locked membership update affected no row')
        const [currentRows] = await connection.execute<MembershipRow[]>(
          `SELECT ${MEMBERSHIP_COLUMNS} FROM dsh_tenant_memberships WHERE tenant_id = ? AND user_id = ?`,
          [mutation.tenantId, mutation.userId],
        )
        const currentRow = currentRows[0]
        if (currentRow === undefined) throw new Error('tenant-mysql: committed membership row disappeared')
        const current = membershipRecord(currentRow)
        await connection.commit()
        return { previous, current }
      } catch (cause) {
        return rollback(connection, cause)
      }
    })
  }

  protected async listMembershipRecords(query: MembershipListQuery): Promise<MembershipPage> {
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, query)
    const clauses: string[] = []
    const parameters: (number | string)[] = []
    if (query.scope === 'tenant') {
      clauses.push('tenant_id = ?')
      parameters.push(query.tenantId)
    } else {
      clauses.push('user_id = ?')
      parameters.push(query.userId)
    }
    if (query.status !== undefined) {
      clauses.push('status = ?')
      parameters.push(query.status)
    }
    if (after !== undefined) {
      clauses.push('membership_id > ?')
      parameters.push(after)
    }
    parameters.push(query.limit + 1)
    return this.ctx.mysql.connection(async (connection) => {
      const [rows] = await connection.execute<MembershipRow[]>(
        `SELECT ${MEMBERSHIP_COLUMNS} FROM dsh_tenant_memberships
         WHERE ${clauses.join(' AND ')} ORDER BY membership_id ASC LIMIT ?`,
        parameters,
      )
      const hasMore = rows.length > query.limit
      const memberships = rows.slice(0, query.limit).map(membershipRecord)
      const last = memberships.at(-1)
      return {
        memberships,
        ...(hasMore && last !== undefined ? { nextCursor: encodeCursor(last.membershipId, query) } : {}),
      }
    })
  }
}

export default TenantMysqlDirectory
