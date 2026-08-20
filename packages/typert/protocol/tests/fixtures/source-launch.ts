import { Context } from '@deepseek-ai/cordis'
import {
  TypertRemoteService,
  Remote,
  RemoteScope,
  remoteMethods,
} from '@deepseek-ai/dsh-typert-protocol'

class Goals extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  @Remote({ access: 'authenticated' })
  create(value: string): string {
    return value
  }

  @RemoteScope('agent', { access: 'authenticated' })
  scoped(value: string): string {
    return value
  }
}

const methods = remoteMethods(new Goals(new Context()))
const actual = JSON.stringify(methods)
const expected = JSON.stringify([
  { method: 'create', invocation: { kind: 'direct' }, access: 'authenticated' },
  { method: 'scoped', invocation: { kind: 'context', context: 'agent' }, access: 'authenticated' },
])
if (actual !== expected) throw new Error(`unexpected Remote declarations: ${actual}`)
process.stdout.write(actual)
