/**
 * Transport-independent CDC event types and strict version-one wire codec.
 * @module @deepseek-ai/dsh-cdc-protocol
 */

import type {
  CdcEvent,
  CdcValue,
  CdcWireErrorCode,
  CdcWireOptions,
} from './types.ts'

export type {
  CdcCheckpoint,
  CdcEvent,
  CdcOperation,
  CdcSource,
  CdcValue,
  CdcWireErrorCode,
  CdcWireOptions,
} from './types.ts'

/** Absolute safety ceiling for one encoded CDC event. */
export const MAX_CDC_WIRE_BYTES = 67_108_864

const EVENT_FIELDS = new Set([
  'specVersion',
  'eventId',
  'operation',
  'occurredAt',
  'source',
  'key',
  'before',
  'after',
  'changedColumns',
  'schemaFingerprint',
])
const SOURCE_FIELDS = new Set(['database', 'table', 'file', 'position', 'gtid'])
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const UTF8_ENCODER = new TextEncoder()

/** Error raised when untrusted CDC bytes violate the version-one wire format. */
export class CdcWireError extends Error {
  /** Stable machine-readable failure category. */
  readonly code: CdcWireErrorCode

  /**
   * Create one CDC wire failure.
   * @param code - Stable failure category.
   * @param message - Human-readable diagnostic without payload contents.
   * @param options - Optional underlying parse or decode failure.
   */
  constructor(code: CdcWireErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CdcWireError'
    this.code = code
  }
}

function resolveMaxBytes(options: CdcWireOptions | undefined): number {
  const maxBytes = options?.maxBytes ?? MAX_CDC_WIRE_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CDC_WIRE_BYTES) {
    throw new CdcWireError(
      'invalid-limit',
      `cdc: maxBytes must be an integer from 1 through ${MAX_CDC_WIRE_BYTES}`,
    )
  }
  return maxBytes
}

function assertPayloadSize(length: number, maxBytes: number): void {
  if (length === 0) {
    throw new CdcWireError('empty-payload', 'cdc: CDC payload must not be empty')
  }
  if (length > maxBytes) {
    throw new CdcWireError(
      'payload-too-large',
      `cdc: CDC payload is ${length} bytes; limit is ${maxBytes}`,
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyFields(value: Record<string, unknown>, fields: ReadonlySet<string>): boolean {
  return Object.keys(value).every(field => fields.has(field))
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

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

function invalidEventFields(parsed: Record<string, unknown>): boolean {
  const source = parsed.source
  return !hasOnlyFields(parsed, EVENT_FIELDS)
    || typeof parsed.eventId !== 'string' || parsed.eventId.length === 0
    || !['insert', 'update', 'delete'].includes(String(parsed.operation))
    || !isCanonicalTimestamp(parsed.occurredAt)
    || !isRecord(source) || !hasOnlyFields(source, SOURCE_FIELDS)
    || typeof source.database !== 'string' || source.database.length === 0
    || typeof source.table !== 'string' || source.table.length === 0
    || typeof source.file !== 'string' || source.file.length === 0
    || typeof source.position !== 'number'
    || !Number.isSafeInteger(source.position) || source.position <= 0
    || (source.gtid !== undefined && (typeof source.gtid !== 'string' || source.gtid.length === 0))
    || !isCdcKey(parsed.key)
    || (parsed.before !== null && !isCdcObject(parsed.before))
    || (parsed.after !== null && !isCdcObject(parsed.after))
    || (parsed.changedColumns !== undefined && (
      !Array.isArray(parsed.changedColumns)
      || parsed.changedColumns.some(column => typeof column !== 'string' || column.length === 0)
      || new Set(parsed.changedColumns).size !== parsed.changedColumns.length
    ))
    || typeof parsed.schemaFingerprint !== 'string' || parsed.schemaFingerprint.length === 0
    || (parsed.operation === 'insert' && (parsed.before !== null || parsed.after === null))
    || (parsed.operation === 'update' && (parsed.before === null || parsed.after === null))
    || (parsed.operation === 'delete' && (parsed.before === null || parsed.after !== null))
}

function validateEvent(parsed: unknown): CdcEvent {
  if (!isRecord(parsed)) {
    throw new CdcWireError('invalid-fields', 'cdc: CDC payload must be a JSON object')
  }
  if (parsed.specVersion !== 1) {
    throw new CdcWireError(
      'unsupported-version',
      `cdc: unsupported CDC specVersion ${JSON.stringify(parsed.specVersion)}`,
    )
  }
  if (invalidEventFields(parsed)) {
    throw new CdcWireError(
      'invalid-fields',
      'cdc: CDC payload fields do not match spec version 1',
    )
  }
  const event = parsed as unknown as CdcEvent
  if (
    event.changedColumns !== undefined
    && !findChangedColumns(event.before, event.after)
      .every(column => event.changedColumns?.includes(column) === true)
  ) {
    throw new CdcWireError(
      'invalid-fields',
      'cdc: changedColumns does not cover visible row-image differences',
    )
  }
  return event
}

/**
 * Encode one CDC event as validated UTF-8 JSON.
 * @param event - Version-one CDC event to validate before publication.
 * @param options - Optional stricter byte limit.
 * @returns Serialized UTF-8 bytes.
 */
export function encodeCdcEvent(event: CdcEvent, options?: CdcWireOptions): Buffer {
  validateEvent(event)
  const encoded = Buffer.from(UTF8_ENCODER.encode(JSON.stringify(event)))
  assertPayloadSize(encoded.byteLength, resolveMaxBytes(options))
  return encoded
}

/**
 * Parse and validate an untrusted CDC payload without accepting replacement characters.
 * @param value - Wire payload bytes.
 * @param options - Optional stricter byte limit.
 * @returns A validated version-one CDC event.
 */
export function decodeCdcEvent(value: Uint8Array, options?: CdcWireOptions): CdcEvent {
  assertPayloadSize(value.byteLength, resolveMaxBytes(options))
  let text: string
  try {
    text = UTF8_DECODER.decode(value)
  } catch (cause) {
    throw new CdcWireError('invalid-utf8', 'cdc: CDC payload is not valid UTF-8', { cause })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (cause) {
    throw new CdcWireError('invalid-json', 'cdc: CDC payload is not valid JSON', { cause })
  }
  return validateEvent(parsed)
}

/**
 * Return source columns whose values differ between row images.
 * @param before - Full image before the operation.
 * @param after - Full image after the operation.
 * @returns Unique columns in source image order.
 */
export function findChangedColumns(
  before: Record<string, CdcValue> | null,
  after: Record<string, CdcValue> | null,
): string[] {
  const columns = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
  return columns.filter(column => !isDeepEqual(before?.[column], after?.[column]))
}

function isDeepEqual(left: CdcValue | undefined, right: CdcValue | undefined): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left)) {
    return Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => isDeepEqual(value, right[index]))
  }
  if (isRecord(left)) {
    if (!isRecord(right)) return false
    const leftRecord = left as Record<string, CdcValue>
    const rightRecord = right as Record<string, CdcValue>
    const keys = Object.keys(leftRecord)
    return keys.length === Object.keys(rightRecord).length
      && keys.every(key => (
        Object.hasOwn(rightRecord, key) && isDeepEqual(leftRecord[key], rightRecord[key])
      ))
  }
  return false
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
 * Produce deterministic bytes for a compound row key.
 * @param key - Ordered compound primary-key fields.
 * @returns Canonical UTF-8 JSON bytes.
 */
export function encodeKey(key: Record<string, CdcValue>): Buffer {
  return Buffer.from(UTF8_ENCODER.encode(JSON.stringify(key)))
}
