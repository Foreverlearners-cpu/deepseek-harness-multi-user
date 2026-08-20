import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  bindTypertRemote,
  TypertRemoteService,
  Remote,
  RemoteScope,
  remoteMethods,
  type TypertContext,
  type TypertForwardableEvent,
  type TypertRemoteEvent,
} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Test-only one-way event: bound to no Scope and returning nothing.
     * @param value - marker payload.
     */
    'meta-fixture/forwardable'(value: string): void
    /**
     * Test-only Scope-bound event, which no carrier can deliver one-way.
     * @param value - marker payload.
     */
    'meta-fixture/scoped'(this: Context, value: string): void
    /**
     * Test-only answered event, whose result no one-way delivery can return.
     * @param value - marker payload.
     * @returns the replacement value.
     */
    'meta-fixture/answered'(value: string): string
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertContextMap {
    metaFixture: TypertContext<string>
  }

  interface TypertRemoteEventSelection extends
    Record<'meta-fixture/forwardable' | 'meta-fixture/absent', true> {}
}

describe('typert-protocol Remote declarations', () => {
  it('binds a TypertRemoteService name and executes decorators through the Vitest source transform', async () => {
    class Goals extends TypertRemoteService {
      constructor(ctx: Context) {
        super(ctx, 'goals')
      }

      @Remote({ access: 'authenticated' })
      create(value: string): string {
        return value
      }

      @RemoteScope('metaFixture', { access: 'authenticated' })
      scoped(value: string): string {
        return value
      }
    }

    class NamespacedGoals extends TypertRemoteService {
      constructor(ctx: Context) {
        super(ctx, 'internalGoals', { namespace: 'goals' })
      }
    }

    const ctx = new Context()
    const goals = new Goals(ctx)
    const namespaced = new NamespacedGoals(ctx)
    expect(goals.typertRemote).toEqual({ service: goals, serviceKey: 'goals', namespace: 'goals' })
    expect(namespaced.typertRemote).toEqual({
      service: namespaced,
      serviceKey: 'internalGoals',
      namespace: 'goals',
    })
    expect(remoteMethods(goals)).toEqual([
      { method: 'create', invocation: { kind: 'direct' }, access: 'authenticated' },
      { method: 'scoped', invocation: { kind: 'context', context: 'metaFixture' }, access: 'authenticated' },
    ])
    await ctx.fiber.dispose()
  })

  it('reads live method identities through Cordis Service proxies', async () => {
    class Goals extends TypertRemoteService {
      constructor(ctx: Context) {
        super(ctx, 'proxyGoals')
      }

      @Remote({ access: 'authenticated' })
      create(value: string): string {
        return value
      }
    }

    const ctx = new Context()
    const fiber = ctx.plugin(Goals)
    await fiber
    const goals = ctx.get('proxyGoals') as unknown as object
    expect(remoteMethods(goals)).toEqual([{
      method: 'create',
      invocation: { kind: 'direct' },
      access: 'authenticated',
    }])
    await fiber.dispose()
  })

  it('executes standard decorator syntax through the TSX source launcher', () => {
    const fixture = fileURLToPath(new URL('./fixtures/source-launch.ts', import.meta.url))
    const output = execFileSync(process.execPath, ['--import', 'tsx/esm', fixture], { encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual([
      { method: 'create', invocation: { kind: 'direct' }, access: 'authenticated' },
      { method: 'scoped', invocation: { kind: 'context', context: 'agent' }, access: 'authenticated' },
    ])
  })

  it('keeps decorator markers in private module state', () => {
    class Goals {
      readonly typertRemote = bindTypertRemote(this, 'goals')

      create(agent: object, request: object): object {
        return { agent, request }
      }

      scoped(request: object): object {
        return request
      }
    }

    const initializers: Array<(this: Goals) => void> = []
    Remote({ access: 'authenticated' })(
      Reflect.get(Goals.prototype, 'create') as (this: Goals, ...args: unknown[]) => unknown,
      methodContext('create', initializers),
    )
    RemoteScope('metaFixture', { access: 'authenticated' })(
      Reflect.get(Goals.prototype, 'scoped') as (this: Goals, ...args: unknown[]) => unknown,
      methodContext('scoped', initializers),
    )

    const goals = new Goals()
    for (const initialize of initializers) initialize.call(goals)
    expect(goals.typertRemote).toEqual({ service: goals, serviceKey: 'goals', namespace: 'goals' })
    expect(Object.isFrozen(goals.typertRemote)).toBe(true)
    expect(remoteMethods(goals)).toEqual([
      { method: 'create', invocation: { kind: 'direct' }, access: 'authenticated' },
      { method: 'scoped', invocation: { kind: 'context', context: 'metaFixture' }, access: 'authenticated' },
    ])
    expect(Reflect.ownKeys(Goals)).toEqual(['length', 'name', 'prototype'])
    expect(Reflect.ownKeys(Goals.prototype)).toEqual(['constructor', 'create', 'scoped'])
  })

  it('keeps markers idempotent across instances and returns detached snapshots', () => {
    class Service {
      run(value: string): string {
        return value
      }
    }

    const initializers: Array<(this: Service) => void> = []
    Remote({ access: 'authenticated' })(
      Reflect.get(Service.prototype, 'run') as (this: Service, ...args: unknown[]) => unknown,
      methodContext('run', initializers),
    )

    const first = new Service()
    const second = new Service()
    for (const initialize of initializers) {
      initialize.call(first)
      initialize.call(second)
    }
    const snapshot = remoteMethods(first)
    expect(remoteMethods(second)).toEqual(snapshot)
    ;(snapshot as unknown as { method: string }[])[0]!.method = 'changed'
    expect(remoteMethods(first)).toEqual([{
      method: 'run',
      invocation: { kind: 'direct' },
      access: 'authenticated',
    }])
  })

  it('does not inherit a marker across an undecorated override or later method replacement', () => {
    class BaseService {
      @Remote({ permission: 'fixture:read' })
      run(call: unknown, value: string): string {
        void call
        return value
      }
    }

    class InheritedService extends BaseService {}

    class OverrideService extends BaseService {
      override run(call: unknown, value: string): string {
        void call
        return `override:${value}`
      }
    }

    class RedecoratedService extends BaseService {
      @Remote({ access: 'authenticated' })
      override run(call: unknown, value: string): string {
        void call
        return `redecorated:${value}`
      }
    }

    const inherited = new InheritedService()
    const overridden = new OverrideService()
    const redecorated = new RedecoratedService()
    expect(remoteMethods(inherited)).toMatchObject([{ method: 'run', access: 'permission' }])
    expect(remoteMethods(overridden)).toEqual([])
    expect(remoteMethods(redecorated)).toEqual([{
      method: 'run',
      invocation: { kind: 'direct' },
      access: 'authenticated',
    }])

    const implementation = Reflect.get(InheritedService.prototype, 'run') as unknown
    if (typeof implementation !== 'function') throw new Error('fixture method implementation is missing')
    InheritedService.prototype.run = function (_call: unknown, value: string): string {
      return `replaced:${value}`
    }
    try {
      expect(remoteMethods(inherited)).toEqual([])
    } finally {
      InheritedService.prototype.run = implementation as InheritedService['run']
    }
  })

  it('supports explicit export names without exposing marker storage', () => {
    class Service {
      run(value: string): string {
        return value
      }

      scoped(value: string): string {
        return value
      }
    }
    const initializers: Array<(this: Service) => void> = []
    Remote({ access: 'authenticated', exportName: 'execute' })(
      Reflect.get(Service.prototype, 'run') as (this: Service, ...args: unknown[]) => unknown,
      methodContext('run', initializers),
    )
    RemoteScope('metaFixture', { access: 'authenticated', exportName: 'inspect' })(
      Reflect.get(Service.prototype, 'scoped') as (this: Service, ...args: unknown[]) => unknown,
      methodContext('scoped', initializers),
    )
    const service = new Service()
    for (const initialize of initializers) initialize.call(service)

    expect(remoteMethods(service)).toEqual([
      { method: 'run', exportName: 'execute', invocation: { kind: 'direct' }, access: 'authenticated' },
      {
        method: 'scoped',
        exportName: 'inspect',
        invocation: { kind: 'context', context: 'metaFixture' },
        access: 'authenticated',
      },
    ])
    expect(remoteMethods({})).toEqual([])
    const prototypeLess: object = {}
    Reflect.setPrototypeOf(prototypeLess, null)
    expect(remoteMethods(prototypeLess)).toEqual([])
  })

  it('records protected Remote authorization without exposing the Host call parameter', () => {
    class Service {
      read(call: unknown, value: string): string {
        void call
        return value
      }
    }
    const initializers: Array<(this: Service) => void> = []
    Remote({ exportName: 'inspect', permission: 'fixture:read' })(
      Reflect.get(Service.prototype, 'read') as (this: Service, ...args: unknown[]) => unknown,
      methodContext('read', initializers),
    )
    const service = new Service()
    for (const initialize of initializers) initialize.call(service)

    expect(remoteMethods(service)).toEqual([{
      method: 'read',
      exportName: 'inspect',
      invocation: { kind: 'direct' },
      access: 'permission',
      authorization: { permission: 'fixture:read', callParameter: 'call' },
    }])
    expect(Object.isFrozen(remoteMethods(service)[0]?.authorization)).toBe(true)
  })

  it('rejects malformed decorator calls and targets', () => {
    const method: (this: object) => void = function (this: object): void {}
    const untypedRemote = Remote as unknown as (options: unknown) => unknown
    const untypedScope = RemoteScope as unknown as (key: string, options?: unknown) => unknown
    expect(() => untypedRemote(method)).toThrow('options must be an object')
    expect(() => Remote({ access: 'authenticated', exportName: 'bad/name' })).toThrow('export name')
    expect(() => Remote({ access: 'authenticated', exportName: 'bad#name' })).toThrow('export name')
    expect(() => Remote({ access: 'authenticated', exportName: 'bad name' })).toThrow('export name')
    expect(() => Remote({ access: 'authenticated', exportName: '.' })).toThrow('export name')
    expect(() => Remote({ access: 'authenticated', exportName: '..' })).toThrow('export name')
    expect(() => untypedScope('', { access: 'authenticated' })).toThrow('Scope key')
    expect(() => untypedScope('metaFixture')).toThrow('options must be an object')
    expect(() => RemoteScope('metaFixture', { access: 'authenticated', exportName: 'bad/name' })).toThrow('export name')
    expect(() => Remote({ permission: '' })).toThrow('permission must be a nonempty string')
    expect(() => Remote({ permission: 'fixture:read', extra: true } as unknown as { permission: string }))
      .toThrow('permission options support only exportName and permission')
    expect(() => untypedRemote({})).toThrow('require access "authenticated" or a nonempty permission')
    expect(() => untypedRemote({ access: 'permission' })).toThrow('require access "authenticated" or a nonempty permission')
    expect(() => untypedRemote({ access: 'authenticated', permission: 'fixture:read' }))
      .toThrow('permission options support only exportName and permission')

    for (const context of [
      { ...methodContext('run', []), private: true },
      { ...methodContext('run', []), static: true },
      { ...methodContext('run', []), name: Symbol('run') },
    ]) {
      expect(() => { Remote({ access: 'authenticated' })(method, context) })
        .toThrow('public instance method')
    }
  })

  it('reads options only from own data properties', () => {
    const untypedRemote = Remote as unknown as (options: unknown) => unknown
    const untypedScope = RemoteScope as unknown as (key: string, options: unknown) => unknown

    expect(() => untypedRemote(Object.create({ access: 'authenticated' })))
      .toThrow('own data properties')
    expect(() => untypedScope('metaFixture', Object.create({ permission: 'fixture:read' })))
      .toThrow('own data properties')

    const inheritedExportName = Object.create({ exportName: 'inspect' }) as Record<string, unknown>
    inheritedExportName.access = 'authenticated'
    expect(() => untypedRemote(inheritedExportName)).toThrow('own data properties')

    for (const name of ['access', 'exportName', 'permission']) {
      let reads = 0
      const options: Record<string, unknown> = name === 'access' ? {} : { access: 'authenticated' }
      Object.defineProperty(options, name, {
        enumerable: true,
        get: () => {
          reads += 1
          return name === 'permission' ? 'fixture:read' : 'authenticated'
        },
      })
      expect(() => untypedRemote(options)).toThrow('own data properties')
      expect(reads).toBe(0)
    }

    expect(() => untypedRemote({ access: 'authenticated', [Symbol('extra')]: true }))
      .toThrow('authenticated options support only access and exportName')

    const original = Object.getOwnPropertyDescriptor(Object.prototype, 'access')
    Object.defineProperty(Object.prototype, 'access', {
      configurable: true,
      get: () => { throw new Error('polluted access getter must not run') },
    })
    try {
      expect(() => untypedRemote({})).toThrow('own data properties')
      expect(() => untypedScope('metaFixture', {})).toThrow('own data properties')
    } finally {
      if (original === undefined) Reflect.deleteProperty(Object.prototype, 'access')
      else Object.defineProperty(Object.prototype, 'access', original)
    }
  })

  it('rejects prototype-less initialization and conflicting markers', () => {
    const method: (this: object) => void = function (this: object): void {}
    const direct: Array<(this: object) => void> = []
    Remote({ access: 'authenticated' })(method, methodContext('run', direct))
    const prototypeLess: object = {}
    Reflect.setPrototypeOf(prototypeLess, null)
    expect(() => { direct[0]!.call(prototypeLess) }).toThrow('without a prototype')

    class Service {
      run(): void {}
    }
    const conflicting: Array<(this: Service) => void> = []
    Remote({ access: 'authenticated' })(
      Reflect.get(Service.prototype, 'run'),
      methodContext('run', conflicting),
    )
    RemoteScope('metaFixture', { permission: 'fixture:read' })(
      Reflect.get(Service.prototype, 'run'),
      methodContext('run', conflicting),
    )
    const service = new Service()
    conflicting[0]!.call(service)
    expect(() => { conflicting[1]!.call(service) }).toThrow('conflicting invocation markers')
  })

  it('rejects ambiguous binding names', () => {
    expect(() => bindTypertRemote({}, '')).toThrow('service key')
    expect(() => bindTypertRemote({}, 'goals', { namespace: 'api/goals' })).toThrow('namespace')
    expect(() => bindTypertRemote({}, 'goals', { namespace: 'api goals' })).toThrow('namespace')
  })

  it('admits only one-way event shapes and only selected events that exist', () => {
    expectTypeOf<'meta-fixture/forwardable'>().toExtend<TypertForwardableEvent>()
    expectTypeOf<'meta-fixture/scoped'>().not.toExtend<TypertForwardableEvent>()
    expectTypeOf<'meta-fixture/answered'>().not.toExtend<TypertForwardableEvent>()

    expectTypeOf<'meta-fixture/forwardable'>().toExtend<TypertRemoteEvent>()
    expectTypeOf<'meta-fixture/scoped'>().not.toExtend<TypertRemoteEvent>()
    expectTypeOf<'meta-fixture/absent'>().not.toExtend<TypertRemoteEvent>()
  })
})

function methodContext<This extends object>(
  name: string,
  initializers: Array<(this: This) => void>,
): ClassMethodDecoratorContext<This, (this: This, ...args: unknown[]) => unknown> {
  return {
    kind: 'method',
    name,
    static: false,
    private: false,
    metadata: {},
    access: {
      has: object => name in object,
      get: object => (object as Record<string, unknown>)[name] as (this: This, ...args: unknown[]) => unknown,
    },
    addInitializer: (initializer) => { initializers.push(initializer) },
  }
}
