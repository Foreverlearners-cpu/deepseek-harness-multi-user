# Agent Note: Explicit local conversation ownership

Status: implemented

English | [中文](2026-08-25-explicit-local-conversation-ownership.zh.md)

## Problem

Semantic conversation persistence requires tenant, user, conversation, and Session identities before its first business record. Local and headless deployments have no authenticated call or tenant scope from which to derive owners, while asynchronous `session/created` listeners cannot complete attachment before publication or reject creation.

## Decision

`@deepseek-ai/dsh-conversation-starter` supplies fixed `local-tenant` and `local-user` defaults and exposes an explicit `AgentSetup` adapter. These values are storage ownership labels, not authentication, authorization, or isolation from untrusted tenants. The starter does not read request headers and does not mount MySQL, file storage, or an identity service.

Creation and resume entry points call `ctx.conversationStarter.compose(existingSetup)`. The existing setup completes first so its unpublished Session events are available to attachment seed scanning and a setup failure creates no reservation. Attachment then completes before Agent publication, and the existing synchronous publication commit is returned unchanged. The starter installs no `session/created` listener.

Every runtime Session id maps to a Conversation id through `session-` plus the SHA-256 digest of its complete UTF-8 value. The attachment Session id remains the exact runtime value because conversation persistence verifies their equality. Runtime Session ids must therefore satisfy the Conversation identifier grammar and length; invalid values fail during unpublished setup. The digest produces the same conversation binding on resume.

A root has no parent lineage and receives the configured fixed owners, top-level origin, depth zero, and permanent retention. A child requires `origin: 'subagent'`, `parentSession`, and a positive delegation depth. Its attachment names only the parent Session, so the Conversation Provider inherits the parent's owners. Partial lineage, a missing parent binding, and ordinary forks without subagent origin fail before publication.

Built-in one-shot and continuable subagent implementations own setup callbacks and expose no asynchronous global contribution. The starter therefore covers only creation paths that explicitly compose it; it does not claim transparent coverage of built-in subagent tools.

## Alternatives considered

**Asynchronous `session/created` attachment.** Cordis lifecycle notification does not await listener promises as a creation precondition, so a business event could precede attachment and a rejection would only be logged.

**Use raw Session ids as Conversation ids.** Core Session ids are arbitrary branded strings, while Conversation ids have a restricted grammar and length. Hashing the conversation identity prevents additional collisions with that grammar, while the attachment identity remains raw to satisfy persistence equality.

**Treat fixed owners as a local authentication provider.** Storage labels provide stable query keys but establish no caller identity or access decision. Presenting them as security would make an unsafe multi-user deployment appear protected.

**Modify every subagent provider.** The starter remains an ordinary explicit adapter and does not widen this package into core or subagent lifecycle ownership. Async setup extensibility can be designed separately if transparent coverage becomes required.

## Consequences

Root and explicitly composed child Sessions have stable permanent ownership before publication, malformed lineage fails early, and resume addresses the same conversation. Callers must compose every creation path and mint provider-safe Session ids. If attachment succeeds and a later publication commit fails, an empty idempotent reservation can remain because the Conversation service has no admission rollback operation. Multi-user deployments require a separate authenticated composition and Provider-enforced tenant access checks.
