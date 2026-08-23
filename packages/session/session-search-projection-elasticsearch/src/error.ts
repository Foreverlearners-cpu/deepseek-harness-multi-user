/** Stable failures for the CDC-backed session search projection. */
export type SessionSearchProjectionErrorCode =
  | 'invalid-event'
  | 'invalid-record'
  | 'mapping-mismatch'
  | 'elasticsearch-failed'

const MESSAGES: Readonly<Record<SessionSearchProjectionErrorCode, string>> = {
  'invalid-event': 'session search projection CDC event is invalid for the configured route',
  'invalid-record': 'session search projection authoritative record is invalid',
  'mapping-mismatch': 'session search projection index mapping does not match the required field types',
  'elasticsearch-failed': 'session search projection Elasticsearch write failed',
}

/** Content-free projection failure safe for operational classification. */
export class SessionSearchProjectionError extends Error {
  /**
   * @param code - Stable failure category.
   * @param options - Optional protected cause retained without copying its message.
   */
  constructor(readonly code: SessionSearchProjectionErrorCode, options?: ErrorOptions) {
    super(MESSAGES[code], options)
    this.name = 'SessionSearchProjectionError'
  }
}
