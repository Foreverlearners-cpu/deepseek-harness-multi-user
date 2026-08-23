import { createHash } from 'node:crypto'
import type { ElasticsearchClient } from '@deepseek-ai/dsh-elasticsearch'
import { SessionSearchProjectionError } from './error.ts'

const REQUIRED_MAPPING_TYPES = {
  tenant: 'keyword',
  user: 'keyword',
  session: 'keyword',
  message: 'keyword',
  status: 'keyword',
  visibility: 'keyword',
  role: 'keyword',
  content: 'text',
  source_time: 'date',
  revision: 'long',
  deleted: 'boolean',
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Derive a tenant-safe document identity.
 * @param tenantId - Authoritative tenant identity.
 * @param userId - Authoritative session owner.
 * @param messageId - Immutable message identity.
 * @returns SHA-256 of the identity tuple.
 */
export function sessionSearchProjectionDocumentId(
  tenantId: string,
  userId: string,
  messageId: string,
): string {
  return createHash('sha256').update(JSON.stringify([tenantId, userId, messageId])).digest('hex')
}

function fieldType(value: unknown): string | undefined {
  return isRecord(value) && typeof value.type === 'string' ? value.type : undefined
}

/**
 * Require the existing index to expose every projection field with its fixed type.
 * @param client - Borrowed Elasticsearch client.
 * @param index - Existing projection index.
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
  if (!isRecord(response) || Object.keys(response).length === 0) {
    throw new SessionSearchProjectionError('mapping-mismatch')
  }
  for (const entry of Object.values(response)) {
    if (!isRecord(entry) || !isRecord(entry.mappings) || !isRecord(entry.mappings.properties)) {
      throw new SessionSearchProjectionError('mapping-mismatch')
    }
    for (const [field, type] of Object.entries(REQUIRED_MAPPING_TYPES)) {
      if (fieldType(entry.mappings.properties[field]) !== type) {
        throw new SessionSearchProjectionError('mapping-mismatch')
      }
    }
  }
}

/**
 * Detect an external-version conflict that proves equal or newer state exists.
 * @param error - Elasticsearch request failure.
 * @returns Whether the failure is the expected HTTP 409 version conflict.
 */
export function isExternalVersionConflict(error: unknown): boolean {
  if (!isRecord(error)) return false
  const meta = isRecord(error.meta) ? error.meta : undefined
  const status = typeof error.statusCode === 'number'
    ? error.statusCode
    : meta !== undefined && typeof meta.statusCode === 'number' ? meta.statusCode : undefined
  const body = (meta !== undefined && isRecord(meta.body) ? meta.body : undefined)
    ?? (isRecord(error.body) ? error.body : undefined)
  const nested = body !== undefined && isRecord(body.error) ? body.error : undefined
  return status === 409 && nested?.type === 'version_conflict_engine_exception'
}
