import { useId, useState, type FormEvent } from 'react'
import {
  BrandWordmark,
  FishLogo,
  IconCheckOutline14,
  IconSettingsOutline16,
  IconUserOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './LoginOverlay.module.css'

/** Login presentation mode. Neither value carries authorization. */
export type LoginRole = 'user' | 'admin'

/** Full overlay props: root runtime facts plus package-owned copy. */
export type LoginOverlayProps = PropsRuntime<'shell.overlay'> & PropsLocale<typeof NS>

interface RememberedLogin {
  readonly account: string
  readonly role: LoginRole
}

const STORAGE_KEY = 'dsh.login.remembered-account'

/** Read non-sensitive login convenience state from browser storage. */
function rememberedLogin(): RememberedLogin | undefined {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === null) return undefined
    const parsed = JSON.parse(value) as Partial<RememberedLogin>
    if (typeof parsed.account !== 'string') return undefined
    if (parsed.role !== 'user' && parsed.role !== 'admin') return undefined
    return { account: parsed.account, role: parsed.role }
  } catch {
    return undefined
  }
}

/** Persist only the account convenience value; passwords and login state never enter storage. */
function saveRememberedLogin(value: RememberedLogin | undefined): void {
  try {
    if (value === undefined) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // Browser privacy modes may deny storage; login presentation still works for this page lifetime.
  }
}

/** User/admin login presentation. Submission dismisses this local-only overlay. */
export function LoginOverlay({ t }: LoginOverlayProps) {
  const remembered = rememberedLogin()
  const [role, setRole] = useState<LoginRole>(remembered?.role ?? 'user')
  const [account, setAccount] = useState(remembered?.account ?? '')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(remembered !== undefined)
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [error, setError] = useState<'account' | 'password' | undefined>()
  const [entered, setEntered] = useState(false)
  const accountId = useId()
  const passwordId = useId()

  if (entered) return null

  const chooseRole = (next: LoginRole): void => {
    setRole(next)
    setError(undefined)
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (account.trim() === '') {
      setError('account')
      return
    }
    if (password === '') {
      setError('password')
      return
    }
    saveRememberedLogin(remember ? { account: account.trim(), role } : undefined)
    setEntered(true)
  }

  return (
    <div className={css.screen} data-login-role={role}>
      <header className={css.header} aria-label={t('footer')}>
        <BrandWordmark size={24} />
      </header>

      <main className={css.main}>
        <section className={css.panel} aria-labelledby="login-title">
          <div className={css.brandMark} aria-hidden="true">
            <FishLogo size={30} />
          </div>

          <div className={css.roles} role="tablist" aria-label={t('footer')}>
            <button
              type="button"
              role="tab"
              aria-selected={role === 'user'}
              className={css.role}
              onClick={() => { chooseRole('user') }}
            >
              <IconUserOutline16 />
              <span>{t('role.user')}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={role === 'admin'}
              className={css.role}
              onClick={() => { chooseRole('admin') }}
            >
              <IconSettingsOutline16 />
              <span>{t('role.admin')}</span>
            </button>
          </div>

          <div className={css.heading}>
            <h1 id="login-title">{t(role === 'user' ? 'welcome.user' : 'welcome.admin')}</h1>
            <p>{t(role === 'user' ? 'subtitle.user' : 'subtitle.admin')}</p>
          </div>

          <form className={css.form} onSubmit={submit} noValidate>
            <div className={css.field}>
              <label className={css.label} htmlFor={accountId}>{t('account.label')}</label>
              <span className={css.inputWrap} data-invalid={error === 'account' || undefined}>
                <IconUserOutline16 className={css.inputIcon} />
                <input
                  id={accountId}
                  name="account"
                  autoComplete="username"
                  value={account}
                  aria-invalid={error === 'account'}
                  aria-describedby={error === 'account' ? `${accountId}-error` : undefined}
                  placeholder={t('account.placeholder')}
                  onChange={(event) => {
                    setAccount(event.currentTarget.value)
                    if (error === 'account') setError(undefined)
                  }}
                />
              </span>
              {error === 'account' && <span id={`${accountId}-error`} className={css.error}>{t('error.account')}</span>}
            </div>

            <div className={css.field}>
              <label className={css.label} htmlFor={passwordId}>{t('password.label')}</label>
              <span className={css.inputWrap} data-invalid={error === 'password' || undefined}>
                <span className={css.passwordDot} aria-hidden="true" />
                <input
                  id={passwordId}
                  name="password"
                  type={passwordVisible ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  aria-invalid={error === 'password'}
                  aria-describedby={error === 'password' ? `${passwordId}-error` : undefined}
                  placeholder={t('password.placeholder')}
                  onChange={(event) => {
                    setPassword(event.currentTarget.value)
                    if (error === 'password') setError(undefined)
                  }}
                />
                <button
                  type="button"
                  className={css.passwordToggle}
                  aria-label={t(passwordVisible ? 'password.hide' : 'password.show')}
                  onClick={() => { setPasswordVisible(value => !value) }}
                >
                  {passwordVisible ? t('password.hide') : t('password.show')}
                </button>
              </span>
              {error === 'password' && <span id={`${passwordId}-error`} className={css.error}>{t('error.password')}</span>}
            </div>

            <label className={css.remember}>
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => { setRemember(event.currentTarget.checked) }}
              />
              <span className={css.checkbox} aria-hidden="true"><IconCheckOutline14 /></span>
              <span>{t('remember')}</span>
            </label>

            <button type="submit" className={css.submit}>
              {t(role === 'user' ? 'submit.user' : 'submit.admin')}
            </button>
          </form>
        </section>
      </main>

      <footer className={css.footer}>{t('footer')}</footer>
    </div>
  )
}
