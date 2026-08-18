import { MultipleErrors, TimeoutError } from '@platformatic/kafka'

/** Classified failures exposed by the Host-only Kafka transport service. */
export type KafkaErrorCode =
  | 'authentication'
  | 'configuration'
  | 'protocol'
  | 'shutdown'
  | 'timeout'
  | 'unavailable'
  | 'unknown'

/**
 * Kafka infrastructure failure without broker responses, endpoints, or credentials in its message.
 */
export class KafkaError extends Error {
  override readonly name = 'KafkaError'

  /**
   * @param code - Stable failure category for readiness and operator handling.
   * @param binding - Binding whose operation failed.
   * @param options - Original client failure retained as a non-serialized cause.
   */
  constructor(
    readonly code: KafkaErrorCode,
    readonly binding: string,
    options?: ErrorOptions,
  ) {
    super(`Kafka binding '${binding}' failed: ${code}`, options)
  }
}

/**
 * Classify a Platformatic Kafka client failure without copying its text into diagnostics.
 * @param cause - Failure raised by the client or an unknown dependency failure.
 * @param binding - Binding whose operation failed.
 * @returns a stable infrastructure error.
 */
export function classifyKafkaError(cause: unknown, binding: string): KafkaError {
  if (cause instanceof KafkaError) return cause
  return new KafkaError(classifyKafkaErrorCode(cause, new Set()), binding, { cause })
}

function classifyKafkaErrorCode(cause: unknown, ancestors: Set<object>): KafkaErrorCode {
  const current = objectCause(cause)
  if (current !== undefined) {
    if (ancestors.has(current)) return 'unknown'
    ancestors.add(current)
  }
  try {
    // Platformatic Kafka reports TimeoutError.code as PLT_KFK_NETWORK.
    if (cause instanceof TimeoutError) return 'timeout'
    const code = errorCode(cause)
    switch (code) {
      case 'PLT_KFK_AUTHENTICATION':
        return 'authentication'
      case 'PLT_KFK_NETWORK':
        // Connection setup wraps specific authentication and timeout causes.
        return classifyNetworkError(cause, ancestors)
      case 'PLT_KFK_TIMEOUT':
        return 'timeout'
      case 'PLT_KFK_USER':
        return 'configuration'
      case 'PLT_KFK_PROTOCOL':
      case 'PLT_KFK_RESPONSE':
      case 'PLT_KFK_UNEXPECTED_CORRELATION_ID':
      case 'PLT_KFK_UNFINISHED_WRITE_BUFFER':
      case 'PLT_KFK_UNSUPPORTED_API':
      case 'PLT_KFK_UNSUPPORTED_COMPRESSION':
      case 'PLT_KFK_UNSUPPORTED':
        return 'protocol'
      case 'PLT_KFK_MULTIPLE':
        return classifyMultipleErrors(cause, ancestors)
      default:
        return 'unknown'
    }
  } finally {
    if (current !== undefined) ancestors.delete(current)
  }
}

function classifyNetworkError(cause: unknown, ancestors: Set<object>): KafkaErrorCode {
  const nested = errorCause(cause)
  if (nested === undefined) return 'unavailable'
  const category = classifyKafkaErrorCode(nested, ancestors)
  return category === 'authentication' || category === 'timeout' ? category : 'unavailable'
}

function classifyMultipleErrors(cause: unknown, ancestors: Set<object>): KafkaErrorCode {
  if (!(cause instanceof MultipleErrors) || cause.errors.length === 0) {
    return 'unknown'
  }
  const categories = cause.errors.map(error => classifyKafkaErrorCode(error, ancestors))
  const first = categories[0]
  if (first === undefined) return 'unknown'
  return categories.every(category => category === first) ? first : 'unknown'
}

function objectCause(cause: unknown): object | undefined {
  return typeof cause === 'object' && cause !== null ? cause : undefined
}

function errorCause(cause: unknown): unknown {
  const object = objectCause(cause)
  return object !== undefined && 'cause' in object ? object.cause : undefined
}

function errorCode(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) return undefined
  return typeof cause.code === 'string' ? cause.code : undefined
}
