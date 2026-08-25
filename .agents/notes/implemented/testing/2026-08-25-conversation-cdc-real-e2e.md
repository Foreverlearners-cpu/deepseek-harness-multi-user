# Agent Note: Real Conversation MySQL-to-Kafka CDC E2E

Status: implemented

English | [中文](2026-08-25-conversation-cdc-real-e2e.zh.md)

## Problem

Conversation persistence and CDC had separate real-service tests, but no test proved their shared physical contract. A change could leave `ConversationMysql` green while altering the message table, Kafka key ordering, row-image completeness, timestamp representation, or checkpoint behavior expected by CDC consumers. Unit doubles also could not prove that a 300-message agent turn survives a real MySQL binlog checkpoint restart without loss or duplication.

## Decision

An opt-in E2E test mounts the real `Mysql`, `ConversationMysql`, `KafkaService`, and `CdcService` plugins against the development MySQL and Kafka services. It writes two 150-message batches only through `ctx.conversations.append()`, disposes and recreates CDC with the same checkpoint between batches, and consumes a unique one-partition Kafka topic from a unique group.

The test treats `dsh_conversation_messages` as a deliberately narrow CDC projection: exactly ten physical columns, no `excludeColumns`, a compound Kafka key ordered as `tenant_id`, `user_id`, `session_id`, `message_id`, complete ten-field row images, and canonical UTC timestamps. It requires exactly 300 unique insert events and pins one schema fingerprint across the event stream and checkpoint. Test cleanup is ownership-scoped to its random tenant and topic; it does not drop shared tables, databases, or containers.

## Alternatives considered

**Test CDC with direct SQL inserts.** This would exercise binlog transport but not prove that the public Conversation provider produces the promised table rows. It also could silently diverge from projection rules in `ctx.conversations.append()`.

**Mock MySQL or Kafka.** Mocks cannot exercise row metadata, row-image settings, transaction boundaries, Kafka key bytes, consumer offsets, or checkpoint restart behavior. Those are the contract under test.

**Persist streaming chunks and reconstruct messages in the consumer.** Conversation storage intentionally publishes completed semantic records rather than transport chunks. Chunk persistence would multiply write and event volume without improving the requested recovery boundary.

## Consequences

Developers can opt into a destructive-safe, real-service proof with `DSH_CONVERSATION_CDC_E2E=1`. The test needs the documented local MySQL binlog user and Kafka broker, creates one temporary topic, and can take longer than unit tests. A physical message-schema or key-order change now requires explicit coordination with CDC consumers instead of passing unnoticed.

The current Elasticsearch Conversation projection rejects an empty or whitespace-only `visible_text`, while the MySQL and Redis path can represent it. This E2E records that integration risk but does not change Elasticsearch runtime policy; a separate decision and test are required before routing such messages there.
