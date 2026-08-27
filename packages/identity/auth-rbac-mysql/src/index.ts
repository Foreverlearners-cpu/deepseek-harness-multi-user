/** MySQL persistence Provider for team-scoped roles and principal-role bindings.
 * @module @deepseek-ai/dsh-auth-rbac-mysql
 */

import { Service } from '@deepseek-ai/cordis'
import {
  AuthRbacError,
  roleId,
  type PrincipalRoleBinding,
  type PrincipalRoleQuery,
  type RbacPolicySource,
  type RoleActionSets,
  type RoleDefinition,
  type RoleId,
} from '@deepseek-ai/dsh-auth-rbac'
import { actionCode } from '@deepseek-ai/dsh-auth-rbac/src/ids.ts'
import type { ActionCode } from '@deepseek-ai/dsh-authority/types'
import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import { teamId, type TeamId } from '@deepseek-ai/dsh-team'
import { tenantId, type TenantId } from '@deepseek-ai/dsh-tenant'
import { userId, type UserId } from '@deepseek-ai/dsh-user'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { initializeSchema } from './schema.ts'

export { AUTH_RBAC_MYSQL_SCHEMA_VERSION } from './schema.ts'

/** Durable role catalog row including the monotonic revision used to invalidate stale sets. */
export interface RoleGrantRecord {
  readonly roleId: RoleId
  readonly use: readonly ActionCode[]
  readonly delegate: readonly ActionCode[]
  readonly revision: number
  readonly updatedAt: number
}

/** Durable principal-role binding including status and revision. */
export interface PrincipalRoleRecord {
  readonly userId: UserId
  readonly tenantId: TenantId
  readonly teamId: TeamId
  readonly roleId: RoleId
  readonly status: 'active' | 'revoked'
  readonly createdAt: number
  readonly updatedAt: number
  readonly revision: number
}

interface RoleRow extends RowDataPacket {
  role_id: string
  use_actions: unknown
  delegate_actions: unknown
  revision: number | string
  updated_at: number | string
}

interface BindingRow extends RowDataPacket {
  user_id: string
  tenant_id: string
  team_id: string
  role_id: string
  status: 'active' | 'revoked'
  created_at: number | string
  updated_at: number | string
  revision: number | string
}

interface RoleIdRow extends RowDataPacket {
  role_id: string
}

const ROLE_COLUMNS = 'role_id, use_actions, delegate_actions, revision, updated_at'
const BINDING_COLUMNS = 'user_id, tenant_id, team_id, role_id, status, created_at, updated_at, revision'

function unavailable(message: string, options?: ErrorOptions): AuthRbacError {
  return new AuthRbacError('provider-unavailable', `auth-rbac-mysql: ${message}`, options)
}

function safeInteger(value: number | string, field: string): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error(`auth-rbac-mysql: invalid ${field}`)
  return numeric
}

function actionList(value: unknown, field: string): readonly ActionCode[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
  if (!Array.isArray(parsed)) throw new Error(`auth-rbac-mysql: invalid ${field}`)
  return Object.freeze(parsed.map((entry) => {
    if (typeof entry !== 'string') throw new Error(`auth-rbac-mysql: invalid ${field}`)
    return actionCode(entry)
  }))
}

function encodeActions(actions: readonly string[]): string {
  return JSON.stringify(actions.map(entry => actionCode(entry)))
}

function roleRecord(row: RoleRow): RoleGrantRecord {
  try {
    return {
      roleId: roleId(row.role_id),
      use: actionList(row.use_actions, 'use_actions'),
      delegate: actionList(row.delegate_actions, 'delegate_actions'),
      revision: safeInteger(row.revision, 'revision'),
      updatedAt: safeInteger(row.updated_at, 'updated_at'),
    }
  } catch (cause) {
    throw unavailable('stored role row is invalid', { cause })
  }
}

function bindingRecord(row: BindingRow): PrincipalRoleRecord {
  try {
    return {
      userId: userId(row.user_id),
      tenantId: tenantId(row.tenant_id),
      teamId: teamId(row.team_id),
      roleId: roleId(row.role_id),
      status: row.status,
      createdAt: safeInteger(row.created_at, 'created_at'),
      updatedAt: safeInteger(row.updated_at, 'updated_at'),
      revision: safeInteger(row.revision, 'revision'),
    }
  } catch (cause) {
    throw unavailable('stored binding row is invalid', { cause })
  }
}

function rewrite(cause: unknown): never {
  if (cause instanceof AuthRbacError || cause instanceof TypeError) throw cause
  throw unavailable('policy store failed', { cause })
}

async function rollback(connection: MysqlConnection, cause: unknown): Promise<never> {
  try {
    await connection.rollback()
  } catch (rollbackCause) {
    throw unavailable('transaction rollback failed', {
      cause: new AggregateError([cause, rollbackCause]),
    })
  }
  rewrite(cause)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable MySQL role catalog and principal-role bindings. */
    authRbacMysql: AuthRbacMysql
  }
}

/** Durable `RbacPolicySource` that registers on `ctx.authRbac` and owns role SQL. */
export class AuthRbacMysql extends Service implements RbacPolicySource {
  static inject = ['mysql', 'authRbac']

  /** @param ctx - owning Host context. */
  constructor(ctx: ConstructorParameters<typeof Service>[0]) {
    super(ctx, 'authRbacMysql')
  }

  /** Initialize the schema and register this instance as the sole policy source. */
  async [Service.init](): Promise<void> {
    await this.ctx.mysql.connection(initializeSchema)
    this.ctx.effect(() => this.ctx.authRbac.registerSource(this))
  }

  /** Define or replace one role's Use and Delegate sets and increment its revision.
   * @param definition - role id and the two action sets.
   * @returns committed role grant including the new revision.
   */
  async putRole(definition: RoleDefinition): Promise<RoleGrantRecord> {
    const id = roleId(definition.roleId)
    const use = encodeActions(definition.use)
    const delegate = encodeActions(definition.delegate)
    try {
      return await this.ctx.mysql.connection(async (connection) => {
        await connection.beginTransaction()
        try {
          const [rows] = await connection.execute<RoleRow[]>(
            `SELECT ${ROLE_COLUMNS} FROM dsh_role_action_grants WHERE role_id = ? FOR UPDATE`,
            [id],
          )
          const now = Date.now()
          const existing = rows[0]
          if (existing === undefined) {
            await connection.execute(
              `INSERT INTO dsh_role_action_grants
                (role_id, use_actions, delegate_actions, revision, updated_at)
               VALUES (?, ?, ?, 1, ?)`,
              [id, use, delegate, now],
            )
          } else {
            const [result] = await connection.execute<ResultSetHeader>(
              `UPDATE dsh_role_action_grants
               SET use_actions = ?, delegate_actions = ?, revision = revision + 1, updated_at = ?
               WHERE role_id = ?`,
              [use, delegate, now, id],
            )
            if (result.affectedRows !== 1) throw new Error('auth-rbac-mysql: locked role update affected no row')
          }
          const [currentRows] = await connection.execute<RoleRow[]>(
            `SELECT ${ROLE_COLUMNS} FROM dsh_role_action_grants WHERE role_id = ?`,
            [id],
          )
          const currentRow = currentRows[0]
          if (currentRow === undefined) throw new Error('auth-rbac-mysql: committed role row disappeared')
          const current = roleRecord(currentRow)
          await connection.commit()
          return current
        } catch (cause) {
          return rollback(connection, cause)
        }
      })
    } catch (cause) {
      rewrite(cause)
    }
  }

  /** Bind one user to one role on exactly one tenant-team pair.
   * @param binding - user, tenant, team, and role.
   * @returns committed binding including status and revision.
   */
  async assign(binding: PrincipalRoleBinding): Promise<PrincipalRoleRecord> {
    const current = {
      userId: userId(binding.userId),
      tenantId: tenantId(binding.tenantId),
      teamId: teamId(binding.teamId),
      roleId: roleId(binding.roleId),
    }
    try {
      return await this.ctx.mysql.connection(async (connection) => {
        await connection.beginTransaction()
        try {
          const [rows] = await connection.execute<BindingRow[]>(
            `SELECT ${BINDING_COLUMNS} FROM dsh_principal_roles
             WHERE user_id = ? AND tenant_id = ? AND team_id = ? AND role_id = ? FOR UPDATE`,
            [current.userId, current.tenantId, current.teamId, current.roleId],
          )
          const now = Date.now()
          const existing = rows[0]
          if (existing === undefined) {
            await connection.execute(
              `INSERT INTO dsh_principal_roles
                (user_id, tenant_id, team_id, role_id, status, created_at, updated_at, revision)
               VALUES (?, ?, ?, ?, 'active', ?, ?, 1)`,
              [current.userId, current.tenantId, current.teamId, current.roleId, now, now],
            )
          } else if (existing.status === 'revoked') {
            const [result] = await connection.execute<ResultSetHeader>(
              `UPDATE dsh_principal_roles
               SET status = 'active', created_at = ?, updated_at = ?, revision = 1
               WHERE user_id = ? AND tenant_id = ? AND team_id = ? AND role_id = ? AND status = 'revoked'`,
              [now, now, current.userId, current.tenantId, current.teamId, current.roleId],
            )
            if (result.affectedRows !== 1) throw new Error('auth-rbac-mysql: locked binding re-assign affected no row')
          } else {
            const [result] = await connection.execute<ResultSetHeader>(
              `UPDATE dsh_principal_roles SET updated_at = ?, revision = revision + 1
               WHERE user_id = ? AND tenant_id = ? AND team_id = ? AND role_id = ? AND status = 'active'`,
              [now, current.userId, current.tenantId, current.teamId, current.roleId],
            )
            if (result.affectedRows !== 1) throw new Error('auth-rbac-mysql: locked binding update affected no row')
          }
          const [currentRows] = await connection.execute<BindingRow[]>(
            `SELECT ${BINDING_COLUMNS} FROM dsh_principal_roles
             WHERE user_id = ? AND tenant_id = ? AND team_id = ? AND role_id = ?`,
            [current.userId, current.tenantId, current.teamId, current.roleId],
          )
          const currentRow = currentRows[0]
          if (currentRow === undefined) throw new Error('auth-rbac-mysql: committed binding row disappeared')
          const record = bindingRecord(currentRow)
          await connection.commit()
          return record
        } catch (cause) {
          return rollback(connection, cause)
        }
      })
    } catch (cause) {
      rewrite(cause)
    }
  }

  /** Revoke one principal-role binding when present.
   * @param binding - user, tenant, team, and role.
   * @returns committed revoked record, or `undefined` when no row exists.
   */
  async revoke(binding: PrincipalRoleBinding): Promise<PrincipalRoleRecord | undefined> {
    const current = {
      userId: userId(binding.userId),
      tenantId: tenantId(binding.tenantId),
      teamId: teamId(binding.teamId),
      roleId: roleId(binding.roleId),
    }
    try {
      return await this.ctx.mysql.connection(async (connection) => {
        await connection.beginTransaction()
        try {
          const [rows] = await connection.execute<BindingRow[]>(
            `SELECT ${BINDING_COLUMNS} FROM dsh_principal_roles
             WHERE user_id = ? AND tenant_id = ? AND team_id = ? AND role_id = ? FOR UPDATE`,
            [current.userId, current.tenantId, current.teamId, current.roleId],
          )
          const existing = rows[0]
          if (existing === undefined) {
            await connection.commit()
            return undefined
          }
          const previous = bindingRecord(existing)
          if (previous.status === 'revoked') {
            await connection.commit()
            return previous
          }
          const now = Math.max(Date.now(), previous.updatedAt)
          const [result] = await connection.execute<ResultSetHeader>(
            `UPDATE dsh_principal_roles SET status = 'revoked', updated_at = ?, revision = revision + 1
             WHERE user_id = ? AND tenant_id = ? AND team_id = ? AND role_id = ? AND status = 'active'`,
            [now, current.userId, current.tenantId, current.teamId, current.roleId],
          )
          if (result.affectedRows !== 1) throw new Error('auth-rbac-mysql: locked binding revoke affected no row')
          const [currentRows] = await connection.execute<BindingRow[]>(
            `SELECT ${BINDING_COLUMNS} FROM dsh_principal_roles
             WHERE user_id = ? AND tenant_id = ? AND team_id = ? AND role_id = ?`,
            [current.userId, current.tenantId, current.teamId, current.roleId],
          )
          const currentRow = currentRows[0]
          if (currentRow === undefined) throw new Error('auth-rbac-mysql: committed binding row disappeared')
          const record = bindingRecord(currentRow)
          await connection.commit()
          return record
        } catch (cause) {
          return rollback(connection, cause)
        }
      })
    } catch (cause) {
      rewrite(cause)
    }
  }

  /** List role ids bound to the user on this tenant and team only.
   * @param query - user, tenant, and team that must all match the binding.
   * @returns active role ids for that one team.
   */
  async listPrincipalRoles(query: PrincipalRoleQuery): Promise<readonly RoleId[]> {
    const lookup = {
      userId: userId(query.userId),
      tenantId: tenantId(query.tenantId),
      teamId: teamId(query.teamId),
    }
    try {
      return await this.ctx.mysql.connection(async (connection) => {
        const [rows] = await connection.execute<RoleIdRow[]>(
          `SELECT role_id FROM dsh_principal_roles
           WHERE user_id = ? AND tenant_id = ? AND team_id = ? AND status = 'active'
           ORDER BY role_id ASC`,
          [lookup.userId, lookup.tenantId, lookup.teamId],
        )
        return Object.freeze(rows.map(row => roleId(row.role_id)))
      })
    } catch (cause) {
      rewrite(cause)
    }
  }

  /** Return the Use and Delegate sets for one role.
   * @param id - catalogued role.
   * @returns action sets for that role.
   */
  async listRoleActions(id: RoleId): Promise<RoleActionSets> {
    const catalogued = roleId(id)
    try {
      return await this.ctx.mysql.connection(async (connection) => {
        const [rows] = await connection.execute<RoleRow[]>(
          `SELECT ${ROLE_COLUMNS} FROM dsh_role_action_grants WHERE role_id = ?`,
          [catalogued],
        )
        const row = rows[0]
        if (row === undefined) throw unavailable('role is not defined')
        const record = roleRecord(row)
        return Object.freeze({ use: record.use, delegate: record.delegate })
      })
    } catch (cause) {
      rewrite(cause)
    }
  }
}

export default AuthRbacMysql
