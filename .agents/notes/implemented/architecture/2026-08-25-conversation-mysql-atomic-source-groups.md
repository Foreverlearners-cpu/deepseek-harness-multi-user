# Agent Note: Atomic MySQL conversation source groups

Status: implemented

English | [中文](2026-08-25-conversation-mysql-atomic-source-groups.zh.md)

## Problem

One Session source event can project to several adjacent semantic records. Treating `sourceSequence` as globally unique loses valid records, while retrying records independently can accept only part of a source event. Conversation metadata, user-visible messages, and subagent state must also remain consistent when any write fails.

## Decision

`@deepseek-ai/dsh-conversation-mysql` locks one owner-scoped conversation row and writes a complete append in one transaction. Records use conversation sequence as their primary order and uniqueness over `(tenant, user, session, sourceSequence, recordId)`, so adjacent records may share a source. Every source group carries the same SHA-256 over its canonical complete records. A retry succeeds only when every requested row and group hash matches; partial or changed retries fail.

Record and message rows use multi-value statements capped at 64 rows while one outer transaction covers every statement, projection, and conversation advance. Message identity remains `(tenant, user, session, message)` and the CDC-facing message table exposes exactly the ten fields accepted by existing consumers; query-only ordinal and extensions live in a separate internal state table. The message projection commits beside its source records. A subagent completion without a started run aborts the same transaction.

The Provider stores canonical UTC timestamps and permanent retention. Every query includes tenant and user ownership and uses a filter-bound keyset cursor. Schema creation uses a server advisory lock and records a version only after all Provider-owned tables exist.

## Alternatives considered

**Unique source sequence.** This prevents the legitimate interrupted-attempt plus turn-completion pair emitted from one Session event.

**One transaction per SQL batch.** It reduces transaction duration but can expose a prefix of a source append and advance projections separately from records.

**INSERT IGNORE idempotency.** It cannot distinguish an exact retry from changed content or a partial source group, so it would hide conflicts.

**CDC-owned tables.** Conversation persistence owns relational truth; CDC remains an optional downstream publication mechanism and must not define these tables or transactions.

## Consequences

Exact retries and crashes preserve whole source groups and synchronized projections. Large appends use several bounded SQL statements but retain one transaction and row lock, increasing transaction duration. Canonical hashing costs CPU and permanent retention requires later owner-aware archival or garbage collection outside this Provider.
