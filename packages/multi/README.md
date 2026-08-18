# Multi-user infrastructure

English | [中文](README.zh.md)

Host-only infrastructure shared by multi-user domain plugins. This group owns deployment-facing client mechanics; authorization and search-projection domains retain their own services and data ownership.

| Package | Context key | Role |
|---|---|---|
| [`@deepseek-ai/dsh-elasticsearch`](elasticsearch/README.md) | `ctx.elasticsearch` | Elasticsearch client lifecycle and callback-scoped operations |

The [Elasticsearch infrastructure reference](../../docs/infrastructure/dsh-elasticsearch.md) maps current ownership and links the proposed projection, isolation, and consistency design.
