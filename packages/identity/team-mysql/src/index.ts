/** MySQL persistence Provider for the team and membership directory.
 * @module @deepseek-ai/dsh-team-mysql
 */

import { Service } from '@deepseek-ai/cordis'
import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import TeamDirectory, {
  TeamDirectoryError,
  teamId,
  teamMembershipId,
  type TeamCreateRecordInput,
  type TeamId,
  type TeamMembershipCreateRecordInput,
  type TeamMembershipListQuery,
  type TeamMembershipMutation,
  type TeamMembershipMutationCommit,
  type TeamMembershipPage,
  type TeamMembershipRecord,
  type TeamMembershipStatus,
  type TeamMutation,
  type TeamMutationCommit,
  type TeamRecord,
  type TeamStatus,
} from '@deepseek-ai/dsh-team'
import { tenantId, type TenantId } from '@deepseek-ai/dsh-tenant'
import { userId, type UserId } from '@deepseek-ai/dsh-user'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { decodeCursor, encodeCursor } from './cursor.ts'
import { newMembershipId, newTeamId } from './ids.ts'
import { initializeSchema } from './schema.ts'

export { TEAM_MYSQL_SCHEMA_VERSION } from './schema.ts'

interface TeamRow extends RowDataPacket {
  team_id: string
  tenant_id: string
  display_name: string | null
  status: TeamStatus
  created_at: number | string
  updated_at: number | string
  revision: number | string
}

interface MembershipRow extends RowDataPacket {
  team_id: string
  user_id: string
  tenant_id: string
  membership_id: string
  status: TeamMembershipStatus
  created_at: number | string
  updated_at: number | string
  revision: number | string
}

const TEAM_COLUMNS = 'team_id, tenant_id, display_name, status, created_at, updated_at, revision'
const MEMBERSHIP_COLUMNS = 'team_id, user_id, tenant_id, membership_id, status, created_at, updated_at, revision'

function safeInteger(value: number | string, field: string): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error(`team-mysql: invalid ${field}`)
  return numeric
}

function teamRecord(row: TeamRow): TeamRecord {
  return {
    teamId: teamId(row.team_id),
    tenantId: tenantId(row.tenant_id),
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    status: row.status,
    createdAt: safeInteger(row.created_at, 'created_at'),
    updatedAt: safeInteger(row.updated_at, 'updated_at'),
    revision: safeInteger(row.revision, 'revision'),
  }
}

function membershipRecord(row: MembershipRow): TeamMembershipRecord {
  return {
    membershipId: teamMembershipId(row.membership_id),
    teamId: teamId(row.team_id),
    tenantId: tenantId(row.tenant_id),
    userId: userId(row.user_id),
    status: row.status,
    createdAt: safeInteger(row.created_at, 'created_at'),
    updatedAt: safeInteger(row.updated_at, 'updated_at'),
    revision: safeInteger(row.revision, 'revision'),
  }
}

function teamConflict(previous: TeamRecord, mutation: TeamMutation): void {
  if (previous.revision !== mutation.expectedRevision) {
    throw new TeamDirectoryError('revision-conflict', 'team-mysql: team revision changed')
  }
  if (previous.status === 'deleted') {
    throw new TeamDirectoryError('team-deleted', 'team-mysql: team is deleted')
  }
  const allowed = mutation.status === 'disabled'
    ? previous.status === 'active'
    : mutation.status === 'active'
      ? previous.status === 'disabled'
      : true
  if (!allowed) throw new TeamDirectoryError('status-conflict', 'team-mysql: team status conflicts')
}

function membershipConflict(previous: TeamMembershipRecord, mutation: TeamMembershipMutation): void {
  if (previous.revision !== mutation.expectedRevision) {
    throw new TeamDirectoryError('revision-conflict', 'team-mysql: membership revision changed')
  }
  if (previous.status === 'removed') {
    throw new TeamDirectoryError('membership-removed', 'team-mysql: membership is removed')
  }
  const allowed = mutation.status === 'disabled'
    ? previous.status === 'active'
    : mutation.status === 'active'
      ? previous.status === 'disabled'
      : true
  if (!allowed) throw new TeamDirectoryError('status-conflict', 'team-mysql: membership status conflicts')
}

async function rollback(connection: MysqlConnection, cause: unknown): Promise<never> {
  try {
    await connection.rollback()
  } catch (rollbackCause) {
    throw new TeamDirectoryError('provider-unavailable', 'team-mysql: transaction rollback failed', {
      cause: new AggregateError([cause, rollbackCause]),
    })
  }
  throw cause
}

function isDuplicate(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'ER_DUP_ENTRY'
}

/** Durable `ctx.teams` Provider backed by the injected MySQL connection service. */
export class TeamMysqlDirectory extends TeamDirectory {
  static inject = ['mysql']

  /** Initialize and verify the Provider-owned schema before serving requests. */
  async [Service.init](): Promise<void> {
    await this.ctx.mysql.connection(initializeSchema)
  }

  protected async createTeamRecord(input: TeamCreateRecordInput): Promise<TeamRecord> {
    const id = newTeamId()
    const now = Date.now()
    await this.ctx.mysql.connection(async (connection) => {
      await connection.execute(
        `INSERT INTO dsh_teams
          (team_id, tenant_id, display_name, status, created_at, updated_at, revision)
         VALUES (?, ?, ?, 'active', ?, ?, 1)`,
        [id, input.tenantId, input.displayName ?? null, now, now],
      )
    })
    return {
      teamId: id,
      tenantId: input.tenantId,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      revision: 1,
    }
  }

  protected async readTeamRecord(id: TeamId): Promise<TeamRecord | undefined> {
    return this.ctx.mysql.connection(async (connection) => {
      const [rows] = await connection.execute<TeamRow[]>(
        `SELECT ${TEAM_COLUMNS} FROM dsh_teams WHERE team_id = ?`,
        [id],
      )
      const row = rows[0]
      return row === undefined ? undefined : teamRecord(row)
    })
  }

  protected async mutateTeamRecord(mutation: TeamMutation): Promise<TeamMutationCommit> {
    return this.ctx.mysql.connection(async (connection) => {
      await connection.beginTransaction()
      try {
        const [rows] = await connection.execute<TeamRow[]>(
          `SELECT ${TEAM_COLUMNS} FROM dsh_teams WHERE team_id = ? FOR UPDATE`,
          [mutation.teamId],
        )
        const row = rows[0]
        if (row === undefined) throw new TeamDirectoryError('team-not-found', 'team-mysql: team was not found')
        const previous = teamRecord(row)
        teamConflict(previous, mutation)
        const now = Math.max(Date.now(), previous.updatedAt)
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE dsh_teams SET status = ?, updated_at = ?, revision = revision + 1
           WHERE team_id = ? AND revision = ?`,
          [mutation.status, now, mutation.teamId, mutation.expectedRevision],
        )
        if (result.affectedRows !== 1) throw new Error('team-mysql: locked team update affected no row')
        const [currentRows] = await connection.execute<TeamRow[]>(
          `SELECT ${TEAM_COLUMNS} FROM dsh_teams WHERE team_id = ?`,
          [mutation.teamId],
        )
        const currentRow = currentRows[0]
        if (currentRow === undefined) throw new Error('team-mysql: committed team row disappeared')
        const current = teamRecord(currentRow)
        await connection.commit()
        return { previous, current }
      } catch (cause) {
        return rollback(connection, cause)
      }
    })
  }

  protected async createMembershipRecord(input: TeamMembershipCreateRecordInput): Promise<TeamMembershipRecord> {
    return this.ctx.mysql.connection(async (connection) => {
      await connection.beginTransaction()
      try {
        // Lock the team row first, then the (team_id, user_id) membership slot.
        const [teamRows] = await connection.execute<TeamRow[]>(
          `SELECT ${TEAM_COLUMNS} FROM dsh_teams WHERE team_id = ? FOR UPDATE`,
          [input.teamId],
        )
        const teamRow = teamRows[0]
        if (teamRow === undefined) {
          throw new TeamDirectoryError('team-not-found', 'team-mysql: team was not found')
        }
        const team = teamRecord(teamRow)
        if (team.status === 'disabled') {
          throw new TeamDirectoryError('team-disabled', 'team-mysql: team is disabled')
        }
        if (team.status === 'deleted') {
          throw new TeamDirectoryError('team-deleted', 'team-mysql: team is deleted')
        }
        if (team.tenantId !== input.tenantId) {
          throw new TeamDirectoryError('tenant-mismatch', 'team-mysql: claimed tenant does not own the team')
        }
        const [existingRows] = await connection.execute<MembershipRow[]>(
          `SELECT ${MEMBERSHIP_COLUMNS} FROM dsh_team_memberships
           WHERE team_id = ? AND user_id = ? FOR UPDATE`,
          [input.teamId, input.userId],
        )
        const existing = existingRows[0]
        if (existing !== undefined && existing.status !== 'removed') {
          throw new TeamDirectoryError('membership-conflict', 'team-mysql: membership already exists')
        }
        const id = newMembershipId()
        const now = Date.now()
        if (existing === undefined) {
          try {
            await connection.execute(
              `INSERT INTO dsh_team_memberships
                (team_id, user_id, tenant_id, membership_id, status, created_at, updated_at, revision)
               VALUES (?, ?, ?, ?, 'active', ?, ?, 1)`,
              [input.teamId, input.userId, team.tenantId, id, now, now],
            )
          } catch (cause) {
            if (isDuplicate(cause)) {
              throw new TeamDirectoryError('membership-conflict', 'team-mysql: membership already exists', { cause })
            }
            throw cause
          }
        } else {
          const [result] = await connection.execute<ResultSetHeader>(
            `UPDATE dsh_team_memberships
             SET membership_id = ?, tenant_id = ?, status = 'active', created_at = ?, updated_at = ?, revision = 1
             WHERE team_id = ? AND user_id = ? AND status = 'removed'`,
            [id, team.tenantId, now, now, input.teamId, input.userId],
          )
          if (result.affectedRows !== 1) throw new Error('team-mysql: locked membership re-add affected no row')
        }
        const [currentRows] = await connection.execute<MembershipRow[]>(
          `SELECT ${MEMBERSHIP_COLUMNS} FROM dsh_team_memberships WHERE team_id = ? AND user_id = ?`,
          [input.teamId, input.userId],
        )
        const currentRow = currentRows[0]
        if (currentRow === undefined) throw new Error('team-mysql: committed membership row disappeared')
        const current = membershipRecord(currentRow)
        await connection.commit()
        return current
      } catch (cause) {
        return rollback(connection, cause)
      }
    })
  }

  protected async readMembershipRecord(id: TeamId, member: UserId): Promise<TeamMembershipRecord | undefined> {
    return this.ctx.mysql.connection(async (connection) => {
      const [rows] = await connection.execute<MembershipRow[]>(
        `SELECT ${MEMBERSHIP_COLUMNS} FROM dsh_team_memberships WHERE team_id = ? AND user_id = ?`,
        [id, member],
      )
      const row = rows[0]
      return row === undefined ? undefined : membershipRecord(row)
    })
  }

  protected async mutateMembershipRecord(mutation: TeamMembershipMutation): Promise<TeamMembershipMutationCommit> {
    return this.ctx.mysql.connection(async (connection) => {
      await connection.beginTransaction()
      try {
        const [rows] = await connection.execute<MembershipRow[]>(
          `SELECT ${MEMBERSHIP_COLUMNS} FROM dsh_team_memberships
           WHERE team_id = ? AND user_id = ? FOR UPDATE`,
          [mutation.teamId, mutation.userId],
        )
        const row = rows[0]
        if (row === undefined) {
          throw new TeamDirectoryError('membership-not-found', 'team-mysql: membership was not found')
        }
        const previous = membershipRecord(row)
        membershipConflict(previous, mutation)
        const now = Math.max(Date.now(), previous.updatedAt)
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE dsh_team_memberships SET status = ?, updated_at = ?, revision = revision + 1
           WHERE team_id = ? AND user_id = ? AND revision = ?`,
          [mutation.status, now, mutation.teamId, mutation.userId, mutation.expectedRevision],
        )
        if (result.affectedRows !== 1) throw new Error('team-mysql: locked membership update affected no row')
        const [currentRows] = await connection.execute<MembershipRow[]>(
          `SELECT ${MEMBERSHIP_COLUMNS} FROM dsh_team_memberships WHERE team_id = ? AND user_id = ?`,
          [mutation.teamId, mutation.userId],
        )
        const currentRow = currentRows[0]
        if (currentRow === undefined) throw new Error('team-mysql: committed membership row disappeared')
        const current = membershipRecord(currentRow)
        await connection.commit()
        return { previous, current }
      } catch (cause) {
        return rollback(connection, cause)
      }
    })
  }

  protected async listMembershipRecords(query: TeamMembershipListQuery): Promise<TeamMembershipPage> {
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, query)
    const clauses: string[] = []
    const parameters: (number | string | TenantId | TeamId | UserId)[] = []
    if (query.scope === 'team') {
      clauses.push('team_id = ?')
      parameters.push(query.teamId)
    } else {
      clauses.push('user_id = ?')
      parameters.push(query.userId)
      clauses.push('tenant_id = ?')
      parameters.push(query.tenantId)
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
        `SELECT ${MEMBERSHIP_COLUMNS} FROM dsh_team_memberships
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

export default TeamMysqlDirectory
