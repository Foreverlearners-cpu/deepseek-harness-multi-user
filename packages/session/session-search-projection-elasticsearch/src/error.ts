/**
 * Stable, content-free failures for the session search projection Consumer.
 * @module @deepseek-ai/dsh-session-search-projection-elasticsearch/error
 */

/** Machine-readable projection failure category. */
export type SessionSearchProjectionErrorCode =
  | 'mapping-mismatch'
  | 'query-failed'
  | 'identity-mismatch'
  | 'elasticsearch-failed'

const ERROR_MESSAGES: Readonly<Record<SessionSearchProjectionErrorCode, string>> = {
  'mapping-mismatch': 'session search projection index mapping does not match the required field types',
  'query-failed': 'session search projection complete-message query failed',
  'identity-mismatch': 'session search projection source identities do not match the event',
  'elasticsearch-failed': 'session search projection Elasticsearch write failed',
}

/** Typed projection failure that never includes protected identifiers or document content. */
export class SessionSearchProjectionError extends Error {
  /**
   * Construct one stable projection failure.
   * @param code - Machine-readable failure category.
   * @param options - Optional cause retained for diagnostics without copying protected values into the message.
   */
  constructor(readonly code: SessionSearchProjectionErrorCode, options?: ErrorOptions) {
    super(ERROR_MESSAGES[code], options)
    this.name = 'SessionSearchProjectionError'
  }
}
