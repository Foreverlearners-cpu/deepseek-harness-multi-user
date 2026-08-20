/**
 * Strict, content-free Kafka wire protocol for one authoritative session
 * message change. Producers and projection Consumers share this library so
 * field validation, payload bounds, identities, and partition keys cannot drift.
 * @module @deepseek-ai/dsh-session-message-change-protocol
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Wire schema version accepted by this pre-release protocol. */
export const SESSION_MESSAGE_CHANGE_SCHEMA_VERSION = 1

/** Sole event type carried by this protocol. */
export const SESSION_MESSAGE_CHANGE_EVENT_TYPE = 'session.message.changed'

/** Largest source sequence that can map to the positive Elasticsearch version `sourceSeq + 1`. */
export const SESSION_MESSAGE_CHANGE_MAX_SOURCE_SEQ = Number.MAX_SAFE_INTEGER - 1

/** Opaque identity of one source change, stable across publication retries. */
export type SessionMessageChangeEventId = Branded<'SessionMessageChangeEventId'>

/**
 * Brand a producer-owned event identity.
 * @param value - Opaque event identity already selected by the producer.
 * @returns The same string with its session-message-change event brand.
 */
export function SessionMessageChangeEventId(value: string): SessionMessageChangeEventId {
  return value as SessionMessageChangeEventId
}

/** Opaque private-session owner inside one physically single-tenant deployment. */
export type SessionMessageChangeUserId = Branded<'SessionMessageChangeUserId'>

/**
 * Brand an authoritative user identity.
 * @param value - Opaque user identity obtained from authoritative session ownership.
 * @returns The same string with its session-message-change user brand.
 */
export function SessionMessageChangeUserId(value: string): SessionMessageChangeUserId {
  return value as SessionMessageChangeUserId
}

/** Projection operation represented by one message change. */
export type SessionMessageChangeOperation = 'upsert' | 'delete'

/** Complete version-1 session message change event. */
export interface SessionMessageChangeEvent {
  /** Exact wire schema version. */
  readonly schemaVersion: typeof SESSION_MESSAGE_CHANGE_SCHEMA_VERSION
  /** Stable identity of this source change. */
  readonly eventId: SessionMessageChangeEventId
  /** Exact session message change discriminator. */
  readonly eventType: typeof SESSION_MESSAGE_CHANGE_EVENT_TYPE
  /** Authoritative private-session owner inside the deployment. */
  readonly userId: SessionMessageChangeUserId
  /** Session containing the changed message. */
  readonly sessionId: SessionId
  /** Immutable semantic message identity. */
  readonly messageId: MessageId
  /** Whether projections materialize or tombstone the message. */
  readonly operation: SessionMessageChangeOperation
  /** Monotonic sequence of the authoritative message fact inside the session. */
  readonly sourceSeq: number
  /** Canonical UTC timestamp used for diagnostics, never ordering. */
  readonly occurredAt: string
}

/** Required complete-payload limit for one encode or decode operation. */
export interface SessionMessageChangeCodecOptions {
  /** Maximum UTF-8 payload bytes, inclusive. */
  readonly maxBytes: number
}

/** Stable failure categories that never include protected payload values. */
export type SessionMessageChangeProtocolErrorCode =
  | 'invalid-limit'
  | 'payload-too-large'
  | 'invalid-utf8'
  | 'invalid-json'
  | 'invalid-event'

const ERROR_MESSAGES: Readonly<Record<SessionMessageChangeProtocolErrorCode, string>> = {
  'invalid-limit': 'session message change maxBytes must be a positive safe integer',
  'payload-too-large': 'session message change payload exceeds maxBytes',
  'invalid-utf8': 'session message change payload must be valid UTF-8',
  'invalid-json': 'session message change payload must be valid JSON',
  'invalid-event': 'session message change payload does not match schema version 1',
}

/** Typed, content-free protocol failure. */
export class SessionMessageChangeProtocolError extends Error {
  /**
   * Construct one stable protocol failure.
   * @param code - Machine-readable failure category.
   */
  constructor(readonly code: SessionMessageChangeProtocolErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'SessionMessageChangeProtocolError'
  }
}

const encoder = new TextEncoder()
const EXPECTED_FIELDS = new Set([
  'schemaVersion',
  'eventId',
  'eventType',
  'userId',
  'sessionId',
  'messageId',
  'operation',
  'sourceSeq',
  'occurredAt',
])
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

function fail(code: SessionMessageChangeProtocolErrorCode): never {
  throw new SessionMessageChangeProtocolError(code)
}

function assertLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('invalid-limit')
}

function assertBounded(bytes: Uint8Array, maxBytes: number): void {
  if (bytes.byteLength > maxBytes) fail('payload-too-large')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactFields(value: Record<string, unknown>): boolean {
  const fields = Object.keys(value)
  return fields.length === EXPECTED_FIELDS.size && fields.every(field => EXPECTED_FIELDS.has(field))
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isCanonicalUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_UTC.test(value)) return false
  const epoch = Date.parse(value)
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value
}

/**
 * Encode one typed event as bounded canonical-field-order UTF-8 JSON.
 *
 * Same-process callers remain responsible for constructing the typed event;
 * untrusted wire values are validated by {@link decodeSessionMessageChange}.
 * @param event - Typed source change event.
 * @param options - Required complete-payload byte limit.
 * @returns Bounded UTF-8 JSON bytes accepted by `ctx.kafka.publish`.
 * @throws {@link SessionMessageChangeProtocolError} when the limit is invalid or the encoded payload exceeds it.
 */
export function encodeSessionMessageChange(
  event: SessionMessageChangeEvent,
  options: SessionMessageChangeCodecOptions,
): Uint8Array {
  assertLimit(options.maxBytes)
  const bytes = encoder.encode(JSON.stringify({
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    eventType: event.eventType,
    userId: event.userId,
    sessionId: event.sessionId,
    messageId: event.messageId,
    operation: event.operation,
    sourceSeq: event.sourceSeq,
    occurredAt: event.occurredAt,
  }))
  assertBounded(bytes, options.maxBytes)
  return bytes
}

/**
 * Decode and validate one bounded Kafka value.
 * @param value - Kafka record value, or `null` for a broker tombstone.
 * @param options - Required complete-payload byte limit.
 * @returns A validated, branded version-1 event.
 * @throws {@link SessionMessageChangeProtocolError} for every invalid boundary value.
 */
export function decodeSessionMessageChange(
  value: Uint8Array | null,
  options: SessionMessageChangeCodecOptions,
): SessionMessageChangeEvent {
  assertLimit(options.maxBytes)
  if (value === null) fail('invalid-event')
  assertBounded(value, options.maxBytes)

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    fail('invalid-utf8')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    fail('invalid-json')
  }

  if (!isRecord(parsed) || !hasExactFields(parsed)) fail('invalid-event')
  if (parsed.schemaVersion !== SESSION_MESSAGE_CHANGE_SCHEMA_VERSION) fail('invalid-event')
  if (parsed.eventType !== SESSION_MESSAGE_CHANGE_EVENT_TYPE) fail('invalid-event')
  if (
    !isNonBlankString(parsed.eventId)
    || !isNonBlankString(parsed.userId)
    || !isNonBlankString(parsed.sessionId)
    || !isNonBlankString(parsed.messageId)
  ) {
    fail('invalid-event')
  }
  if (parsed.operation !== 'upsert' && parsed.operation !== 'delete') fail('invalid-event')
  if (
    !Number.isSafeInteger(parsed.sourceSeq)
    || (parsed.sourceSeq as number) < 0
    || (parsed.sourceSeq as number) > SESSION_MESSAGE_CHANGE_MAX_SOURCE_SEQ
  ) {
    fail('invalid-event')
  }
  if (!isCanonicalUtc(parsed.occurredAt)) fail('invalid-event')

  return {
    schemaVersion: SESSION_MESSAGE_CHANGE_SCHEMA_VERSION,
    eventId: SessionMessageChangeEventId(parsed.eventId),
    eventType: SESSION_MESSAGE_CHANGE_EVENT_TYPE,
    userId: SessionMessageChangeUserId(parsed.userId),
    sessionId: parsed.sessionId as SessionId,
    messageId: parsed.messageId as MessageId,
    operation: parsed.operation,
    sourceSeq: parsed.sourceSeq as number,
    occurredAt: parsed.occurredAt,
  }
}

/**
 * Derive the unambiguous Kafka partition key for one user/session pair.
 * @param userId - Authoritative private-session owner.
 * @param sessionId - Session whose changes require ordered delivery.
 * @returns UTF-8 JSON tuple bytes; equal pairs produce equal bytes.
 */
export function sessionMessageChangeKafkaKey(
  userId: SessionMessageChangeUserId,
  sessionId: SessionId,
): Uint8Array {
  return encoder.encode(JSON.stringify([userId, sessionId]))
}
