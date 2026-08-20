# Agent Note: MySQL child rows carry direct user ownership

Status: implemented

English | [中文](2026-08-20-mysql-child-rows-direct-user-ownership.zh.md)

## Problem

The ToC service reads and routes high-volume message and attempt rows by authenticated user. Requiring every caller to join the conversation table makes the authorization predicate easy to omit in a new query and prevents direct user-scoped routing, export, cleanup, and partitioning.

## Decision

`dsh_conversation_messages` and `dsh_model_attempts` store `user_id` directly. Existing user-bearing file and Outbox rows also enforce `(session_id, user_id)` consistency with `dsh_conversations` through composite foreign keys. Message reads and attempt reads use both `user_id` and `session_id`.

The redundancy is controlled, not caller-owned: the persistence plugin always derives `user_id` from its trusted configuration, and MySQL rejects a child row whose user differs from its conversation. The existing session foreign keys remain during the additive migration so old installations retain their original referential checks.

## Alternatives considered

**Keep user ownership only on conversations.** Rejected for this product because every high-volume child query and downstream route would need a join, and a missed join predicate could expose another user's rows.

**Copy the field without a database constraint.** Rejected because a stale or forged `user_id` would turn denormalization into a security defect. Composite foreign keys make the conversation the authoritative relationship while retaining a direct access path.

**Add `user_id` to every relation table.** Deferred for `dsh_message_files`; its two foreign keys already identify the message and file relationships, and adding another ownership copy does not improve the current access path.

## Consequences

Message and attempt rows can be filtered, exported, routed, and indexed by user without joining conversations. The schema has additional indexes and a migration step that backfills child rows from their conversation. Any future write path must continue to use the authenticated plugin user and preserve the composite foreign keys.
