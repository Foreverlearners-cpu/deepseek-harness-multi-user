import type { ActionCode, ResourceId, ResourceType } from '@deepseek-ai/dsh-authority/types'

const ACTION_PATTERN = /^[A-Za-z][A-Za-z0-9-]*:[A-Za-z][A-Za-z0-9-]*$/
const TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,63}$/
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/

/** Brand a catalogued action after the authority action grammar.
 * @param value - untrusted action candidate.
 * @returns validated action.
 */
export function actionCode(value: string): ActionCode {
  if (!ACTION_PATTERN.test(value)) {
    throw new TypeError(`tenant-authority: action must match ${String(ACTION_PATTERN)}`)
  }
  return value as ActionCode
}

/** Brand a resource class after the authority type grammar.
 * @param value - untrusted resource type candidate.
 * @returns validated resource type.
 */
export function resourceType(value: string): ResourceType {
  if (!TYPE_PATTERN.test(value)) {
    throw new TypeError(`tenant-authority: resource type must match ${String(TYPE_PATTERN)}`)
  }
  return value as ResourceType
}

/** Brand a resolved resource id after the authority id grammar.
 * @param value - untrusted resource id candidate.
 * @returns validated resource id.
 */
export function resourceId(value: string): ResourceId {
  if (!RESOURCE_ID_PATTERN.test(value)) {
    throw new TypeError(`tenant-authority: resource id must match ${String(RESOURCE_ID_PATTERN)}`)
  }
  return value as ResourceId
}
