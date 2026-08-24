# Agent Note: Supervised session CDC composition

Status: implemented

English | [中文](2026-08-24-session-cdc-starter.zh.md)

## Problem

The Redis cache invalidator and Elasticsearch search projection must both receive every session-message CDC record, start and stop as one deployment unit, and expose a bounded health signal. Historical repair must reuse their idempotent authoritative writers without making either adapter depend on the reconciler.

## Decision

`@deepseek-ai/dsh-session-cdc-starter` is an ordinary Cordis composition plugin. It mounts typed Kafka events, Elasticsearch projection, Redis invalidation, and optional reconciliation sequentially. The consumers use distinct Kafka groups and subscription ids over one exact topic/database/table route; Redis's schema fingerprint is a member of Elasticsearch's explicit allowlist.

The starter exposes aggregate payload-free health and supervises the two expected subscription ids. A missing or non-running subscription fail-stops the complete scope. Optional reconciliation registers two named sinks that call the adapters' Kafka-independent authoritative writers. The application remains the owner of the authoritative snapshot source and job scheduling.

## Consequences

One CDC record reaches both independently committed side effects, partial startup rolls back, and runtime consumer loss cannot leave a falsely healthy composition. Live and repaired state share revision ordering and tombstone behavior. Deployments must provision the Kafka groups and Elasticsearch mapping, inject a reconciler source, and own retry/dead-letter and restart policy.
