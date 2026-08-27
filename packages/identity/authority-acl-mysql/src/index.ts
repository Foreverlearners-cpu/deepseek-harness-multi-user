/** MySQL persistence Provider for resource action grants with durable team subjects.
 * @module @deepseek-ai/dsh-authority-acl-mysql
 */

import { Service } from '@deepseek-ai/cordis'
import {
  AuthorityAclError,
  aclSubjectFromRef,
  aclSubjectRef,
  type AclGrant,
  type AclPolicySource,
  type AclResourceRef,
  type AclSubject,
} from '@deepseek-ai/dsh-authority-acl'
import { actionCode, resourceId, resourceType } from '@deepseek-ai/dsh-authority-acl/src/ids.ts'
import type { ActionCode } from '@deepseek-ai/dsh-authority/types'
import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { initializeSchema } from './schema.ts'

export { AUTHORITY_ACL_MYSQL_SCHEMA_VERSION } from './schema.ts'

/** Durable object-grant row including the resource revision that isolates the slot. */
export interface AclGrantRecord extends AclGrant {
  readonly resourceRevision: number
  readonly status: 'active' | 'revoked'
  readonly createdAt: number
  readonly updatedAt: number
  readonly revision: number
}

interface GrantRow extends RowDataPacket {
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

const GRANT_COLUMNS = 'resource_type, resource_id, resource_revision, subject_ref, use_actions, delegate_actions, status, created_at, updated_at, revision'

function unavailable(message: string, options?: ErrorOptions): AuthorityAclError {
  return new AuthorityAclError('provider-unavailable', `authority-acl-mysql: ${message}`, options)
}

function safeInteger(value: number | string, field: string): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error(`authority-acl-mysql: invalid ${field}`)
  return numeric
}

function resourceRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('authority-acl-mysql: resource revision must be a positive safe integer')
  }
  return value
}

function actionList(value: unknown, field: string): readonly ActionCode[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
  if (!Array.isArray(parsed)) throw new Error(`authority-acl-mysql: invalid ${field}`)
  return Object.freeze(parsed.map((entry) => {
    if (typeof entry !== 'string') throw new Error(`authority-acl-mysql: invalid ${field}`)
    return actionCode(entry)
  }))
}

function encodeActions(actions: readonly string[]): string {
  return JSON.stringify(actions.map(entry => actionCode(entry)))
}

function grantRecord(row: GrantRow): AclGrantRecord {
  try {
    return {
      resource: Object.freeze({
        type: resourceType(row.resource_type),
        id: resourceId(row.resource_id),
      }),
      resourceRevision: safeInteger(row.resource_revision, 'resource_revision'),
      subject: aclSubjectFromRef(row.subject_ref),
      use: actionList(row.use_actions, 'use_actions'),
      delegate: actionList(row.delegate_actions, 'delegate_actions'),
      status: row.status,
      createdAt: safeInteger(row.created_at, 'created_at'),
      updatedAt: safeInteger(row.updated_at, 'updated_at'),
      revision: safeInteger(row.revision, 'revision'),
    }
  } catch (cause) {
    throw unavailable('stored grant row is invalid', { cause })
  }
}

function asGrant(record: AclGrantRecord): AclGrant {
  return Object.freeze({
    resource: record.resource,
    subject: record.subject,
    use: record.use,
    delegate: record.delegate,
  })
}

function rewrite(cause: unknown): never {
  if (cause instanceof AuthorityAclError || cause instanceof TypeError) throw cause
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
    /** Durable MySQL object grants keyed by resource and resource revision. */
    authorityAclMysql: AuthorityAclMysql
  }
}

/** Durable `AclPolicySource` that registers on `ctx.authorityAcl` and owns grant SQL. */
export class AuthorityAclMysql extends Service implements AclPolicySource {
  static inject = ['mysql', 'authorityAcl']

  /** @param ctx - owning Host context. */
  constructor(ctx: ConstructorParameters<typeof Service>[0]) {
    super(ctx, 'authorityAclMysql')
  }

  /** Initialize the schema and register this instance as the sole policy source. */
  async [Service.init](): Promise<void> {
    await this.ctx.mysql.connection(initializeSchema)
    this.ctx.effect(() => this.ctx.authorityAcl.registerSource(this))
  }

  /** Define or replace one grant row. A team subject stays one encoded row.
   * @param grant - resource, subject, and the two action sets.
   * @param revision - resource revision that isolates this slot from other revisions.
   * @returns committed grant including resource revision and row revision.
   */
  async grant(grant: AclGrant, revision: number): Promise<AclGrantRecord> {
    const resource = {
      type: resourceType(grant.resource.type),
      id: resourceId(grant.resource.id),
    }
    const resourceRev = resourceRevision(revision)
    const subject = grant.subject
    const subjectRef = aclSubjectRef(subject)
    const use = encodeActions(grant.use)
    const delegate = encodeActions(grant.delegate)
    try {
      return await this.ctx.mysql.connection(async (connection) => {
        await connection.beginTransaction()
        try {
          const [rows] = await connection.execute<GrantRow[]>(
            `SELECT ${GRANT_COLUMNS} FROM dsh_resource_action_grants
             WHERE resource_type = ? AND resource_id = ? AND resource_revision = ? AND subject_ref = ?
             FOR UPDATE`,
            [resource.type, resource.id, resourceRev, subjectRef],
          )
          const now = Date.now()
          const existing = rows[0]
          if (existing === undefined) {
            await connection.execute(
              `INSERT INTO dsh_resource_action_grants
                (resource_type, resource_id, resource_revision, subject_ref,
                 use_actions, delegate_actions, status, created_at, updated_at, revision)
               VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, 1)`,
              [resource.type, resource.id, resourceRev, subjectRef, use, delegate, now, now],
            )
          } else if (existing.status === 'revoked') {
            const [result] = await connection.execute<ResultSetHeader>(
              `UPDATE dsh_resource_action_grants
               SET use_actions = ?, delegate_actions = ?, status = 'active',
                   created_at = ?, updated_at = ?, revision = 1
               WHERE resource_type = ? AND resource_id = ? AND resource_revision = ? AND subject_ref = ?
                 AND status = 'revoked'`,
              [use, delegate, now, now, resource.type, resource.id, resourceRev, subjectRef],
            )
            if (result.affectedRows !== 1) throw new Error('authority-acl-mysql: locked grant re-add affected no row')
          } else {
            const [result] = await connection.execute<ResultSetHeader>(
              `UPDATE dsh_resource_action_grants
               SET use_actions = ?, delegate_actions = ?, updated_at = ?, revision = revision + 1
               WHERE resource_type = ? AND resource_id = ? AND resource_revision = ? AND subject_ref = ?
                 AND status = 'active'`,
              [use, delegate, now, resource.type, resource.id, resourceRev, subjectRef],
            )
            if (result.affectedRows !== 1) throw new Error('authority-acl-mysql: locked grant update affected no row')
          }
          const current = await this.readLocked(connection, resource, resourceRev, subjectRef)
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

  /** Revoke one grant row when present.
   * @param resource - type and id that must both match.
   * @param subject - subject stored on the row.
   * @param revision - resource revision that isolates this slot.
   * @returns committed revoked record, or `undefined` when no row exists.
   */
  async revoke(
    resource: AclResourceRef,
    subject: AclSubject,
    revision: number,
  ): Promise<AclGrantRecord | undefined> {
    const current = {
      type: resourceType(resource.type),
      id: resourceId(resource.id),
    }
    const resourceRev = resourceRevision(revision)
    const subjectRef = aclSubjectRef(subject)
    try {
      return await this.ctx.mysql.connection(async (connection) => {
        await connection.beginTransaction()
        try {
          const [rows] = await connection.execute<GrantRow[]>(
            `SELECT ${GRANT_COLUMNS} FROM dsh_resource_action_grants
             WHERE resource_type = ? AND resource_id = ? AND resource_revision = ? AND subject_ref = ?
             FOR UPDATE`,
            [current.type, current.id, resourceRev, subjectRef],
          )
          const existing = rows[0]
          if (existing === undefined) {
            await connection.commit()
            return undefined
          }
          const previous = grantRecord(existing)
          if (previous.status === 'revoked') {
            await connection.commit()
            return previous
          }
          const now = Math.max(Date.now(), previous.updatedAt)
          const [result] = await connection.execute<ResultSetHeader>(
            `UPDATE dsh_resource_action_grants
             SET status = 'revoked', updated_at = ?, revision = revision + 1
             WHERE resource_type = ? AND resource_id = ? AND resource_revision = ? AND subject_ref = ?
               AND status = 'active'`,
            [now, current.type, current.id, resourceRev, subjectRef],
          )
          if (result.affectedRows !== 1) throw new Error('authority-acl-mysql: locked grant revoke affected no row')
          const record = await this.readLocked(connection, current, resourceRev, subjectRef)
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

  /** List grants stored for this resource identity.
   * @param resource - type and id that must both match the grant row.
   * @returns active grants for that resource; never expanded team-member copies.
   */
  async listGrants(resource: AclResourceRef): Promise<readonly AclGrant[]> {
    const type = resourceType(resource.type)
    const id = resourceId(resource.id)
    try {
      return await this.ctx.mysql.connection(async (connection) => {
        const [rows] = await connection.execute<GrantRow[]>(
          `SELECT ${GRANT_COLUMNS} FROM dsh_resource_action_grants
           WHERE resource_type = ? AND resource_id = ? AND status = 'active'
           ORDER BY resource_revision ASC, subject_ref ASC`,
          [type, id],
        )
        return Object.freeze(rows.map(row => asGrant(grantRecord(row))))
      })
    } catch (cause) {
      rewrite(cause)
    }
  }

  /** List grants stored for one resource revision only.
   * @param resource - type and id that must both match the grant row.
   * @param revision - resource revision that isolates this slot from other revisions.
   * @returns active grants for that resource revision.
   */
  async listGrantsAt(resource: AclResourceRef, revision: number): Promise<readonly AclGrantRecord[]> {
    const type = resourceType(resource.type)
    const id = resourceId(resource.id)
    const resourceRev = resourceRevision(revision)
    try {
      return await this.ctx.mysql.connection(async (connection) => {
        const [rows] = await connection.execute<GrantRow[]>(
          `SELECT ${GRANT_COLUMNS} FROM dsh_resource_action_grants
           WHERE resource_type = ? AND resource_id = ? AND resource_revision = ? AND status = 'active'
           ORDER BY subject_ref ASC`,
          [type, id, resourceRev],
        )
        return Object.freeze(rows.map(grantRecord))
      })
    } catch (cause) {
      rewrite(cause)
    }
  }

  private async readLocked(
    connection: MysqlConnection,
    resource: AclResourceRef,
    revision: number,
    subjectRef: string,
  ): Promise<AclGrantRecord> {
    const [rows] = await connection.execute<GrantRow[]>(
      `SELECT ${GRANT_COLUMNS} FROM dsh_resource_action_grants
       WHERE resource_type = ? AND resource_id = ? AND resource_revision = ? AND subject_ref = ?`,
      [resource.type, resource.id, revision, subjectRef],
    )
    const row = rows[0]
    if (row === undefined) throw new Error('authority-acl-mysql: committed grant row disappeared')
    return grantRecord(row)
  }
}

export default AuthorityAclMysql
