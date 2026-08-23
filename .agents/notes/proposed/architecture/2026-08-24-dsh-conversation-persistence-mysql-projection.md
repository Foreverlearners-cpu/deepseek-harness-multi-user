# Agent Note: dsh-conversation-persistence-mysql projection

Status: proposed

English | [中文](2026-08-24-dsh-conversation-persistence-mysql-projection.zh.md)

## Problem

The decoupled delivery plan treats the semantic conversation store as a projection, not a replacement for the canonical session event log, and explicitly excludes outbox delivery from the current scope. The coupled candidate did the opposite: it exposed a `SessionPersistence` resume adapter backed by the message-only rows, wrote semantic outbox rows on every commit, and carried user identity on core `SessionHeader`. This plugin must project conversations, messages, attempts, and file metadata into MySQL without redirecting existing session-persistence consumers and without outbox machinery.

## Proposal

Add `@deepseek-ai/dsh-conversation-persistence-mysql` under `packages/session/conversation-persistence-mysql` as the user-scoped MySQL conversation projection. It owns `ctx.conversationPersistence` (conversations, messages, attempts, and file metadata) plus a package-owned runtime-config store. A separate `SessionPersistence` provider (`@deepseek-ai/dsh-session-persistence-mysql`) remains the canonical event-log implementation; this plugin never registers `sessionPersistence`.

### Projection boundary

Streaming chunks stay in live session memory. A turn commits one final `user/message`, `assistant/message`, or `tool/result` row in one MySQL transaction owned by the provider; the same transaction records model attempts. Interrupted generations are stored as `partial` or `failed` assistant messages. File bytes are delegated to the required `fileStorage` service; MySQL stores only metadata with the user predicate.

### Ownership

One plugin instance is bound to one configured `userId`. Every conversation, message, attempt, and file query includes that user predicate; core `SessionHeader` carries no user identity. A session id alone is never an authorization credential.

### Out of scope

Semantic outbox fan-out (Kafka/Redis/Elasticsearch) and the message-only `SessionPersistence` resume adapter are not delivered in this branch. The outbox table and adapter modules from the coupled candidate are removed rather than partially shipped.

## Alternatives considered

**Ship the coupled `SessionPersistence` resume adapter.** Not adopted: the plan requires the semantic store to remain a projection and never silently redirect `api/remotes` or other existing consumers.

**Keep semantic outbox rows and the poller.** Not adopted: the user explicitly deferred outbox implementation; committing outbox rows without a consumer would ship unused machinery.

## Acceptance criteria

- No change to `packages/core/session`, `packages/core/agent`, `packages/core/agent-loop`, or `packages/multi/mysql`.
- The plugin never registers `ctx.sessionPersistence`; canonical session persistence remains with a separate provider.
- No outbox table, outbox writes, or outbox consumer modules exist in the package.
- Conversation, message, attempt, and file metadata operations are user-scoped and covered by MySQL integration tests.
- File bytes are delegated to the `fileStorage` service; MySQL stores only metadata.

## Risks

The projection is eventually consistent with the live session: crash recovery relies on the durable spool for assembled turns and on `partial`/`failed` message rows. The provider is tenant-runtime scoped; request-level identity for shared processes is deferred.
