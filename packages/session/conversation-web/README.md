# `@deepseek-ai/dsh-conversation-web`

English | [中文](README.zh.md)

Optional lifecycle adapter that attaches Web, ordinary Web-fork, and built-in in-process subagent Sessions to semantic Conversation persistence before Agent publication. Without this plugin, ApiProxy and subagent behavior is unchanged.

## Composition

The adapter does not create a database connection or select a Conversation Provider. A MySQL deployment mounts the complete chain in one Loader tree:

```yaml
- name: mysql
  config:
    host: 127.0.0.1
    user: dsh
    password: ${DSH_MYSQL_PASSWORD}
    database: dsh
- name: conversation-mysql
- name: conversation-persistence
- name: conversation-starter
  config:
    tenantId: local-tenant
    localUserId: local-user
- name: conversation-web
```

`dsh-mysql` supplies `ctx.mysql`; `dsh-conversation-mysql` supplies `ctx.conversations`; `dsh-conversation-persistence` classifies Session events, projects complete semantic facts, and buffers writes; `dsh-conversation-starter` supplies the local owner labels; this package joins those services to Agent creation and resume entry points. The Web adapter registers no event-specific projectors, so Web, headless, and other compositions share the same persistence behavior.

The Provider creates and verifies its tables during startup. A functional check queries `dsh_conversation_schema` for `schema_name = 'conversation'` and `version = 1`, sends a unique Web message, flushes the Session, and finds that text in `dsh_conversation_messages`. Streaming chunks are not stored.

## Lifecycle semantics

- Fresh Web Sessions and cold resumes attach to the same deterministic Conversation identity.
- An ordinary Web fork is a new top-level Conversation with the configured owner labels. Its Session header retains `parentSession` and `seedLength`, but it has no Conversation delegation parent.
- In-process one-shot and continuable subagents attach as `origin: subagent`, inherit tenant and user from the attached parent, and retain Conversation delegation lineage.
- Existing preset, policy, and child setup runs before attachment. Failure prevents Agent publication.

## Security boundary

The starter's fixed tenant and user values are storage labels, not authentication. This composition is suitable for local or trusted single-user deployment. Multi-user Web deployment must replace fixed ownership with verified authentication and tenant scope before relying on these rows for isolation.

## Model Experience

### Web conversation attachment

#### What the model sees

`None`. The adapter registers no tools, prompts, messages, or Session events.

#### Token effect

Zero direct tokens per request.

#### KV Cache effect

None. Lifecycle attachment does not change model request prefixes.

## Known Limitations and Deferred Work

- Out-of-process subagent Providers own another process and require that process to mount its own Conversation chain.
- If attachment succeeds and a later publication commit fails, an empty idempotent Conversation reservation may remain.
- Ordinary Web-fork ancestry remains in the Session log only; Conversation delegation lineage is reserved for subagents.
