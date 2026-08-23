# Agent Note: Session CDC cache watermarks

Status: implemented

English | [中文](2026-08-23-session-cdc-cache-watermarks.zh.md)

## Problem

Deleting a session cache after a CDC notification is insufficient when an older read can finish later and refill stale data. Kafka offsets cannot version domain data across partitions or rebuilt topics, and a shared cache must isolate tenants before multiple organizations use the same Redis deployment.

## Decision

`@deepseek-ai/dsh-session-cache-invalidation-redis` consumes strict `CdcEvent` records through `dsh-kafka-events`. It accepts one exact topic, database, table, schema fingerprint, compound Kafka key, and fixed session-message row schema. Inserts and deletes invalidate. Updates skip only with an explicit changed-column list disjoint from the fixed cached-content columns.

Each tenant/user/session has a cache key and a separate revision watermark key. One Redis Lua operation compares canonical decimal revisions, advances only a newer watermark, and deletes the cache. Cache population uses the exported Lua-backed `refillSessionContextCache()` helper, which writes only when its authoritative revision is not below the watermark. Both operations are atomic relative to each other.

## Alternatives considered

**Use Kafka partition offsets as revisions.** Offsets are transport positions scoped to a topic partition and change under repartitioning or replay; they cannot order authoritative session state.

**Delete without a watermark.** This leaves a race in which an older database read writes stale cache content after the delete.

**Update Redis from CDC row contents.** Cache assembly belongs to the session read owner and may require more than one row; invalidation preserves that ownership.

## Consequences

Repeated and out-of-order CDC records are idempotent by authoritative revision, tenants cannot share cache keys, and old refill attempts fail without overwriting current cache state. Consumers must use the exported refill helper, revisions must be canonical positive decimal integers, and any row or schema change requires coordinated configuration and code changes.
