import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { CdcEvent, CdcValue } from './types.ts'

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
 * Return source columns whose normalized values differ between row images.
 * @param before - Full normalized image before the operation.
 * @param after - Full normalized image after the operation.
 * @returns Unique columns in source image order.
 */
export function findChangedColumns(
  before: Record<string, CdcValue> | null,
  after: Record<string, CdcValue> | null,
): string[] {
  const columns = [...new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ])]
  return columns.filter(column => !isDeepStrictEqual(before?.[column], after?.[column]))
}

/**
 * Read explicit changed columns or derive them for older version-one events.
 * @param event - Valid CDC event.
 * @returns Columns changed by the row operation.
 */
export function getChangedColumns(event: CdcEvent): readonly string[] {
  return event.changedColumns ?? findChangedColumns(event.before, event.after)
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
export function encodeCdcEvent(event: CdcEvent): Buffer {
  return Buffer.from(JSON.stringify(event))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCdcObject(value: unknown): value is Record<string, CdcValue> {
  if (!isRecord(value)) return false
  return Object.values(value).every(isCdcValue)
}

function isCdcKey(value: unknown): value is Record<string, CdcValue> {
  return isCdcObject(value)
    && Object.keys(value).length > 0
    && Object.values(value).every(item => item !== null)
}

function isCdcValue(value: unknown): value is CdcValue {
  return value === null || typeof value === 'boolean' || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value))
    || (Array.isArray(value) && value.every(isCdcValue))
    || isCdcObject(value)
}

/**
 * Parse and validate an untrusted Kafka CDC payload.
 * @param value - Kafka record value bytes.
 * @returns A validated version-one CDC event.
 */
export function decodeCdcEvent(value: Uint8Array): CdcEvent {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value).toString('utf8')) as unknown
  } catch (cause) {
    throw new Error('cdc: Kafka payload is not valid JSON', { cause })
  }
  if (
    !isRecord(parsed)
    || parsed.specVersion !== 1
    || typeof parsed.eventId !== 'string'
    || !['insert', 'update', 'delete'].includes(String(parsed.operation))
    || typeof parsed.occurredAt !== 'string'
    || !isRecord(parsed.source)
    || typeof parsed.source.database !== 'string'
    || typeof parsed.source.table !== 'string'
    || typeof parsed.source.file !== 'string'
    || parsed.source.database.length === 0
    || parsed.source.table.length === 0
    || parsed.source.file.length === 0
    || typeof parsed.source.position !== 'number'
    || !Number.isSafeInteger(parsed.source.position)
    || parsed.source.position <= 0
    || (parsed.source.gtid !== undefined && typeof parsed.source.gtid !== 'string')
    || !isCdcKey(parsed.key)
    || (parsed.before !== null && !isCdcObject(parsed.before))
    || (parsed.after !== null && !isCdcObject(parsed.after))
    || (parsed.changedColumns !== undefined && (
      !Array.isArray(parsed.changedColumns)
      || parsed.changedColumns.some(column => typeof column !== 'string' || column.length === 0)
      || new Set(parsed.changedColumns).size !== parsed.changedColumns.length
    ))
    || typeof parsed.schemaFingerprint !== 'string' || parsed.schemaFingerprint.length === 0
    || parsed.eventId.length === 0
    || !Number.isFinite(Date.parse(parsed.occurredAt))
    || (parsed.operation === 'insert' && (parsed.before !== null || parsed.after === null))
    || (parsed.operation === 'update' && (parsed.before === null || parsed.after === null))
    || (parsed.operation === 'delete' && (parsed.before === null || parsed.after !== null))
  ) throw new Error('cdc: Kafka payload does not match CDC spec version 1')
  const event = parsed as unknown as CdcEvent
  if (
    event.changedColumns !== undefined
    && !findChangedColumns(event.before, event.after)
      .every(column => event.changedColumns?.includes(column) === true)
  ) {
    throw new Error('cdc: changedColumns does not cover the visible row-image differences')
  }
  return event
}

/**
 * Produce deterministic bytes for a compound row key.
 * @param key - Ordered compound primary-key fields.
 * @returns Canonical UTF-8 JSON bytes.
 */
export function encodeKey(key: Record<string, CdcValue>): Buffer {
  return Buffer.from(JSON.stringify(key))
}
