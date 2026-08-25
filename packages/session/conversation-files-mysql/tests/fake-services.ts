import type { Context } from '@deepseek-ai/cordis'
import {
  FileObjectId,
  FileObjectSha256,
  FileStorageBackend,
  FileStorageKey,
  type FileObjectRef,
  type FileStorage,
} from '@deepseek-ai/dsh-file-storage'
import type { Mysql, MysqlConnection } from '@deepseek-ai/dsh-mysql'
import type {
  ConversationRecordPreparer,
  ConversationPersistence,
} from '@deepseek-ai/dsh-conversation-persistence'

const REF: FileObjectRef = {
  objectId: FileObjectId(`sha256:${'a'.repeat(64)}`),
  storageBackend: FileStorageBackend('fake'),
  storageKey: FileStorageKey('objects/fake'),
  sha256: FileObjectSha256('a'.repeat(64)),
  byteSize: 11,
}

/** Minimal immutable store that records publication ordering. */
export class FakeFileStorage {
  readonly order: string[]
  puts = 0

  constructor(order: string[]) {
    this.order = order
  }

  readonly put = async (): Promise<FileObjectRef> => {
    this.puts += 1
    this.order.push('put')
    return REF
  }

  asService(): FileStorage {
    return this as unknown as FileStorage
  }
}

/** Captures the plugin's ordered record preparer contribution. */
export class FakeConversationPersistence {
  preparer?: ConversationRecordPreparer

  readonly registerRecordPreparer = (preparer: ConversationRecordPreparer): (() => void) => {
    this.preparer = preparer
    return () => { delete this.preparer }
  }

  asService(): ConversationPersistence {
    return this as unknown as ConversationPersistence
  }
}

/** Scripted metadata database for ordering, rollback, and preparer tests. */
export class FakeFilesMysql {
  readonly order: string[]
  failFileInsert = false
  begins = 0
  commits = 0
  rollbacks = 0

  constructor(order: string[]) {
    this.order = order
  }

  readonly connection = async <T>(callback: (connection: MysqlConnection) => T | Promise<T>): Promise<T> =>
    callback(this.driver())

  asService(): Mysql {
    return this as unknown as Mysql
  }

  private driver(): MysqlConnection {
    const query = async (sql: string): Promise<unknown> => {
      const normalized = sql.replaceAll(/\s+/g, ' ').trim()
      if (normalized.startsWith('SELECT GET_LOCK')) return [[{ acquired: 1 }], []]
      if (normalized.startsWith('SELECT RELEASE_LOCK')) return [[{ released: 1 }], []]
      if (normalized.startsWith('CREATE TABLE IF NOT EXISTS dsh_conversation_files_schema')) return [{ affectedRows: 0 }, []]
      if (normalized.startsWith('SELECT version FROM dsh_conversation_files_schema')) return [[{ version: 1 }], []]
      if (normalized.startsWith('SELECT TABLE_NAME AS table_name')) {
        return [[
          { table_name: 'dsh_file_objects' },
          { table_name: 'dsh_conversation_files' },
          { table_name: 'dsh_conversation_message_files' },
        ], []]
      }
      if (normalized.startsWith('SELECT conversation_id FROM dsh_conversations')) return [[{ conversation_id: 'conversation' }], []]
      if (normalized.startsWith('INSERT INTO dsh_file_objects')) return [{ affectedRows: 1 }, []]
      if (normalized.startsWith('SELECT object_id, storage_backend')) {
        return [[{
          object_id: REF.objectId,
          storage_backend: REF.storageBackend,
          storage_key: REF.storageKey,
          sha256: REF.sha256,
          byte_size: REF.byteSize,
        }], []]
      }
      if (normalized.includes('FROM dsh_conversation_files cf') && normalized.endsWith('FOR UPDATE')) return [[], []]
      if (normalized.startsWith('INSERT INTO dsh_conversation_files')) {
        if (this.failFileInsert) throw new Error('metadata insert failed')
        return [{ affectedRows: 1 }, []]
      }
      throw new Error(`unexpected SQL: ${normalized}`)
    }
    return {
      query,
      execute: query,
      beginTransaction: async () => {
        this.begins += 1
        this.order.push('begin')
      },
      commit: async () => { this.commits += 1 },
      rollback: async () => { this.rollbacks += 1 },
    } as unknown as MysqlConnection
  }
}

/** Install the three required services without widening production dependencies. */
export function provideFakes(
  ctx: Context,
  mysql: FakeFilesMysql,
  storage: FakeFileStorage,
  persistence: FakeConversationPersistence,
): void {
  ctx.provide('mysql', mysql.asService())
  ctx.provide('fileStorage', storage.asService())
  ctx.provide('conversationPersistence', persistence.asService())
}
