import { Service } from '@deepseek-ai/cordis'
import { AccountAdminAuthorizerRegistry } from '@deepseek-ai/dsh-account'

/** Host-only account-administration registry used by package tests. */
export class AccountAdministrationStub extends Service {
  /** Sole administrator authorization Provider registry. */
  readonly authorizers = new AccountAdminAuthorizerRegistry()

  /** @param ctx - owning Host context. */
  constructor(ctx: ConstructorParameters<typeof Service>[0]) {
    super(ctx, 'accountAdministration')
  }
}
