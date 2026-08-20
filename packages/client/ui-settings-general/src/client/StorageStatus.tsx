/** Read-only evidence that the configured identity and persistence providers are active. */
import type { HostDescriptionSource } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './StorageStatus.module.css'

/** Injected generation-scoped Host description source. */
export interface StorageStatusInjected {
  hooks: {
    hostDescription: HostDescriptionSource
  }
}

/** Full General-section row props. */
export type StorageStatusProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings'>
  & InjectFace<StorageStatusInjected>

type Backend = 'mysql' | 'other' | 'unavailable'

function backendLabel(backend: Backend, t: StorageStatusProps['t']): string {
  return t(`storage.${backend}` as 'storage.mysql' | 'storage.other' | 'storage.unavailable')
}

/** Render provider names and safe counts; connection details never cross this face. */
export function StorageStatus({ t, useHostDescription }: StorageStatusProps) {
  const storage = useHostDescription(description => description?.storage)
  const persistence = backendLabel(storage?.persistence ?? 'unavailable', t)
  const users = backendLabel(storage?.users ?? 'unavailable', t)
  return (
    <div className={css.group} data-storage-status>
      <div className={css.title}>{t('storage.title')}</div>
      <dl className={css.details}>
        <div>
          <dt>{t('storage.persistence')}</dt>
          <dd data-storage-persistence>{storage === undefined ? t('storage.pending') : persistence}</dd>
        </div>
        <div>
          <dt>{t('storage.users')}</dt>
          <dd data-storage-users>{storage === undefined ? t('storage.pending') : users}</dd>
        </div>
        <div>
          <dt>{t('storage.sessions')}</dt>
          <dd data-storage-sessions>{storage?.persistedSessions ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('storage.userCount')}</dt>
          <dd data-storage-user-count>{storage?.userCount ?? '—'}</dd>
        </div>
      </dl>
    </div>
  )
}
