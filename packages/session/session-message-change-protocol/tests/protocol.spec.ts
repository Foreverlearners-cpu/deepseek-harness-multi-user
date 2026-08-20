import { describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  SESSION_MESSAGE_CHANGE_EVENT_TYPE,
  SESSION_MESSAGE_CHANGE_MAX_SOURCE_SEQ,
  SESSION_MESSAGE_CHANGE_SCHEMA_VERSION,
  SessionMessageChangeEventId,
  SessionMessageChangeProtocolError,
  SessionMessageChangeUserId,
  decodeSessionMessageChange,
  encodeSessionMessageChange,
  sessionMessageChangeKafkaKey,
} from '../src/index.ts'
import type {
  SessionMessageChangeEvent,
  SessionMessageChangeProtocolErrorCode,
} from '../src/index.ts'

const encoder = new TextEncoder()
const MAX_BYTES = 4096

function event(overrides: Partial<SessionMessageChangeEvent> = {}): SessionMessageChangeEvent {
  return {
    schemaVersion: SESSION_MESSAGE_CHANGE_SCHEMA_VERSION,
    eventId: SessionMessageChangeEventId('evt-9001'),
    eventType: SESSION_MESSAGE_CHANGE_EVENT_TYPE,
    userId: SessionMessageChangeUserId('user-8'),
    sessionId: SessionId('session-100'),
    messageId: MessageId('message-12'),
    operation: 'upsert',
    sourceSeq: 12,
    occurredAt: '2026-08-19T13:49:00.000Z',
    ...overrides,
  }
}

function bytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

function decodedObject(value: SessionMessageChangeEvent = event()): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(encodeSessionMessageChange(value, { maxBytes: MAX_BYTES }))) as Record<string, unknown>
}

function expectProtocolError(
  action: () => unknown,
  code: SessionMessageChangeProtocolErrorCode,
): SessionMessageChangeProtocolError {
  try {
    action()
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(SessionMessageChangeProtocolError)
    expect(error).toMatchObject({ code })
    return error as SessionMessageChangeProtocolError
  }
  throw new Error('expected protocol operation to fail')
}

describe('session message change wire event', () => {
  it.each(['upsert', 'delete'] as const)('round-trips one %s event', (operation) => {
    const source = event({ operation })
    const encoded = encodeSessionMessageChange(source, { maxBytes: MAX_BYTES })

    expect(decodeSessionMessageChange(encoded, { maxBytes: MAX_BYTES })).toEqual(source)
    const expected = {
      schemaVersion: 1,
      eventId: 'evt-9001',
      eventType: 'session.message.changed',
      userId: 'user-8',
      sessionId: 'session-100',
      messageId: 'message-12',
      operation,
      sourceSeq: 12,
      occurredAt: '2026-08-19T13:49:00.000Z',
    }
    expect(new TextDecoder().decode(encoded)).toBe(JSON.stringify(expected))
    expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual(expected)
  })

  it('derives a deterministic unambiguous key from user and session identity', () => {
    const first = sessionMessageChangeKafkaKey(
      SessionMessageChangeUserId('user-8'),
      SessionId('session-100'),
    )
    const same = sessionMessageChangeKafkaKey(
      SessionMessageChangeUserId('user-8'),
      SessionId('session-100'),
    )
    const otherUser = sessionMessageChangeKafkaKey(
      SessionMessageChangeUserId('user-9'),
      SessionId('session-100'),
    )
    const otherSession = sessionMessageChangeKafkaKey(
      SessionMessageChangeUserId('user-8'),
      SessionId('session-101'),
    )
    const delimiterLeft = sessionMessageChangeKafkaKey(
      SessionMessageChangeUserId('user-8/session'),
      SessionId('100'),
    )
    const delimiterRight = sessionMessageChangeKafkaKey(
      SessionMessageChangeUserId('user-8'),
      SessionId('session/100'),
    )

    expect(same).toEqual(first)
    expect(otherUser).not.toEqual(first)
    expect(otherSession).not.toEqual(first)
    expect(delimiterLeft).not.toEqual(delimiterRight)
    expect(new TextDecoder().decode(first)).toBe('["user-8","session-100"]')
  })

  it('rejects a null Kafka value', () => {
    expectProtocolError(
      () => decodeSessionMessageChange(null, { maxBytes: MAX_BYTES }),
      'invalid-event',
    )
  })

  it('rejects invalid UTF-8', () => {
    expectProtocolError(
      () => decodeSessionMessageChange(Uint8Array.from([0xc3, 0x28]), { maxBytes: MAX_BYTES }),
      'invalid-utf8',
    )
  })

  it('rejects malformed JSON', () => {
    expectProtocolError(
      () => decodeSessionMessageChange(encoder.encode('{'), { maxBytes: MAX_BYTES }),
      'invalid-json',
    )
  })

  it.each([null, [], 'event', 42, true])('rejects non-object JSON value %j', (value) => {
    expectProtocolError(
      () => decodeSessionMessageChange(bytes(value), { maxBytes: MAX_BYTES }),
      'invalid-event',
    )
  })

  it.each([
    'schemaVersion',
    'eventId',
    'eventType',
    'userId',
    'sessionId',
    'messageId',
    'operation',
    'sourceSeq',
    'occurredAt',
  ])('rejects an event missing %s', (field) => {
    const value = Object.fromEntries(
      Object.entries(decodedObject()).filter(([key]) => key !== field),
    )

    expectProtocolError(
      () => decodeSessionMessageChange(bytes(value), { maxBytes: MAX_BYTES }),
      'invalid-event',
    )
  })

  it('rejects additional fields', () => {
    const value = { ...decodedObject(), content: 'protected-message-content' }
    const failure = expectProtocolError(
      () => decodeSessionMessageChange(bytes(value), { maxBytes: MAX_BYTES }),
      'invalid-event',
    )
    expect(failure.message).not.toContain('protected-message-content')
  })

  it('rejects an equal-size field set that replaces one required field', () => {
    const value = Object.fromEntries(
      Object.entries(decodedObject())
        .map(([key, fieldValue]) => key === 'messageId'
          ? ['unexpectedMessageIdentity', fieldValue]
          : [key, fieldValue]),
    )

    expect(Object.keys(value)).toHaveLength(9)
    expectProtocolError(
      () => decodeSessionMessageChange(bytes(value), { maxBytes: MAX_BYTES }),
      'invalid-event',
    )
  })

  it.each([
    ['schema version', { schemaVersion: 2 }],
    ['event type', { eventType: 'session.message.deleted' }],
    ['operation', { operation: 'insert' }],
  ])('rejects an unsupported %s', (_label, override) => {
    expectProtocolError(
      () => decodeSessionMessageChange(bytes({ ...decodedObject(), ...override }), { maxBytes: MAX_BYTES }),
      'invalid-event',
    )
  })

  it.each(['eventId', 'userId', 'sessionId', 'messageId'])('rejects blank %s', (field) => {
    expectProtocolError(
      () => decodeSessionMessageChange(
        bytes({ ...decodedObject(), [field]: ' \t ' }),
        { maxBytes: MAX_BYTES },
      ),
      'invalid-event',
    )
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    'rejects sourceSeq %s',
    (sourceSeq) => {
      expectProtocolError(
        () => decodeSessionMessageChange(
          bytes({ ...decodedObject(), sourceSeq }),
          { maxBytes: MAX_BYTES },
        ),
        'invalid-event',
      )
    },
  )

  it.each([0, SESSION_MESSAGE_CHANGE_MAX_SOURCE_SEQ])(
    'accepts sourceSeq endpoint %s',
    (sourceSeq) => {
      expect(decodeSessionMessageChange(
        bytes({ ...decodedObject(), sourceSeq }),
        { maxBytes: MAX_BYTES },
      )).toMatchObject({ sourceSeq })
    },
  )

  it.each([
    '2026-08-19T13:49:00Z',
    '2026-08-19T13:49:00.000+00:00',
    '2026-08-19 13:49:00.000Z',
    '2026-02-30T13:49:00.000Z',
    'not-a-time',
  ])('rejects non-canonical occurredAt %s', (occurredAt) => {
    expectProtocolError(
      () => decodeSessionMessageChange(
        bytes({ ...decodedObject(), occurredAt }),
        { maxBytes: MAX_BYTES },
      ),
      'invalid-event',
    )
  })

  it('accepts the exact byte limit and rejects one byte less', () => {
    const encoded = encodeSessionMessageChange(event(), { maxBytes: MAX_BYTES })

    expect(decodeSessionMessageChange(encoded, { maxBytes: encoded.byteLength })).toEqual(event())
    expectProtocolError(
      () => decodeSessionMessageChange(encoded, { maxBytes: encoded.byteLength - 1 }),
      'payload-too-large',
    )
    expectProtocolError(
      () => encodeSessionMessageChange(event(), { maxBytes: encoded.byteLength - 1 }),
      'payload-too-large',
    )
  })

  it('counts multibyte identities by encoded bytes', () => {
    const multibyte = event({ userId: SessionMessageChangeUserId('用户') })
    const encoded = encodeSessionMessageChange(multibyte, { maxBytes: MAX_BYTES })
    const characterLength = new TextDecoder().decode(encoded).length

    expect(encoded.byteLength).toBeGreaterThan(characterLength)
    expectProtocolError(
      () => encodeSessionMessageChange(multibyte, { maxBytes: characterLength }),
      'payload-too-large',
    )
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects maxBytes configuration %s',
    (maxBytes) => {
      expectProtocolError(
        () => encodeSessionMessageChange(event(), { maxBytes }),
        'invalid-limit',
      )
      expectProtocolError(
        () => decodeSessionMessageChange(bytes(decodedObject()), { maxBytes }),
        'invalid-limit',
      )
    },
  )

  it('keeps protected values out of every invalid-event diagnostic', () => {
    const protectedValues = [
      'evt-private',
      'user-private',
      'session-private',
      'message-private',
    ]
    const value = {
      ...decodedObject(event({
        eventId: SessionMessageChangeEventId(protectedValues[0] as string),
        userId: SessionMessageChangeUserId(protectedValues[1] as string),
        sessionId: SessionId(protectedValues[2] as string),
        messageId: MessageId(protectedValues[3] as string),
      })),
      operation: 'unsupported',
    }

    const failure = expectProtocolError(
      () => decodeSessionMessageChange(bytes(value), { maxBytes: MAX_BYTES }),
      'invalid-event',
    )
    for (const protectedValue of protectedValues) {
      expect(failure.message).not.toContain(protectedValue)
    }
  })
})
