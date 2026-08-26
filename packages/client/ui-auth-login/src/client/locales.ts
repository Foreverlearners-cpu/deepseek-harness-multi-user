/** Login presentation dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'auth.login'

/** Simplified Chinese dictionary and key-set source. */
export const zh = {
  'role.user': '普通用户',
  'role.admin': '管理员',
  'welcome.user': '欢迎回来',
  'welcome.admin': '进入管理控制台',
  'subtitle.user': '登录以继续使用 DeepSeek Harness',
  'subtitle.admin': '使用管理员账号进入控制台',
  'account.label': '账号',
  'account.placeholder': '请输入账号',
  'password.label': '密码',
  'password.placeholder': '请输入密码',
  'password.show': '显示密码',
  'password.hide': '隐藏密码',
  'remember': '记住账号',
  'submit.user': '登录',
  'submit.admin': '进入控制台',
  'error.account': '请输入账号',
  'error.password': '请输入密码',
  'footer': 'DeepSeek Harness',
} satisfies Record<string, string>

/** Login locale key union. */
export type LoginKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'role.user': 'User',
  'role.admin': 'Administrator',
  'welcome.user': 'Welcome back',
  'welcome.admin': 'Open the admin console',
  'subtitle.user': 'Sign in to continue to DeepSeek Harness',
  'subtitle.admin': 'Use an administrator account to open the console',
  'account.label': 'Account',
  'account.placeholder': 'Enter your account',
  'password.label': 'Password',
  'password.placeholder': 'Enter your password',
  'password.show': 'Show password',
  'password.hide': 'Hide password',
  'remember': 'Remember account',
  'submit.user': 'Sign in',
  'submit.admin': 'Open console',
  'error.account': 'Enter your account',
  'error.password': 'Enter your password',
  'footer': 'DeepSeek Harness',
} satisfies Record<LoginKey, string>
