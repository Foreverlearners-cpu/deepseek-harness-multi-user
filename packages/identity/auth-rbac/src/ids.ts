import type { ActionCode } from '@deepseek-ai/dsh-authority/types'
import type { RoleId } from './types.ts'

const ACTION_PATTERN = /^[A-Za-z][A-Za-z0-9-]*:[A-Za-z][A-Za-z0-9-]*$/
const ROLE_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/

/** Brand a catalogued action after the authority action grammar.
 * @param value - untrusted action candidate.
 * @returns validated action.
 */
export function actionCode(value: string): ActionCode {
  if (!ACTION_PATTERN.test(value)) {
    throw new TypeError(`auth-rbac: action must match ${String(ACTION_PATTERN)}`)
  }
  return value as ActionCode
}

/** Brand a role id after validation.
 * @param value - untrusted role id candidate.
 * @returns validated role id.
 */
export function roleId(value: string): RoleId {
  if (!ROLE_PATTERN.test(value)) {
    throw new TypeError(`auth-rbac: role id must match ${String(ROLE_PATTERN)}`)
  }
  return value as RoleId
}
