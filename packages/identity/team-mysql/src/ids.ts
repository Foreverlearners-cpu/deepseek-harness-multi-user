import { teamId, teamMembershipId, type TeamId, type TeamMembershipId } from '@deepseek-ai/dsh-team'
import { randomUUID } from 'node:crypto'

/** Generate one Provider-owned team id.
 * @returns branded team id from a UUID.
 */
export function newTeamId(): TeamId {
  return teamId(randomUUID())
}

/** Generate one Provider-owned membership id.
 * @returns branded membership id from a UUID.
 */
export function newMembershipId(): TeamMembershipId {
  return teamMembershipId(randomUUID())
}
