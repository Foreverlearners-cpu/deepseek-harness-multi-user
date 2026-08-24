import { describe, expect, it } from 'vitest'
import {
  decodeCdcEvent,
  encodeCdcEvent,
  encodeKey,
  findChangedColumns,
  getChangedColumns,
  normalizeRow,
  type CdcEvent,
} from '@deepseek-ai/dsh-cdc'

const event: CdcEvent = {
  specVersion: 1,
  eventId: 'event-1',
  operation: 'update',
  occurredAt: '2026-08-19T12:00:00.000Z',
  source: { database: 'app', table: 'users', file: 'mysql-bin.000001', position: 123 },
  key: { id: '9007199254740993' },
  before: { id: '9007199254740993', name: 'old' },
  after: { id: '9007199254740993', name: 'new' },
  changedColumns: ['name'],
  schemaFingerprint: 'schema-1',
}

describe('CDC codec', () => {
  it('round-trips one valid event and encodes its compound key', () => {
    expect(decodeCdcEvent(encodeCdcEvent(event))).toEqual(event)
    expect(encodeKey(event.key).toString()).toBe('{"id":"9007199254740993"}')
    expect(getChangedColumns(event)).toEqual(['name'])
    expect(findChangedColumns(event.before, event.after)).toEqual(['name'])
  })

  it('normalizes exact, binary, temporal, JSON, and excluded values', () => {
    expect(normalizeRow({
      id: 1n,
      amount: '12.3400',
      payload: Buffer.from([0, 255]),
      created: new Date('2026-08-19T00:00:00.000Z'),
      nested: { enabled: true, values: [1, null] },
      secret: 'omit',
    }, new Set(['secret']))).toEqual({
      id: '1',
      amount: '12.3400',
      payload: { $binary: 'AP8=' },
      created: { $date: '2026-08-19T00:00:00.000Z' },
      nested: { enabled: true, values: [1, null] },
    })
  })

  it.each([
    Buffer.from('not-json'),
    Buffer.from('{}'),
    Buffer.from(JSON.stringify({ ...event, operation: 'insert', after: null })),
    Buffer.from(JSON.stringify({ ...event, key: { id: Number.POSITIVE_INFINITY } })),
    Buffer.from(JSON.stringify({ ...event, changedColumns: ['name', 'name'] })),
    Buffer.from(JSON.stringify({ ...event, changedColumns: ['email'] })),
  ])('rejects an invalid Kafka payload', (payload) => {
    expect(() => decodeCdcEvent(payload)).toThrow(/cdc:/u)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, undefined, Symbol('bad')])(
    'rejects unsupported row value %s',
    (value) => {
      expect(() => normalizeRow({ value }, new Set())).toThrow(/cdc:/u)
    },
  )
})
