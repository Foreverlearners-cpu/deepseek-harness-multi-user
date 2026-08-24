import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { UserDirectoryError, userId } from '@deepseek-ai/dsh-user'
import UserMysqlDirectory, { USER_MYSQL_SCHEMA_VERSION } from '../src/index.ts'
import { decodeCursor, encodeCursor } from '../src/cursor.ts'
import { FakeMysql } from './fake-mysql.ts'

let sequence = 0
vi.mock('node:crypto', () => ({ randomUUID: () => `user-${String(++sequence)}` }))

const contexts: Context[] = []

beforeEach(() => {
  sequence = 0
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async context => context.fiber.dispose()))
})

async function setup(mysql = new FakeMysql()): Promise<{
  ctx: Context
  mysql: FakeMysql
  users: UserMysqlDirectory
}> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('mysql', mysql.asService())
  await ctx.plugin(UserMysqlDirectory)
  return { ctx, mysql, users: ctx.users as UserMysqlDirectory }
}

describe('UserMysqlDirectory', () => {
  it('initializes the current schema and rejects an incompatible version', async () => {
    expect(USER_MYSQL_SCHEMA_VERSION).toBe(1)
    const initialized = new FakeMysql()
    await setup(initialized)
    expect(initialized.schemaVersion).toBe(1)
    expect(initialized.userTableExists).toBe(true)
    expect(initialized.queries).toContainEqual(expect.stringContaining(
      'display_name VARCHAR(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
    ))

    const existing = new FakeMysql()
    existing.schemaVersion = USER_MYSQL_SCHEMA_VERSION
    existing.userTableExists = true
    await expect(setup(existing)).resolves.toMatchObject({ mysql: existing })

    const mysql = new FakeMysql()
    mysql.schemaVersion = 2

    await expect(setup(mysql)).rejects.toThrow(/incompatible schema version/)
  })

  it('rejects unversioned or incomplete existing schema state', async () => {
    const unversioned = new FakeMysql()
    unversioned.userTableExists = true
    await expect(setup(unversioned)).rejects.toThrow(/unversioned dsh_users table/)

    const missing = new FakeMysql()
    missing.schemaVersion = USER_MYSQL_SCHEMA_VERSION
    await expect(setup(missing)).rejects.toThrow(/versioned user table is missing/)
  })

  it('binds keyset cursors to their status filter', () => {
    const cursor = encodeCursor(userId('user-4'), 'active')
    expect(decodeCursor(cursor, 'active')).toBe('user-4')
    expect(() => decodeCursor(cursor, 'disabled')).toThrow(/invalid or mismatched/)
    expect(() => decodeCursor('not-json', undefined)).toThrow(/invalid or mismatched/)
    const unfiltered = encodeCursor(userId('user-5'), undefined)
    expect(decodeCursor(unfiltered, undefined)).toBe('user-5')
    const wrongVersion = Buffer.from(JSON.stringify({ v: 2, after: 'user-5', status: null })).toString('base64url')
    expect(() => decodeCursor(wrongVersion, undefined)).toThrow(/invalid or mismatched/)
    for (const invalid of [null, [], 'scalar', { v: 1, after: 4, status: null }]) {
      const encoded = Buffer.from(JSON.stringify(invalid)).toString('base64url')
      expect(() => decodeCursor(encoded, undefined)).toThrow(/invalid or mismatched/)
    }
  })

  it('reports malformed and filter-mismatched cursors as invalid input', async () => {
    const { users } = await setup()
    const cursor = encodeCursor(userId('user-4'), 'active')

    await expect(users.list({ status: 'disabled', cursor })).rejects.toMatchObject({ code: 'invalid-input' })
    await expect(users.list({ cursor: 'not-json' })).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('maps driver failures without exposing SQL diagnostics', async () => {
    const { mysql, users } = await setup()
    mysql.failNext = new Error('password=secret SELECT * FROM dsh_users')

    await expect(users.get(userId('user-1'))).rejects.toEqual(expect.objectContaining({
      code: 'provider-unavailable',
      message: 'user: directory Provider failed',
    }))
  })

  it('rolls back a failed mutation and preserves the committed record', async () => {
    const { mysql, users } = await setup()
    const created = await users.create({ displayName: 'Before' })
    mysql.failNext = new Error('update unavailable')

    await expect(users.update({
      userId: created.userId,
      expectedRevision: created.revision,
      patch: { displayName: 'After' },
    })).rejects.toBeInstanceOf(UserDirectoryError)
    expect(await users.get(created.userId)).toEqual(created)
  })

  it('maps rollback failure to unavailable instead of retaining an expected conflict', async () => {
    const { mysql, users } = await setup()
    const created = await users.create()
    mysql.rollbackFailure = new Error('connection lost during rollback')

    await expect(users.update({
      userId: created.userId,
      expectedRevision: created.revision + 1,
      patch: { displayName: 'Stale' },
    })).rejects.toMatchObject({ code: 'provider-unavailable', message: 'user-mysql: transaction rollback failed' })
  })

  it('decodes driver JSON strings and BIGINT strings', async () => {
    const { mysql, users } = await setup()
    mysql.rows.set('user-1', {
      user_id: 'user-1',
      display_name: 'Stored',
      status: 'active',
      created_at: 1,
      updated_at: 2,
      revision: 3,
      extensions: JSON.stringify({ 'example/source': 'driver-string' }),
    })
    const row = mysql.rows.get('user-1')!
    row.created_at = '1'
    row.updated_at = '2'
    row.revision = '3'

    await expect(users.get(userId('user-1'))).resolves.toMatchObject({
      createdAt: 1,
      updatedAt: 2,
      revision: 3,
      extensions: { 'example/source': 'driver-string' },
    })
  })

  it('rejects malformed database numerics as unavailable Provider state', async () => {
    const { mysql, users } = await setup()
    mysql.rows.set('user-1', {
      user_id: 'user-1',
      display_name: null,
      status: 'active',
      created_at: 1,
      updated_at: 1,
      revision: Number.MAX_SAFE_INTEGER + 1,
      extensions: {},
    })

    await expect(users.get(userId('user-1'))).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('handles delete from disabled and a filtered keyset continuation', async () => {
    const { users } = await setup()
    const first = await users.create()
    const second = await users.create()
    const third = await users.create()
    const disabled = await users.disable({ userId: first.userId, expectedRevision: first.revision })
    await expect(users.delete({ userId: disabled.userId, expectedRevision: disabled.revision }))
      .resolves.toMatchObject({ status: 'deleted' })

    const page = await users.list({ status: 'active', limit: 1 })
    expect(page.users.map(user => user.userId)).toEqual([second.userId])
    await expect(users.list({ status: 'active', limit: 1, cursor: page.nextCursor! }))
      .resolves.toMatchObject({ users: [expect.objectContaining({ userId: third.userId })] })
  })

  it('rejects impossible update counts and missing post-update rows as unavailable', async () => {
    const { mysql, users } = await setup()
    const created = await users.create()
    mysql.zeroNextUpdate = true
    await expect(users.update({
      userId: created.userId,
      expectedRevision: created.revision,
      patch: { displayName: 'No row' },
    })).rejects.toMatchObject({ code: 'provider-unavailable' })

    mysql.hideNextPostUpdate = true
    await expect(users.update({
      userId: created.userId,
      expectedRevision: created.revision,
      patch: { displayName: 'Disappeared' },
    })).rejects.toMatchObject({ code: 'provider-unavailable' })
  })

  it('reports a mutation of a missing user as not found', async () => {
    const { users } = await setup()
    await expect(users.disable({ userId: userId('missing'), expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'user-not-found' })
  })
})
