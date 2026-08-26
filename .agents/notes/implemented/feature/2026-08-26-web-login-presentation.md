# Agent Note: Web login presentation

Status: implemented

English | [中文](2026-08-26-web-login-presentation.zh.md)

## Problem

The assembled Web application opened directly into the workspace even though the
product needs distinct entry surfaces for ordinary users and administrators. The
authentication contracts exist separately, but this round must establish and review
the presentation before choosing a credential provider or authorization policy.

## Decision

**A new client plugin owns the entry surface.** `ui-auth-login` contributes one
full-screen `shell.overlay` entry instead of changing the layout or conversation
packages. It waits on the slot declaration, so the contribution works regardless of
Cordis apply order and leaves cleanly with its plugin fiber.

**User and administrator are presentation modes, not principals.** A segmented
control changes the title, supporting copy, action label, and restrained status color.
Both modes use the same accessible account/password form and required-field checks.
Submitting non-empty values dismisses the overlay locally; no Host API is called and
no role, token, session, or permission is created.

**Only non-sensitive convenience state may persist.** When requested, the browser
stores the trimmed account and selected mode in `localStorage`. Passwords and the
dismissed state never enter storage, so reload always restores the login boundary.
Storage denial or malformed prior values degrades to an empty form.

**Future authentication replaces one boundary.** A later authentication plugin can
replace the local submission with a Host request. The verified Host response must be
the only source of principal and authorization state; the client mode selection is
untrusted input and can at most select the intended login flow.

## Alternatives considered

**Place login state inside AppFrame.** Rejected because authentication entry is an
independent product surface and would couple layout ownership to identity concerns.

**Create separate user and administrator plugins.** Rejected because the two modes
share lifecycle, fields, validation, and responsive layout. Separate packages would
duplicate presentation without creating a security boundary.

**Connect directly to JWT in this round.** Rejected because the requested scope is an
unauthorized presentation prototype. Issuing tokens before the credential and Host
session boundaries are selected would make the UI appear more authoritative than it
is.

## Consequences

The default Web bundle now opens on a responsive, theme-aware login surface and can
switch between ordinary-user and administrator presentation. Successful local submit
reveals the existing workspace without changing its components. Tests pin both modes,
validation, password visibility, remembered-account safety, slot lifecycle, and both
locale dictionaries. Until a Host authenticator is connected, deployments must treat
this as presentation only and must not use it as an access-control boundary.
