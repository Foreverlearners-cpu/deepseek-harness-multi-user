/** Shared auth-token Provider conformance suite. */

import type { Context } from '@deepseek-ai/cordis'
import { authenticationRequestId, credentialId, tokenFamilyId, userId } from '@deepseek-ai/dsh-auth'
import { describe, expect, it } from 'vitest'
import type AuthTokenService from '../src/index.ts'
import type { AuthTokenChangeEvent } from '../src/index.ts'

/** Fresh Provider service used for one conformance case. */
export interface AuthTokenContractHarness {
  readonly ctx: Context
  readonly authTokens: AuthTokenService
  setTime(value: number): void
}

const signal = new AbortController().signal
const requestId = authenticationRequestId('request-1')
const principal = { kind: 'user' as const, id: userId('user-1') }

/**
 * Run token-family rotation, reuse, expiry, and revocation obligations.
 * @param label - Provider label used in the test suite name.
 * @param create - factory returning an empty live Provider per test.
 */
export function runAuthTokenContract(
  label: string,
  create: () => Promise<AuthTokenContractHarness>,
): void {
  describe(`auth-token contract: ${label}`, () => {
    it('issues one family while exposing no secret or digest through inspection and events', async () => {
      const { ctx, authTokens } = await create()
      const events: AuthTokenChangeEvent[] = []
      ctx.on('auth-token/changed', (event) => { events.push(event) })
      const issued = await authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })

      expect(issued).toMatchObject({
        family: { principal, status: 'active', revision: 1, expiresAt: 2_000 },
        refreshToken: { tokenFamilyId: issued.family.tokenFamilyId, expiresAt: 2_000 },
      })
      expect(issued.refreshToken.value).toMatch(/^dsh_rt_/)
      expect(Object.isFrozen(issued)).toBe(true)
      const inspected = await authTokens.inspect({
        requestId,
        signal,
        target: { kind: 'token-family', tokenFamilyId: issued.family.tokenFamilyId },
      })
      expect(inspected.families).toEqual([issued.family])
      expect(inspected.credentials).toEqual([expect.objectContaining({
        credentialId: issued.refreshToken.credentialId,
        status: 'active',
      })])
      expect(JSON.stringify(inspected)).not.toContain(issued.refreshToken.value)
      expect(JSON.stringify(inspected)).not.toContain('digest')
      expect(events).toEqual([expect.objectContaining({ kind: 'issued', revision: 1, principal })])
      expect(JSON.stringify(events)).not.toContain(issued.refreshToken.value)
    })

    it('rotates exactly once and atomically revokes the family on reuse', async () => {
      const harness = await create()
      const { ctx, authTokens } = harness
      const events: AuthTokenChangeEvent[] = []
      ctx.on('auth-token/changed', (event) => { events.push(event) })
      const first = await authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
      harness.setTime(1_100)
      const second = await authTokens.rotate({
        requestId,
        signal,
        refreshToken: first.refreshToken.value,
        expiresAt: 1_900,
      })
      expect(second).toMatchObject({ family: { revision: 2, status: 'active' } })
      expect(second.refreshToken.value).not.toBe(first.refreshToken.value)

      harness.setTime(1_200)
      await expect(authTokens.rotate({
        requestId,
        signal,
        refreshToken: first.refreshToken.value,
        expiresAt: 1_800,
      })).rejects.toMatchObject({ code: 'refresh-token-reused' })
      const inspected = await authTokens.inspect({
        requestId,
        signal,
        target: { kind: 'token-family', tokenFamilyId: first.family.tokenFamilyId },
      })
      expect(inspected.families[0]).toMatchObject({
        status: 'revoked',
        revision: 3,
        revocationReason: 'refresh-token-reuse',
      })
      expect(inspected.credentials.map(value => value.status)).toEqual(['rotated', 'revoked'])
      await expect(authTokens.rotate({
        requestId,
        signal,
        refreshToken: second.refreshToken.value,
        expiresAt: 1_700,
      })).rejects.toMatchObject({ code: 'token-family-revoked' })
      expect(events.map(value => value.kind)).toEqual(['issued', 'rotated', 'reuse-detected'])
    })

    it('allows only one of two concurrent rotations to succeed', async () => {
      const harness = await create()
      const { authTokens } = harness
      const issued = await authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
      harness.setTime(1_100)
      const results = await Promise.allSettled([
        authTokens.rotate({ requestId, signal, refreshToken: issued.refreshToken.value, expiresAt: 1_900 }),
        authTokens.rotate({ requestId, signal, refreshToken: issued.refreshToken.value, expiresAt: 1_900 }),
      ])
      expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1)
      const rejections = results.filter(value => value.status === 'rejected')
      expect(rejections).toHaveLength(1)
      const reason: unknown = rejections[0]?.reason
      expect(reason).toMatchObject({ code: 'refresh-token-reused' })
      const inspection = await authTokens.inspect({
        requestId,
        signal,
        target: { kind: 'token-family', tokenFamilyId: issued.family.tokenFamilyId },
      })
      expect(inspection.families[0]).toMatchObject({ status: 'revoked', revision: 3 })
    })

    it('rejects unknown and expired refresh credentials without changing their family', async () => {
      const harness = await create()
      const { authTokens } = harness
      await expect(authTokens.rotate({
        requestId,
        signal,
        refreshToken: 'dsh_rt_unknown',
        expiresAt: 1_900,
      })).rejects.toMatchObject({ code: 'refresh-token-invalid' })
      const issued = await authTokens.issueFamily({ requestId, signal, principal, expiresAt: 1_010 })
      harness.setTime(1_010)
      await expect(authTokens.rotate({
        requestId,
        signal,
        refreshToken: issued.refreshToken.value,
        expiresAt: 1_020,
      })).rejects.toMatchObject({ code: 'refresh-token-expired' })
      const inspected = await authTokens.inspect({
        requestId,
        signal,
        target: { kind: 'token-family', tokenFamilyId: issued.family.tokenFamilyId },
      })
      expect(inspected.families[0]).toMatchObject({ status: 'active', revision: 1 })
    })

    it('revokes by credential, family, and principal idempotently', async () => {
      const harness = await create()
      const { authTokens } = harness
      const first = await authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
      const second = await authTokens.issueFamily({ requestId, signal, principal, expiresAt: 2_000 })
      harness.setTime(1_100)
      await authTokens.revoke({
        requestId,
        signal,
        target: { kind: 'credential', credentialId: first.refreshToken.credentialId },
      })
      await authTokens.revoke({
        requestId,
        signal,
        target: { kind: 'token-family', tokenFamilyId: first.family.tokenFamilyId },
      })
      harness.setTime(1_200)
      await authTokens.revoke({ requestId, signal, target: { kind: 'principal', principal } })
      const inspected = await authTokens.inspect({ requestId, signal, target: { kind: 'principal', principal } })
      expect(inspected.families).toEqual([
        expect.objectContaining({ tokenFamilyId: first.family.tokenFamilyId, revision: 2, status: 'revoked' }),
        expect.objectContaining({ tokenFamilyId: second.family.tokenFamilyId, revision: 2, status: 'revoked' }),
      ])
      expect(inspected.credentials.every(value => value.status === 'revoked')).toBe(true)
      expect((await authTokens.inspect({
        requestId,
        signal,
        target: { kind: 'credential', credentialId: credentialId('missing') },
      })).families).toEqual([])
      expect((await authTokens.inspect({
        requestId,
        signal,
        target: { kind: 'token-family', tokenFamilyId: tokenFamilyId('missing') },
      })).families).toEqual([])
    })
  })
}
