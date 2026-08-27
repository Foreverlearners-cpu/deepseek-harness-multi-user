import type { ActionCode, ResourceId, ResourceType } from '@deepseek-ai/dsh-authority/types'
import { teamId } from '@deepseek-ai/dsh-team'
import { tenantId } from '@deepseek-ai/dsh-tenant'
import { userId } from '@deepseek-ai/dsh-user'
import type { AclSubject, AclSubjectRef, RoleId } from './types.ts'

const ACTION_PATTERN = /^[A-Za-z][A-Za-z0-9-]*:[A-Za-z][A-Za-z0-9-]*$/
const TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/
const ROLE_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/

/** Brand a catalogued action after the authority action grammar.
 * @param value - untrusted action candidate.
 * @returns validated action.
 */
export function actionCode(value: string): ActionCode {
  if (!ACTION_PATTERN.test(value)) {
    throw new TypeError(`authority-acl: action must match ${String(ACTION_PATTERN)}`)
  }
  return value as ActionCode
}

/** Brand a resource class after the authority type grammar.
 * @param value - untrusted resource type candidate.
 * @returns validated resource type.
 */
export function resourceType(value: string): ResourceType {
  if (!TYPE_PATTERN.test(value)) {
    throw new TypeError(`authority-acl: resource type must match ${String(TYPE_PATTERN)}`)
  }
  return value as ResourceType
}

/** Brand a resolved resource id after the authority id grammar.
 * @param value - untrusted resource id candidate.
 * @returns validated resource id.
 */
export function resourceId(value: string): ResourceId {
  if (!RESOURCE_ID_PATTERN.test(value)) {
    throw new TypeError(`authority-acl: resource id must match ${String(RESOURCE_ID_PATTERN)}`)
  }
  return value as ResourceId
}

/** Brand a role id after validation.
 * @param value - untrusted role id candidate.
 * @returns validated role id.
 */
export function roleId(value: string): RoleId {
  if (!ROLE_PATTERN.test(value)) {
    throw new TypeError(`authority-acl: role id must match ${String(ROLE_PATTERN)}`)
  }
  return value as RoleId
}

/** Encode one grant subject as a stable ref such as `g:team-rd`.
 * @param subject - structured subject stored on the grant row.
 * @returns encoded subject ref.
 */
export function aclSubjectRef(subject: AclSubject): AclSubjectRef {
  switch (subject.kind) {
    case 'everyone':
      return 'everyone' as AclSubjectRef
    case 'user':
      return `u:${userId(subject.id)}` as AclSubjectRef
    case 'role':
      return `r:${roleId(subject.id)}` as AclSubjectRef
    case 'team':
      return `g:${teamId(subject.id)}` as AclSubjectRef
    case 'tenant':
      return `t:${tenantId(subject.id)}` as AclSubjectRef
    default: {
      const exhaustive: never = subject
      throw new TypeError(`authority-acl: unsupported subject ${String(exhaustive)}`)
    }
  }
}

/** Parse one encoded grant subject such as `g:team-rd`.
 * @param value - untrusted subject ref.
 * @returns structured subject.
 */
export function aclSubjectFromRef(value: string): AclSubject {
  if (value === 'everyone') return Object.freeze({ kind: 'everyone' })
  if (value.startsWith('u:')) return Object.freeze({ kind: 'user', id: userId(value.slice(2)) })
  if (value.startsWith('r:')) return Object.freeze({ kind: 'role', id: roleId(value.slice(2)) })
  if (value.startsWith('g:')) return Object.freeze({ kind: 'team', id: teamId(value.slice(2)) })
  if (value.startsWith('t:')) return Object.freeze({ kind: 'tenant', id: tenantId(value.slice(2)) })
  throw new TypeError('authority-acl: subject ref must be everyone or a u:, r:, g:, or t: prefix')
}
