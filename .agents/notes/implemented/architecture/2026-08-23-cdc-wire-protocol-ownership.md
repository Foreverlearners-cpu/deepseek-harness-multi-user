# Agent Note: CDC wire protocol ownership

Status: implemented

English | [中文](2026-08-23-cdc-wire-protocol-ownership.zh.md)

## Problem

The MySQL capture plugin owned both database-specific replication and the event types and decoder imported by Kafka consumers. A consumer therefore depended on MySQL, ZongJi, and Cordis service packaging merely to validate transport bytes, while the decoder accepted malformed UTF-8 replacement characters and had no independent payload ceiling or stable error categories.

## Decision

`@deepseek-ai/dsh-cdc-protocol` owns `CdcEvent`, `CdcCheckpoint`, their supporting types, compound-key encoding, changed-column derivation, and the version-one event codec. Its main entry has no Cordis, Kafka, MySQL, or ZongJi dependency. The required package invariant is an inert companion entry and does not enter the protocol dependency graph.

`decodeCdcEvent()` validates the byte limit before decoding, uses fatal UTF-8 decoding, parses JSON, rejects unsupported versions separately, and then validates exact event and source fields, JSON-safe values, operation-specific row images, canonical timestamps, compound keys, and changed-column coverage. `encodeCdcEvent()` applies the same event validation and a byte limit before returning publishable bytes. Errors use payload-independent messages and stable `CdcWireError.code` values.

`@deepseek-ai/dsh-cdc` imports the protocol package for capture and re-exports its existing CDC types and helpers. Existing Redis and Elasticsearch consumers therefore retain their imports while new consumers can depend on the protocol package without pulling in capture drivers.

## Compatibility

Version one keeps the existing field names and optional `changedColumns` rule. Additive top-level or source fields require a new `specVersion`; this lets old consumers reject an event they cannot interpret instead of silently ignoring producer semantics. The 64 MiB absolute codec ceiling matches the capture package's decoded binlog-event safety scale, and callers can impose a smaller deployment limit.

## Alternatives considered

**Keep the codec in `dsh-cdc`.** This preserved one package but forced every protocol consumer to depend on a database capture implementation and made independent producer and consumer development harder.

**Move MySQL normalization and checkpoint I/O into the protocol package.** These operations are capture concerns: normalization accepts driver-decoded runtime values, while checkpoint publication owns filesystem durability. Moving them would make the protocol package transport-independent in name only.

**Accept unknown fields within version one.** This eased additive changes but allowed a producer to attach semantics that an old consumer silently discarded. An explicit version change makes compatibility review deliberate.

## Consequences

Producers and consumers share one strict, dependency-light protocol package, and malformed messages fail before handler logic sees them. The capture package preserves its public imports through compatibility re-exports. Exact-field validation makes version evolution explicit, and fatal decoding rejects bytes that permissive UTF-8 conversion previously replaced. The codec cannot detect duplicate JSON member names with the platform JSON parser, and schema fingerprints still require capture- and consumer-owned schema checks.
