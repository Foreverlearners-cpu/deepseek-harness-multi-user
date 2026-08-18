import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { escapeId } from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2/promise'
import Mysql from '../src/index.ts'
import type { Config } from '../src/index.ts'

interface ValueRow extends RowDataPacket {
  value: number
}

interface ConnectionStateRow extends RowDataPacket {
  connectionId: number
  databaseName: string
  marker: number | null
}

interface CountRow extends RowDataPacket {
  rowCount: number
}

const target = process.env.DSH_MYSQL_TEST_URL
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

function targetConfig(): Config {
  const url = new URL(target!)
  if (url.protocol !== 'mysql:') throw new Error('DSH_MYSQL_TEST_URL must use the mysql: scheme')
  const database = decodeURIComponent(url.pathname.slice(1))
  if (database.length === 0) throw new Error('DSH_MYSQL_TEST_URL must name a database')
  return {
    host: url.hostname,
    ...(url.port === '' ? {} : { port: Number(url.port) }),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    connectionLimit: 1,
  }
}

async function bootTarget(): Promise<Context> {
  ctx = new Context()
  await ctx.plugin(Mysql, targetConfig())
  return ctx
}

describe.skipIf(target === undefined)('real MySQL connection', () => {
  it('boots the service and leases a working connection', async () => {
    const targetContext = await bootTarget()

    const value = await targetContext.mysql.connection(async (connection) => {
      const [rows] = await connection.query<ValueRow[]>('SELECT 1 AS value')
      return rows[0]?.value
    })
    expect(value).toBe(1)
  })

  it('resets transaction, variable, and selected-database state between leases', async () => {
    const config = targetConfig()
    const targetContext = await bootTarget()
    const probeTable = escapeId(`${config.database}.dsh_mysql_reset_probe`)
    await targetContext.mysql.connection(async (connection) => {
      await connection.query(`DROP TABLE IF EXISTS ${probeTable}`)
      await connection.query(`CREATE TABLE ${probeTable} (value INT NOT NULL)`)
    })

    try {
      let firstConnectionId: number | undefined
      const callbackError = new Error('reject after contaminating the session')
      await expect(targetContext.mysql.connection(async (connection) => {
        const [rows] = await connection.query<ConnectionStateRow[]>(
          'SELECT CONNECTION_ID() AS connectionId, DATABASE() AS databaseName, @dsh_mysql_marker AS marker',
        )
        firstConnectionId = rows[0]?.connectionId
        await connection.beginTransaction()
        await connection.query(`INSERT INTO ${probeTable} (value) VALUES (1)`)
        await connection.query('SET @dsh_mysql_marker = 1234')
        await connection.query('USE information_schema')
        throw callbackError
      })).rejects.toBe(callbackError)

      await targetContext.mysql.connection(async (connection) => {
        const [states] = await connection.query<ConnectionStateRow[]>(
          'SELECT CONNECTION_ID() AS connectionId, DATABASE() AS databaseName, @dsh_mysql_marker AS marker',
        )
        const [counts] = await connection.query<CountRow[]>(`SELECT COUNT(*) AS rowCount FROM ${probeTable}`)
        expect(states[0]?.connectionId).toBe(firstConnectionId)
        expect(states[0]?.databaseName).toBe(config.database)
        expect(states[0]?.marker).toBeNull()
        expect(Number(counts[0]?.rowCount)).toBe(0)
      })
    } finally {
      await targetContext.mysql.connection(async (connection) => {
        await connection.query(`DROP TABLE IF EXISTS ${probeTable}`)
      })
    }
  })

  it('drains a queued lease during disposal and rejects later admission', async () => {
    const targetContext = await bootTarget()
    const service = targetContext.mysql
    const firstEntered = Promise.withResolvers<undefined>()
    const releaseFirst = Promise.withResolvers<undefined>()
    const queuedEntered = Promise.withResolvers<undefined>()
    const first = service.connection(async () => {
      firstEntered.resolve(undefined)
      await releaseFirst.promise
      return 'first'
    })
    await firstEntered.promise
    const queued = service.connection(() => {
      queuedEntered.resolve(undefined)
      return 'queued'
    })

    const disposing = targetContext.fiber.dispose()
    await Promise.resolve()
    await expect(service.connection(() => 'late')).rejects.toThrow(/closing or closed/)
    releaseFirst.resolve(undefined)
    await expect(first).resolves.toBe('first')
    await queuedEntered.promise
    await expect(queued).resolves.toBe('queued')
    await disposing
    await expect(service.connection(() => 'late')).rejects.toThrow(/closing or closed/)
  })
})
