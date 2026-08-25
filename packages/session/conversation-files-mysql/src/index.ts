/** MySQL metadata and externalization policy for immutable conversation files. */

import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  conversationCursor,
  conversationFileId,
  type ConversationFileId,
  type ConversationIdentity,
  type MessageId,
} from '@deepseek-ai/dsh-conversation'
import type { ConversationRecordDraft } from '@deepseek-ai/dsh-conversation-persistence'
import {
  FileObjectId,
  FileObjectSha256,
  FileStorageBackend,
  FileStorageKey,
  type FileObjectRef,
} from '@deepseek-ai/dsh-file-storage'
import type { MysqlConnection } from '@deepseek-ai/dsh-mysql'
import z from '@deepseek-ai/schemastery'
import type { RowDataPacket } from 'mysql2/promise'
import { initializeSchema } from './schema.ts'
import type {
  ConversationFile,
  ConversationFileErrorCode,
  ConversationFileIdentity,
  ConversationFileListQuery,
  ConversationFilePage,
  ConversationFilePublishRequest,
  ConversationMessageFileListQuery,
  OpenConversationFile,
} from './types.ts'

export type * from './types.ts'

/** Default byte threshold above which a complete tool result becomes a JSON object. */
export const DEFAULT_TOOL_RESULT_OBJECT_THRESHOLD_BYTES = 256 * 1024
const DEFAULT_PAGE_LIMIT = 100
const MAX_PAGE_LIMIT = 1_000
type SqlValue = number | string | null
const FILE_COLUMNS = `cf.tenant_id, cf.user_id, cf.conversation_id, cf.file_id,
  cf.media_type, cf.file_name, cf.created_at, fo.object_id, fo.storage_backend,
  fo.storage_key, fo.sha256, fo.byte_size`

/** Tool-result object externalization configuration. */
export interface Config {
  /** Strict UTF-8 JSON byte threshold; values equal to it remain inline. */
  readonly toolResultObjectThresholdBytes?: number
}

/** Validated configuration schema. */
export const Config: z<Config> = z.object({
  toolResultObjectThresholdBytes: z.natural().min(1).default(DEFAULT_TOOL_RESULT_OBJECT_THRESHOLD_BYTES),
})

interface FileRow extends RowDataPacket {
  tenant_id: string
  user_id: string
  conversation_id: string
  file_id: string
  media_type: string
  file_name: string | null
  created_at: string
  object_id: string
  storage_backend: string
  storage_key: string
  sha256: string
  byte_size: number | string
}

interface ObjectRow extends RowDataPacket {
  object_id: string
  storage_backend: string
  storage_key: string
  sha256: string
  byte_size: number | string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Owner-scoped conversation file metadata and immutable object access. */
    conversationFiles: ConversationFilesMysql
  }
}

/** Public failure with a stable category and no storage credentials. */
export class ConversationFileError extends Error {
  /** Stable category safe for transport mapping. */
  readonly code: ConversationFileErrorCode

  /** @param code - stable category. @param message - diagnostic without object keys. @param options - optional cause. */
  constructor(code: ConversationFileErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ConversationFileError'
    this.code = code
  }
}

/** MySQL metadata service and record preparer for complete conversation files. */
export class ConversationFilesMysql extends Service {
  static inject = ['mysql', 'fileStorage', 'conversationPersistence']
  static Config: z<Config> = Config
  private readonly threshold: number

  /** @param ctx - owning Host context. @param config - externalization policy. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'conversationFiles')
    this.threshold = (config as Required<Config>).toolResultObjectThresholdBytes
  }

  /** Initialize schema and register the append-time tool-result preparer. */
  async [Service.init](): Promise<void> {
    await this.ctx.mysql.connection(initializeSchema)
    this.ctx.effect(() => this.ctx.conversationPersistence.registerRecordPreparer(request =>
      this.prepareRecord(request.conversation, request.draft)), 'conversationFiles.toolResultPreparer')
  }

  /**
   * Publish bytes before starting the metadata transaction, then associate the
   * ready object with an owner-locked conversation. A database failure can
   * leave an unreachable immutable object; this method never deletes it.
   * @param request - complete bytes, owner, file identity, and optional message identity.
   * @returns committed owner-scoped metadata.
   */
  async publish(request: ConversationFilePublishRequest): Promise<ConversationFile> {
    validateMetadata(request)
    const object = await this.ctx.fileStorage.put({ content: request.content }, request.signal)
    return this.mysql(async (connection) => {
      await connection.beginTransaction()
      try {
        await this.requireConversation(connection, request)
        if (request.messageId !== undefined) await this.requireMessage(connection, request, request.messageId)
        const createdAt = timestamp(Date.now())
        await this.ensureObject(connection, request, object, createdAt)
        const file = await this.ensureFile(connection, request, object, createdAt)
        if (request.messageId !== undefined) {
          await this.ensureMessageLink(connection, request, request.messageId, createdAt)
        }
        await connection.commit()
        return file
      } catch (cause) {
        try {
          await connection.rollback()
        } catch (rollbackFailure) {
          throw unavailable(new AggregateError([cause, rollbackFailure], 'metadata transaction and rollback failed'))
        }
        throw cause
      }
    })
  }

  /**
   * Read one file only through its complete owner and conversation identity.
   * @param identity - owner-scoped file identity.
   * @returns metadata or undefined.
   */
  async get(identity: ConversationFileIdentity): Promise<ConversationFile | undefined> {
    return this.mysql(async (connection) => {
      const [rows] = await connection.execute<FileRow[]>(
        `SELECT ${FILE_COLUMNS} FROM dsh_conversation_files cf
         JOIN dsh_file_objects fo ON fo.tenant_id = cf.tenant_id AND fo.user_id = cf.user_id AND fo.object_id = cf.object_id
         WHERE cf.tenant_id = ? AND cf.user_id = ? AND cf.conversation_id = ? AND cf.file_id = ?`,
        [identity.tenantId, identity.userId, identity.conversationId, identity.fileId],
      )
      return rows[0] === undefined ? undefined : fromRow(rows[0])
    })
  }

  /**
   * Resolve metadata and open ready bytes without exposing a storage path or bearer URL.
   * @param identity - owner-scoped file identity.
   * @returns metadata and verified content stream.
   */
  async open(identity: ConversationFileIdentity): Promise<OpenConversationFile> {
    const file = await this.get(identity)
    if (file === undefined) throw new ConversationFileError('file-not-found', 'conversation-files-mysql: file was not found')
    return { file, content: await this.ctx.fileStorage.open(file.object) }
  }

  /** List files for exactly one owner-scoped conversation. @param query - bounded file-id keyset query. @returns stable page. */
  async list(query: ConversationFileListQuery): Promise<ConversationFilePage> {
    return this.listCore(query)
  }

  /**
   * List files linked to exactly one owner-scoped message.
   * @param query - bounded message and file-id keyset query.
   * @returns stable page.
   */
  async listMessageFiles(query: ConversationMessageFileListQuery): Promise<ConversationFilePage> {
    return this.listCore(query, query.messageId)
  }

  private async prepareRecord(
    conversation: ConversationIdentity,
    draft: ConversationRecordDraft,
  ): Promise<ConversationRecordDraft | undefined> {
    if (draft.type !== 'tool/result' || draft.payload.result === undefined) return undefined
    const json = JSON.stringify(draft.payload.result)
    const bytes = Buffer.from(json, 'utf8')
    if (bytes.byteLength <= this.threshold) return undefined
    const fileId = toolResultFileId(String(draft.recordId))
    await this.publish({
      ...conversation,
      fileId,
      content: oneChunk(bytes),
      mediaType: 'application/json',
    })
    return {
      ...draft,
      payload: {
        toolCallId: draft.payload.toolCallId,
        outcome: draft.payload.outcome,
        resultFileId: fileId,
      },
    }
  }

  private async listCore(
    query: ConversationFileListQuery,
    messageId?: MessageId,
  ): Promise<ConversationFilePage> {
    const limit = pageLimit(query.limit)
    return this.mysql(async (connection) => {
      const values: SqlValue[] = [query.tenantId, query.userId, query.conversationId]
      let join = ''
      let predicate = ''
      if (messageId !== undefined) {
        join = `JOIN dsh_conversation_message_files mf
          ON mf.tenant_id = cf.tenant_id AND mf.user_id = cf.user_id
          AND mf.conversation_id = cf.conversation_id AND mf.file_id = cf.file_id`
        predicate += ' AND mf.message_id = ?'
        values.push(messageId)
      }
      if (query.cursor !== undefined) {
        predicate += ' AND cf.file_id > ?'
        values.push(String(query.cursor))
      }
      const [rows] = await connection.execute<FileRow[]>(
        `SELECT ${FILE_COLUMNS} FROM dsh_conversation_files cf ${join}
         JOIN dsh_file_objects fo ON fo.tenant_id = cf.tenant_id AND fo.user_id = cf.user_id AND fo.object_id = cf.object_id
         WHERE cf.tenant_id = ? AND cf.user_id = ? AND cf.conversation_id = ?${predicate}
         ORDER BY cf.file_id ASC LIMIT ${String(limit + 1)}`, values,
      )
      const hasMore = rows.length > limit
      const files = rows.slice(0, limit).map(fromRow)
      const last = files.at(-1)
      return {
        files,
        ...hasMore && last !== undefined ? { nextCursor: conversationCursor(String(last.fileId)) } : {},
      }
    })
  }

  private async requireConversation(connection: MysqlConnection, identity: ConversationIdentity): Promise<void> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT conversation_id FROM dsh_conversations
       WHERE tenant_id = ? AND user_id = ? AND conversation_id = ? FOR UPDATE`,
      [identity.tenantId, identity.userId, identity.conversationId],
    )
    if (rows.length !== 1) {
      throw new ConversationFileError('conversation-not-found', 'conversation-files-mysql: conversation was not found')
    }
  }

  private async requireMessage(connection: MysqlConnection, identity: ConversationIdentity, messageId: MessageId): Promise<void> {
    const [rows] = await connection.execute<RowDataPacket[]>(
      `SELECT message_id FROM dsh_conversation_message_state
       WHERE tenant_id = ? AND user_id = ? AND conversation_id = ? AND message_id = ?`,
      [identity.tenantId, identity.userId, identity.conversationId, messageId],
    )
    if (rows.length !== 1) throw new ConversationFileError('message-not-found', 'conversation-files-mysql: message was not found')
  }

  private async ensureObject(
    connection: MysqlConnection,
    owner: ConversationIdentity,
    object: FileObjectRef,
    createdAt: string,
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO dsh_file_objects
        (tenant_id, user_id, object_id, storage_backend, storage_key, sha256, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE object_id = VALUES(object_id)`,
      [owner.tenantId, owner.userId, object.objectId, object.storageBackend, object.storageKey,
        object.sha256, object.byteSize, createdAt],
    )
    const [rows] = await connection.execute<ObjectRow[]>(
      `SELECT object_id, storage_backend, storage_key, sha256, byte_size FROM dsh_file_objects
       WHERE tenant_id = ? AND user_id = ? AND object_id = ? FOR UPDATE`,
      [owner.tenantId, owner.userId, object.objectId],
    )
    const row = rows[0]
    if (row === undefined || !sameObject(row, object)) {
      throw new ConversationFileError('file-conflict', 'conversation-files-mysql: object reference differs')
    }
  }

  private async ensureFile(
    connection: MysqlConnection,
    request: ConversationFilePublishRequest,
    object: FileObjectRef,
    createdAt: string,
  ): Promise<ConversationFile> {
    const [existing] = await connection.execute<FileRow[]>(
      `SELECT ${FILE_COLUMNS} FROM dsh_conversation_files cf
       JOIN dsh_file_objects fo ON fo.tenant_id = cf.tenant_id AND fo.user_id = cf.user_id AND fo.object_id = cf.object_id
       WHERE cf.tenant_id = ? AND cf.user_id = ? AND cf.conversation_id = ? AND cf.file_id = ? FOR UPDATE`,
      [request.tenantId, request.userId, request.conversationId, request.fileId],
    )
    if (existing[0] !== undefined) {
      const file = fromRow(existing[0])
      if (file.mediaType !== request.mediaType || file.fileName !== request.fileName || !sameRef(file.object, object)) {
        throw new ConversationFileError('file-conflict', 'conversation-files-mysql: file identity already names different metadata')
      }
      return file
    }
    await connection.execute(
      `INSERT INTO dsh_conversation_files
        (tenant_id, user_id, conversation_id, file_id, object_id, media_type, file_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [request.tenantId, request.userId, request.conversationId, request.fileId, object.objectId,
        request.mediaType, request.fileName ?? null, createdAt],
    )
    return {
      tenantId: request.tenantId,
      userId: request.userId,
      conversationId: request.conversationId,
      fileId: request.fileId,
      object,
      mediaType: request.mediaType,
      ...request.fileName === undefined ? {} : { fileName: request.fileName },
      createdAt: Date.parse(createdAt),
    }
  }

  private async ensureMessageLink(
    connection: MysqlConnection,
    request: ConversationFilePublishRequest,
    messageId: MessageId,
    createdAt: string,
  ): Promise<void> {
    await connection.execute(
      `INSERT INTO dsh_conversation_message_files
        (tenant_id, user_id, conversation_id, message_id, file_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE file_id = VALUES(file_id)`,
      [request.tenantId, request.userId, request.conversationId, messageId, request.fileId, createdAt],
    )
  }

  private async mysql<T>(callback: (connection: MysqlConnection) => Promise<T>): Promise<T> {
    try {
      return await this.ctx.mysql.connection(callback)
    } catch (cause) {
      if (cause instanceof ConversationFileError) throw cause
      throw unavailable(cause)
    }
  }
}

function fromRow(row: FileRow): ConversationFile {
  return {
    tenantId: row.tenant_id as ConversationFile['tenantId'],
    userId: row.user_id as ConversationFile['userId'],
    conversationId: row.conversation_id as ConversationFile['conversationId'],
    fileId: conversationFileId(row.file_id),
    object: {
      objectId: FileObjectId(row.object_id),
      storageBackend: FileStorageBackend(row.storage_backend),
      storageKey: FileStorageKey(row.storage_key),
      sha256: FileObjectSha256(row.sha256),
      byteSize: safeByteSize(row.byte_size),
    },
    mediaType: row.media_type,
    ...row.file_name === null ? {} : { fileName: row.file_name },
    createdAt: parseTimestamp(row.created_at),
  }
}

function sameObject(row: ObjectRow, object: FileObjectRef): boolean {
  return row.object_id === object.objectId
    && row.storage_backend === object.storageBackend
    && row.storage_key === object.storageKey
    && row.sha256 === object.sha256
    && safeByteSize(row.byte_size) === object.byteSize
}

function sameRef(left: FileObjectRef, right: FileObjectRef): boolean {
  return left.objectId === right.objectId
    && left.storageBackend === right.storageBackend
    && left.storageKey === right.storageKey
    && left.sha256 === right.sha256
    && left.byteSize === right.byteSize
}

function validateMetadata(request: ConversationFilePublishRequest): void {
  if (request.mediaType.length === 0 || request.mediaType.length > 256 || !/^[\x21-\x7e]+$/.test(request.mediaType)) {
    throw new ConversationFileError('invalid-input', 'conversation-files-mysql: mediaType must be 1-256 visible ASCII characters')
  }
  if (request.fileName !== undefined && (request.fileName.length === 0 || request.fileName.length > 512)) {
    throw new ConversationFileError('invalid-input', 'conversation-files-mysql: fileName must be 1-512 characters')
  }
}

function pageLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_PAGE_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new ConversationFileError('invalid-input', `conversation-files-mysql: limit must be between 1 and ${String(MAX_PAGE_LIMIT)}`)
  }
  return limit
}

function toolResultFileId(recordId: string): ConversationFileId {
  const digest = createHash('sha256').update(recordId, 'utf8').digest('hex')
  return conversationFileId(`tool-result~${digest}`)
}

// oxlint-disable-next-line typescript/require-await -- AsyncIterable consumers require an asynchronous iterator.
async function * oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes
}

function timestamp(value: number): string {
  const result = new Date(value).toISOString()
  if (result.length !== 24) throw new ConversationFileError('invalid-input', 'conversation-files-mysql: timestamp is invalid')
  return result
}

function parseTimestamp(value: string): number {
  const result = Date.parse(value)
  if (!Number.isFinite(result) || new Date(result).toISOString() !== value) throw unavailable('invalid stored timestamp')
  return result
}

function safeByteSize(value: number | string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw unavailable('invalid stored byte size')
  return result
}

function unavailable(cause: unknown): ConversationFileError {
  return new ConversationFileError('provider-unavailable', 'conversation-files-mysql: storage operation failed', { cause })
}

export default ConversationFilesMysql
