import { describe, expect, it } from 'vitest'
import {
  CdcWireError,
  MAX_CDC_WIRE_BYTES,
  decodeCdcEvent,
  encodeCdcEvent,
  encodeKey,
  findChangedColumns,
  getChangedColumns,
  type CdcEvent,
  type CdcWireErrorCode,
} from '@deepseek-ai/dsh-cdc-protocol'

const event: CdcEvent = {
  specVersion: 1,
  eventId: 'event-1',
  operation: 'update',
  occurredAt: '2026-08-23T12:00:00.000Z',
  source: {
    database: 'app',
    table: 'users',
    file: 'mysql-bin.000001',
    position: 123,
    gtid: 'server:1',
  },
  key: { tenant_id: 'tenant-1', id: '9007199254740993' },
  before: { id: '9007199254740993', profile: { name: 'old', flags: [true, null] } },
  after: { id: '9007199254740993', profile: { name: 'new', flags: [true, null] } },
  changedColumns: ['profile'],
  schemaFingerprint: 'schema-1',
}

function payload(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ ...event, ...overrides }))
}

function expectWireError(run: () => unknown, code: CdcWireErrorCode): void {
  try {
    run()
  } catch (cause) {
    expect(cause).toBeInstanceOf(CdcWireError)
    expect((cause as CdcWireError).code).toBe(code)
    return
  }
  throw new Error(`expected CdcWireError ${code}`)
}

describe('CDC protocol codec', () => {
  it('round-trips one event and preserves error identity', () => {
    expect(decodeCdcEvent(encodeCdcEvent(event))).toEqual(event)
    expect(encodeKey(event.key).toString()).toBe('{"tenant_id":"tenant-1","id":"9007199254740993"}')
    const cause = new Error('parse')
    const error = new CdcWireError('invalid-json', 'bad JSON', { cause })
    expect(error).toMatchObject({ name: 'CdcWireError', code: 'invalid-json', cause })
  })

  it('derives deep changes and honors a producer-supplied list', () => {
    expect(findChangedColumns(
      { same: { nested: [1, true] }, removed: 'old', changed: ['a'] },
      { same: { nested: [1, true] }, added: 'new', changed: ['b'] },
    )).toEqual(['removed', 'changed', 'added'])
    expect(findChangedColumns({ value: { a: 1 } }, { value: { a: 1, b: 2 } })).toEqual(['value'])
    expect(findChangedColumns({ value: [1] }, { value: { 0: 1 } })).toEqual(['value'])
    expect(findChangedColumns({ value: '1' }, { value: 1 })).toEqual(['value'])
    expect(getChangedColumns(event)).toEqual(['profile'])
    expect(getChangedColumns({ ...event, changedColumns: undefined })).toEqual(['profile'])
  })

  it.each([
    [undefined, 'invalid-limit'],
    [0, 'invalid-limit'],
    [1.5, 'invalid-limit'],
    [MAX_CDC_WIRE_BYTES + 1, 'invalid-limit'],
  ] as const)('rejects invalid byte limit %s', (maxBytes, code) => {
    const options = maxBytes === undefined ? { maxBytes: undefined } : { maxBytes }
    if (maxBytes === undefined) {
      expect(decodeCdcEvent(encodeCdcEvent(event), options)).toEqual(event)
      return
    }
    expectWireError(() => decodeCdcEvent(payload(), options), code)
  })

  it('rejects empty, oversized, and malformed text before field validation', () => {
    expectWireError(() => decodeCdcEvent(Buffer.alloc(0)), 'empty-payload')
    expectWireError(() => decodeCdcEvent(payload(), { maxBytes: 1 }), 'payload-too-large')
    expectWireError(() => encodeCdcEvent(event, { maxBytes: 1 }), 'payload-too-large')
    expectWireError(() => decodeCdcEvent(Buffer.from([0xc3, 0x28])), 'invalid-utf8')
    expectWireError(() => decodeCdcEvent(Buffer.from('{')), 'invalid-json')
  })

  it.each([
    Buffer.from('null'),
    Buffer.from('[]'),
    payload({ extra: true }),
    payload({ eventId: '' }),
    payload({ operation: 'replace' }),
    payload({ occurredAt: '2026-08-23' }),
    payload({ source: null }),
    payload({ source: { ...event.source, extra: true } }),
    payload({ source: { ...event.source, database: '' } }),
    payload({ source: { ...event.source, table: '' } }),
    payload({ source: { ...event.source, file: '' } }),
    payload({ source: { ...event.source, position: 0 } }),
    payload({ source: { ...event.source, position: 1.5 } }),
    payload({ source: { ...event.source, gtid: '' } }),
    payload({ key: {} }),
    payload({ key: { id: null } }),
    payload({ key: { id: Number.POSITIVE_INFINITY } }),
    payload({ before: [] }),
    payload({ after: { value: undefined } }),
    payload({ changedColumns: 'profile' }),
    payload({ changedColumns: [''] }),
    payload({ changedColumns: ['profile', 'profile'] }),
    payload({ changedColumns: ['unrelated'] }),
    payload({ schemaFingerprint: '' }),
    payload({ operation: 'insert', before: {}, after: {} }),
    payload({ operation: 'insert', before: null, after: null }),
    payload({ operation: 'update', before: null, after: {} }),
    payload({ operation: 'update', before: {}, after: null }),
    payload({ operation: 'delete', before: null, after: null }),
    payload({ operation: 'delete', before: {}, after: {} }),
  ])('rejects invalid version-one fields', (value) => {
    expectWireError(() => decodeCdcEvent(value), 'invalid-fields')
  })

  it.each([undefined, 0, 2, '1'])('rejects unsupported specVersion %s', (specVersion) => {
    expectWireError(() => decodeCdcEvent(payload({ specVersion })), 'unsupported-version')
  })

  it('validates outbound events before publication', () => {
    expectWireError(
      () => encodeCdcEvent({ ...event, eventId: '' } as CdcEvent),
      'invalid-fields',
    )
  })
})
