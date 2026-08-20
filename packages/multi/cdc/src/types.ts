/** Operation represented by one MySQL row-change event. */
export type CdcOperation = 'insert' | 'update' | 'delete'

/** JSON-safe scalar or recursively nested value. */
export type CdcValue = null | boolean | number | string | CdcValue[] | { [key: string]: CdcValue }

/** Position of the source event in one MySQL binary log. */
export interface CdcSource {
  database: string
  table: string
  file: string
  position: number
  gtid?: string
}

/** Stable, versioned Kafka payload emitted for one changed row. */
export interface CdcEvent {
  specVersion: 1
  eventId: string
  operation: CdcOperation
  occurredAt: string
  source: CdcSource
  /** Current row identity used for Kafka partitioning and projection writes. */
  key: Record<string, CdcValue>
  before: Record<string, CdcValue> | null
  after: Record<string, CdcValue> | null
  /** Source columns changed by this row event; optional for older version-one records. */
  changedColumns?: string[]
  schemaFingerprint: string
}

/** Durable restart position and observed table schemas. */
export interface CdcCheckpoint {
  version: 1
  file: string
  position: number
  schemas: Record<string, string>
}
