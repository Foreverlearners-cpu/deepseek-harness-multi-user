/**
 * Elasticsearch document identity, mapping checks, and version-conflict detection
 * for the session search projection Consumer.
 * @module @deepseek-ai/dsh-session-search-projection-elasticsearch/document
 */

import { createHash } from 'node:crypto'
import type { ElasticsearchClient } from '@deepseek-ai/dsh-elasticsearch'
import { SessionSearchProjectionError } from './error.ts'

const REQUIRED_MAPPING_TYPES = {
  user: 'keyword',
  session: 'keyword',
  message: 'keyword',
  role: 'keyword',
  content: 'text',
  source_time: 'date',
  source_seq: 'long',
  deleted: 'boolean',
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Derive the stable Elasticsearch document id for one user/message pair.
 * @param userId - Authoritative private-session owner.
 * @param messageId - Immutable message identity.
 * @returns Lowercase hex SHA-256 of the JSON tuple `[userId, messageId]`.
 */
export function sessionSearchProjectionDocumentId(userId: string, messageId: string): string {
  return createHash('sha256').update(JSON.stringify([userId, messageId])).digest('hex')
}

function fieldType(value: unknown): string | undefined {
  return isRecord(value) && typeof value.type === 'string' ? value.type : undefined
}

function assertProperties(properties: unknown): void {
  if (!isRecord(properties)) throw new SessionSearchProjectionError('mapping-mismatch')
  for (const [field, type] of Object.entries(REQUIRED_MAPPING_TYPES)) {
    if (fieldType(properties[field]) !== type) throw new SessionSearchProjectionError('mapping-mismatch')
  }
}

/**
 * Read the live index mapping and require each projection field's Elasticsearch type.
 * Extra fields are allowed. The Consumer never creates or updates mappings.
 * @param client - Borrowed official Elasticsearch client.
 * @param index - Configured index name.
 * @throws {@link SessionSearchProjectionError} when the index is missing or a required field type does not match.
 */
export async function assertSessionSearchProjectionMapping(
  client: ElasticsearchClient,
  index: string,
): Promise<void> {
  let response: unknown
  try {
    response = await client.indices.getMapping({ index })
  } catch (cause) {
    throw new SessionSearchProjectionError('mapping-mismatch', { cause })
  }
  if (!isRecord(response)) throw new SessionSearchProjectionError('mapping-mismatch')
  const entries = Object.values(response)
  if (entries.length === 0) throw new SessionSearchProjectionError('mapping-mismatch')
  for (const entry of entries) {
    if (!isRecord(entry) || !isRecord(entry.mappings)) throw new SessionSearchProjectionError('mapping-mismatch')
    assertProperties(entry.mappings.properties)
  }
}

/**
 * Detect an Elasticsearch external-version conflict that already holds equal or newer state.
 * @param error - Failure thrown by an index request.
 * @returns Whether the failure is a version-conflict engine exception with HTTP 409.
 */
export function isExternalVersionConflict(error: unknown): boolean {
  if (!isRecord(error)) return false
  const meta = isRecord(error.meta) ? error.meta : undefined
  const status = typeof error.statusCode === 'number'
    ? error.statusCode
    : meta !== undefined && typeof meta.statusCode === 'number'
      ? meta.statusCode
      : undefined
  if (status !== 409) return false
  const body = (meta !== undefined && isRecord(meta.body) ? meta.body : undefined)
    ?? (isRecord(error.body) ? error.body : undefined)
  const nested = body !== undefined && isRecord(body.error) ? body.error : undefined
  return nested !== undefined && nested.type === 'version_conflict_engine_exception'
}
