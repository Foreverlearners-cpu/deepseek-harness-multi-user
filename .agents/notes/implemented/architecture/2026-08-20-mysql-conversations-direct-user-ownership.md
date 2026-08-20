# Agent Note: MySQL conversations use direct user ownership

Status: implemented

English | [中文](2026-08-20-mysql-conversations-direct-user-ownership.zh.md)

## Problem

The ToC conversation store serves individual users and does not implement teams, organizations, tenants, or another owner category. A polymorphic `owner_kind/owner_id` pair made the relational schema, plugin API, authorization predicates, and operational queries describe owner types that the product cannot create.

## Decision

`@deepseek-ai/dsh-conversation-persistence-mysql` accepts one trusted `userId` from Host composition and stores it as `user_id` on `dsh_conversations`, `dsh_conversation_files`, and `dsh_conversation_outbox`. Each column references `dsh_users.user_id`; schema version 2 rejects the earlier owner-column layout until an explicit database migration renames the columns and removes `owner_kind`. The child-row denormalization decision is recorded in [the direct child ownership note](2026-08-20-mysql-child-rows-direct-user-ownership.md).

Message-file links continue to reference a conversation through their message and file relationships. Messages and model attempts carry direct `user_id` with the composite consistency rules described in the linked note.

The durable message spool also records `userId`, and the SessionPersistence adapter restores `SessionHeader.userId` from the conversation row. Request payloads never select the user scope.

## Alternatives considered

**Keep `owner_kind/owner_id` for possible team ownership.** Rejected because no current service, foreign key, authorization rule, or UI can represent a non-user owner. A future organization capability requires an explicit schema and membership model rather than an unused discriminator.

**Copy `user_id` into every relation row.** Rejected for `dsh_message_files` because its message and file foreign keys already determine the current relationship; high-volume messages and attempts use the separate direct-ownership decision.

**Rename only TypeScript fields while retaining owner-named SQL columns.** Rejected because database inspection and operational SQL are part of the maintainable interface; the physical schema must state the same user-only model as the plugin API.

## Consequences

Conversation and file queries use one explicit user predicate, and database operators can identify user ownership without interpreting a discriminator. The schema gives up polymorphic ownership; adding teams or organizations requires a deliberate new capability and schema migration. Directly owned message and attempt rows still require the authenticated `user_id` together with `session_id`; a bare session id is never authority.
