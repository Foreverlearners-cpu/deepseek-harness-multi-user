/** User identity Service Definition for tenant runtimes. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable user identifier. Authentication providers map external identities to this id. */
export type UserId = Branded<'UserId'>

/** Brand a validated user identifier.
 * @param value Candidate stable user identifier.
 * @returns The validated value with the {@link UserId} brand.
 */
export function UserId(value: string): UserId {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new TypeError('userId must contain 1-128 ASCII identifier characters')
  }
  return value as UserId
}

/** Durable user lifecycle state. Disabled users retain their data but cannot start new work. */
export type UserStatus = 'active' | 'disabled' | 'deleted'

/** User record returned by the user service. */
export interface User {
  readonly id: UserId
  readonly displayName?: string
  readonly status: UserStatus
  readonly createdAt: number
  readonly updatedAt: number
  readonly revision: number
}

/** Input for creating one user inside the configured tenant runtime. */
export interface CreateUserInput {
  readonly id: UserId
  readonly displayName?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    users: UserService
  }
}

/** User identity storage seam. Providers own the durable user records. */
export abstract class UserService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'users')
  }

  /**
   * Create an active user; duplicate ids must reject.
   * @param input User identity and optional display name.
   * @returns The committed user record.
   */
  abstract create(input: CreateUserInput): Promise<User>

  /**
   * Read one user, returning undefined when it is absent from this tenant.
   * @param id User identifier.
   * @returns The user record, or undefined when absent.
   */
  abstract get(id: UserId): Promise<User | undefined>

  /**
   * Read one active user or reject with a not-found/disabled error.
   * @param id User identifier.
   * @returns The active user record.
   */
  abstract requireActive(id: UserId): Promise<User>

  /**
   * Disable a user without deleting owned data.
   * @param id User identifier.
   */
  abstract disable(id: UserId): Promise<void>

  /**
   * List users visible to this configured tenant runtime.
   * @returns Visible user records.
   */
  abstract list(): Promise<User[]>
}

export default UserService
