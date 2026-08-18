# multi/ — multi-user server infrastructure

English | [中文](README.zh.md)

This group contains Host-only infrastructure used by multi-user server compositions. Its services are never projected into model-controlled execution environments.

| Package | Role | ctx key |
|---|---|---|
| [`kafka/`](kafka/README.md) | Kafka broker connectivity, metadata health, error classification, and client lifecycle | `ctx.kafka` |

Domain plugins retain ownership of authorization, event schemas, topics, partition keys, and durable state. Infrastructure connectivity does not grant access to tenant data.
