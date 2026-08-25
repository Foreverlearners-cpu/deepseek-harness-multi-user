# Agent Note: Owner-scoped conversation file object metadata

Status: implemented

English | [中文](2026-08-25-conversation-file-object-metadata.zh.md)

## Problem

Complete tool results and generated files can exceed the practical size of semantic MySQL records. Storing bytes in relational rows couples object transfer to transaction duration, while storing only a raw local path bypasses tenant and user ownership. Object publication and relational metadata also cannot share one atomic commit, so failure ordering must not destroy an object another concurrent publisher may already reference.

## Decision

`@deepseek-ai/dsh-conversation-files-mysql` composes the immutable `ctx.fileStorage` Provider with MySQL owner metadata. It publishes complete bytes first, then locks the exact `(tenantId, userId, conversationId)` row and commits `dsh_file_objects`, `dsh_conversation_files`, and an optional `dsh_conversation_message_files` association in one transaction. Every public read and write includes tenant, user, and conversation identity. Message attachment additionally verifies the message in that owner-scoped conversation.

The metadata schema has its own version row and database-scoped advisory lock. It does not alter the Conversation Provider's records, messages, or CDC-facing ten-column message table. Stored object references retain the Provider-issued backend, opaque key, digest, and byte length; consumers never persist or return a filesystem path or bearer URL.

The plugin registers an asynchronous Conversation record preparer. A complete `tool/result` JSON value strictly larger than the configured 256 KiB default is published as `application/json`; a SHA-256 of `recordId` derives the stable `fileId`, and the prepared record replaces `result` with `resultFileId`. The preparer never receives `assistant/chunk`, and this plugin defines no chunk table or API.

If object publication succeeds and MySQL fails, the object remains immutable and may be unreachable. The operation never attempts compensating deletion because content-addressed publication can deduplicate concurrent owners or retries. Later owner-aware reference counting and garbage collection may reclaim proven-unreachable objects.

## Alternatives considered

**Write MySQL metadata before object publication.** A committed row could reference bytes that never became ready, violating complete-read semantics.

**Delete the object when metadata rolls back.** The same immutable object may already be referenced by an exact retry or concurrent publication, so compensating deletion can corrupt valid data.

**Store large JSON directly in MySQL.** This enlarges semantic record transactions and repeats large payloads during replay instead of preserving one immutable object reference.

**Store local filesystem paths.** Paths expose Provider internals, cannot represent later storage Providers, and do not enforce tenant and user ownership.

## Consequences

Conversation records stay bounded and owner-scoped APIs resolve complete objects without changing CDC tables. Exact preparer retries derive the same file identity and local content-addressed storage deduplicates the bytes. The deliberate object-first ordering can consume storage after a metadata failure, so V1 favors data safety over immediate reclamation. V1 ships only the local Provider and defers deletion, archival movement, MinIO, S3, and orphan collection.
