import type { Mysql, MysqlConnection } from '@deepseek-ai/dsh-mysql'

const CREATED = '2026-08-25T00:00:00.000Z'

/** Scripted MySQL service for transaction and batching tests. */
export class FakeConversationMysql {
  readonly queries: string[] = []
  begins = 0
  commits = 0
  rollbacks = 0
  failRecordInsert = 0
  private recordInserts = 0

  readonly connection = async <T>(callback: (connection: MysqlConnection) => T | Promise<T>): Promise<T> =>
    callback(this.driver())

  asService(): Mysql {
    return this as unknown as Mysql
  }

  private driver(): MysqlConnection {
    const query = async (sql: string): Promise<unknown> => {
      const normalized = sql.replaceAll(/\s+/g, ' ').trim()
      this.queries.push(normalized)
      if (normalized.startsWith('SELECT GET_LOCK')) return [[{ acquired: 1 }], []]
      if (normalized.startsWith('SELECT RELEASE_LOCK')) return [[{ released: 1 }], []]
      if (normalized.startsWith('CREATE TABLE IF NOT EXISTS dsh_conversation_schema')) return [{ affectedRows: 0 }, []]
      if (normalized.startsWith('SELECT version FROM dsh_conversation_schema')) return [[{ version: 1 }], []]
      if (normalized.startsWith('SELECT TABLE_NAME AS table_name')) {
        return [[
          { table_name: 'dsh_conversations' },
          { table_name: 'dsh_agent_records' },
          { table_name: 'dsh_conversation_messages' },
          { table_name: 'dsh_conversation_message_state' },
          { table_name: 'dsh_subagent_runs' },
        ], []]
      }
      if (normalized.includes('FROM dsh_conversations') && normalized.endsWith('FOR UPDATE')) {
        return [[{
          tenant_id: 'fake-tenant',
          user_id: 'fake-user',
          conversation_id: 'fake-conversation',
          session_id: 'fake-session',
          parent_conversation_id: null,
          origin: 'top-level',
          delegation_depth: 0,
          title: null,
          status: 'active',
          revision: 1,
          next_sequence: 1,
          retention: { kind: 'permanent' },
          created_at: CREATED,
          updated_at: CREATED,
          extensions: {},
        }], []]
      }
      if (normalized.startsWith('SELECT sequence, source_seq')) return [[], []]
      if (normalized.startsWith('INSERT INTO dsh_agent_records')) {
        this.recordInserts += 1
        if (this.recordInserts === this.failRecordInsert) throw new Error('record insert failed')
        return [{ affectedRows: 1 }, []]
      }
      if (normalized.startsWith('UPDATE dsh_conversations')) return [{ affectedRows: 1 }, []]
      throw new Error(`unexpected SQL: ${normalized}`)
    }
    return {
      query,
      execute: query,
      beginTransaction: async () => { this.begins += 1 },
      commit: async () => { this.commits += 1 },
      rollback: async () => { this.rollbacks += 1 },
    } as unknown as MysqlConnection
  }
}
