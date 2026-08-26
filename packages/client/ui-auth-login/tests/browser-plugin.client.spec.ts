import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { LoginOverlay } from '../src/client/LoginOverlay.tsx'
import { en, NS, zh } from '../src/client/locales.ts'
import { apply as applyNode } from '../src/index.ts'
import * as LoginInvariant from '../src/invariant.ts'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  return { ctx, slots: ctx.get('slots') as SlotRegistry }
}

function declareOverlay(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'shell.overlay': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-auth-login browser half', () => {
  it('declares its service dependencies', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers before or after the overlay declaration and unwinds with its fiber', async () => {
    const before = await bench()
    declareOverlay(before.slots)
    const beforeFiber = before.ctx.plugin({ inject: [...inject], apply })
    await beforeFiber.await()
    expect(before.slots.entries('shell.overlay')[0]).toMatchObject({ component: LoginOverlay, locale: NS })
    await beforeFiber.dispose()
    expect(before.slots.entries('shell.overlay')).toHaveLength(0)

    const after = await bench()
    const afterFiber = after.ctx.plugin({ inject: [...inject], apply })
    await afterFiber.await()
    declareOverlay(after.slots)
    await Promise.resolve()
    expect(after.slots.entries('shell.overlay')[0]?.component).toBe(LoginOverlay)
  })

  it('registers complete Chinese and English dictionaries', async () => {
    const { ctx, slots } = await bench()
    declareOverlay(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const translate = ctx.locale.bind(NS)
    expect(translate('welcome.user')).toBe(zh['welcome.user'])
    ctx.locale.setLocale('en')
    expect(translate('welcome.user')).toBe(en['welcome.user'])
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('ui-auth-login package companions', () => {
  it('keeps the node half intentionally inert', () => {
    expect(applyNode).not.toThrow()
  })

  it('reserves invariant ownership without installing an audit', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(LoginInvariant)
    await fiber.await()
    expect(LoginInvariant.name).toBe('client-ui-auth-login-invariant')
    expect(LoginInvariant.inject).toEqual(['invariants'])
    expect(() => { (ctx.emit as (event: string) => void)('slots/changed') }).not.toThrow()
    await fiber.dispose()
  })
})
