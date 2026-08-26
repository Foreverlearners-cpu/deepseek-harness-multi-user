# @deepseek-ai/dsh-client-ui-auth-login

English | [中文](README.zh.md)

Presentation-only Web login entry for DeepSeek Harness. The plugin contributes a
full-screen `shell.overlay` entry with separate user and administrator modes,
required-field validation, password visibility control, and an optional remembered
account. A valid local submission dismisses the overlay and reveals the workspace.

This package deliberately does not authenticate a credential, create a principal,
issue a token, or grant a permission. The user/administrator switch selects copy and
visual treatment only. A future authentication adapter must replace the local submit
boundary with a Host call and derive authorization from the verified Host result,
never from the selected presentation mode.

The Web bundle activates the plugin through `cordis.patch.yml`. Other assemblies can
add `@deepseek-ai/dsh-client-ui-auth-login` to their bundle dependencies and client
Cordis rows. The plugin waits for `shell.overlay`, so it remains independent of plugin
application order.

## Model Experience

None, as login form values and the selected mode never enter a model request.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No authentication** - any non-empty account and password dismiss the overlay.
- **No authorization** - administrator mode does not grant administrator access.
- **Presentation state is local** - only the account and selected mode may be stored
  in `localStorage`; passwords and authenticated state are never persisted.
- **No server session** - refreshing the page shows the login overlay again.
