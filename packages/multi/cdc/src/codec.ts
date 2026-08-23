import { createHash } from 'node:crypto'
import type { CdcValue } from '@deepseek-ai/dsh-cdc-protocol'

export {
  decodeCdcEvent,
  encodeCdcEvent,
  encodeKey,
  findChangedColumns,
  getChangedColumns,
} from '@deepseek-ai/dsh-cdc-protocol'

function normalizeValue(value: unknown): CdcValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('cdc: non-finite number cannot be serialized')
    return value
  }
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return { $date: value.toISOString() }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $binary: Buffer.from(value).toString('base64') }
  }
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (typeof value === 'object') {
    const output: Record<string, CdcValue> = {}
    for (const [key, nested] of Object.entries(value)) output[key] = normalizeValue(nested)
    return output
  }
  throw new Error(`cdc: unsupported value type ${typeof value}`)
}

/**
 * Convert a decoded MySQL row to stable JSON values and omit configured fields.
 * @param row - Driver-decoded MySQL row.
 * @param excluded - Column names that must not leave the producer.
 * @returns A JSON-safe row retaining exact string values.
 */
export function normalizeRow(
  row: Record<string, unknown>,
  excluded: ReadonlySet<string>,
): Record<string, CdcValue> {
  const output: Record<string, CdcValue> = {}
  for (const [key, value] of Object.entries(row)) {
    if (!excluded.has(key)) output[key] = normalizeValue(value)
  }
  return output
}

/**
 * Compute the stable SHA-256 identifier used for schemas, keys, and event ids.
 * @param value - Canonical input string.
 * @returns Lowercase hexadecimal SHA-256 digest.
 */
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Encode one CDC event as UTF-8 JSON.
 * @param event - Valid version-one CDC event.
 * @returns Serialized UTF-8 bytes.
 */
