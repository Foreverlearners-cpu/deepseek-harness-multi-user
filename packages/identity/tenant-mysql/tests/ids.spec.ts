import { describe, expect, it } from 'vitest'
import { membershipId, tenantId } from '@deepseek-ai/dsh-tenant'
import { newMembershipId, newTenantId } from '../src/ids.ts'

describe('tenant-mysql id generators', () => {
  it('returns branded UUID tenant and membership ids', () => {
    const tenant = newTenantId()
    const membership = newMembershipId()
    expect(tenant).toBe(tenantId(tenant))
    expect(membership).toBe(membershipId(membership))
    expect(tenant).not.toBe(membership)
  })
})
