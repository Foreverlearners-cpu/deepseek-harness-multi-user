import { describe, expect, it } from 'vitest'
import { teamId, teamMembershipId } from '@deepseek-ai/dsh-team'
import { newMembershipId, newTeamId } from '../src/ids.ts'

describe('team-mysql id generators', () => {
  it('returns branded UUID team and membership ids', () => {
    const team = newTeamId()
    const membership = newMembershipId()
    expect(team).toBe(teamId(team))
    expect(membership).toBe(teamMembershipId(membership))
    expect(team).not.toBe(membership)
  })
})
