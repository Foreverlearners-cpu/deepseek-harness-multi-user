/** Shell chrome and General-nav dictionaries; feature rows own their copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger': '设置',
  'title': '设置',
  'close': '关闭',
  'openDocument': '打开配置文件',
  'openDocument.error': '无法打开配置文件',
  'general.nav': '通用设置',
  'storage.title': '用户与存储',
  'storage.persistence': 'Session 持久化',
  'storage.users': '用户目录',
  'storage.sessions': '已持久化 Session',
  'storage.userCount': '用户数量',
  'storage.mysql': 'MySQL',
  'storage.other': '其他后端',
  'storage.unavailable': '未启用',
  'storage.pending': '连接中…',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
  'storage.title': 'Users & storage',
  'storage.persistence': 'Session persistence',
  'storage.users': 'User directory',
  'storage.sessions': 'Persisted sessions',
  'storage.userCount': 'Users',
  'storage.mysql': 'MySQL',
  'storage.other': 'Other backend',
  'storage.unavailable': 'Unavailable',
  'storage.pending': 'Connecting…',
} satisfies Record<SettingsKey, string>
