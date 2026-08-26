// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginOverlay, type LoginOverlayProps } from '../src/client/LoginOverlay.tsx'
import { zh, type LoginKey } from '../src/client/locales.ts'

const props = {
  t: (key: LoginKey) => zh[key],
  useSessions: vi.fn(),
  useWorkspaces: vi.fn(),
} as unknown as LoginOverlayProps

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('LoginOverlay', () => {
  it('starts in user mode and validates the two required fields in order', () => {
    render(<LoginOverlay {...props} />)
    expect(screen.getByRole('heading', { name: '欢迎回来' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(screen.getByText('请输入账号')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'alice' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(screen.getByText('请输入密码')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret' } })
    expect(screen.queryByText('请输入密码')).toBeNull()
  })

  it('switches to the distinct administrator presentation and toggles password visibility', () => {
    render(<LoginOverlay {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: '管理员' }))
    expect(screen.getByRole('heading', { name: '进入管理控制台' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '进入控制台' })).toBeTruthy()

    const password = screen.getByLabelText('密码')
    expect(password.getAttribute('type')).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: '显示密码' }))
    expect(password.getAttribute('type')).toBe('text')
    fireEvent.click(screen.getByRole('button', { name: '隐藏密码' }))
    expect(password.getAttribute('type')).toBe('password')
  })

  it('remembers only account convenience state and dismisses after local submission', () => {
    const { container } = render(<LoginOverlay {...props} />)
    fireEvent.click(screen.getByRole('tab', { name: '管理员' }))
    fireEvent.change(screen.getByLabelText('账号'), { target: { value: ' root ' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'not-persisted' } })
    fireEvent.click(screen.getByLabelText('记住账号'))
    fireEvent.click(screen.getByRole('button', { name: '进入控制台' }))

    expect(container.firstChild).toBeNull()
    expect(JSON.parse(localStorage.getItem('dsh.login.remembered-account') ?? '{}')).toEqual({
      account: 'root', role: 'admin',
    })
    expect(localStorage.getItem('dsh.login.remembered-account')).not.toContain('not-persisted')
  })

  it('restores a valid remembered account and clears it when remember is disabled', () => {
    localStorage.setItem('dsh.login.remembered-account', JSON.stringify({ account: 'alice', role: 'admin' }))
    const { container } = render(<LoginOverlay {...props} />)
    expect(screen.getByLabelText('账号')).toHaveProperty('value', 'alice')
    expect(screen.getByRole('tab', { name: '管理员' }).getAttribute('aria-selected')).toBe('true')
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByLabelText('记住账号'))
    fireEvent.submit(screen.getByRole('button', { name: '进入控制台' }).closest('form')!)
    expect(container.firstChild).toBeNull()
    expect(localStorage.getItem('dsh.login.remembered-account')).toBeNull()
  })

  it('ignores malformed or inaccessible remembered state', () => {
    localStorage.setItem('dsh.login.remembered-account', '{')
    const first = render(<LoginOverlay {...props} />)
    expect(screen.getByLabelText('账号')).toHaveProperty('value', '')
    first.unmount()

    localStorage.setItem('dsh.login.remembered-account', JSON.stringify({ account: 1, role: 'user' }))
    const second = render(<LoginOverlay {...props} />)
    expect(screen.getByLabelText('账号')).toHaveProperty('value', '')
    second.unmount()

    localStorage.setItem('dsh.login.remembered-account', JSON.stringify({ account: 'a', role: 'owner' }))
    const third = render(<LoginOverlay {...props} />)
    expect(screen.getByLabelText('账号')).toHaveProperty('value', '')
    third.unmount()

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    render(<LoginOverlay {...props} />)
    expect(screen.getByLabelText('账号')).toHaveProperty('value', '')
  })

  it('continues when browser storage refuses a write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    const { container } = render(<LoginOverlay {...props} />)
    fireEvent.change(screen.getByLabelText('账号'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))
    expect(container.firstChild).toBeNull()
  })
})
