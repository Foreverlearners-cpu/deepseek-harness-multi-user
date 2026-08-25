# `@deepseek-ai/dsh-conversation-starter`

English | [中文](README.zh.md)

Explicit local/headless ownership attachment for semantic conversation persistence. It supplies an `AgentSetup` adapter that attaches each Session before Agent publication.

**`local-tenant` and `local-user` are storage ownership labels only.** This package does not authenticate callers, authorize reads or writes, isolate untrusted tenants, or accept request headers as identity. A multi-user deployment must derive ownership from verified authentication and tenant scope and enforce it in its Conversation Provider.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `tenantId` | `local-tenant` | Fixed owner label for root conversations |
| `localUserId` | `local-user` | Fixed owner label for root conversations |

The plugin injects `conversationPersistence`; the deployment mounts `dsh-session`, one `dsh-conversation` Provider, and `dsh-conversation-persistence` separately. It does not mount MySQL or file storage.

## Agent Setup

Every Agent creation and resume entry point must explicitly compose the starter:

```ts
const handle = await ctx.agents.create({
  sessionId,
  setup: ctx.conversationStarter.compose(existingSetup),
})
```

The existing setup completes first. The starter then awaits conversation attachment and returns the existing publication commit unchanged. A setup or attachment failure prevents Session and Agent publication. The starter never uses an asynchronous `session/created` listener.

Root Sessions receive the configured owner labels, permanent retention, top-level origin, and depth zero. A child must have `origin: 'subagent'`, `parentSession`, and a positive `delegationDepth`; its Conversation Provider resolves the parent binding and inherits its tenant and user. Partial or conflicting lineage fails before publication. An ordinary `SessionStore.fork()` has `parentSession` without subagent origin and is unsupported.

`stableSessionIdentity()` hashes the complete runtime Session id with SHA-256 to produce a fixed-length Conversation id. The attachment Session id remains the exact runtime Session id because `dsh-conversation-persistence` verifies their equality. Creation therefore fails before publication unless the Session id also satisfies the Conversation id grammar; fresh creation and resume still address the same conversation.

## Model Experience

None. This Host-only adapter registers no tools, prompts, messages, or Session events.

## Known Limitations and Deferred Work

- Built-in one-shot and continuable subagent paths own their setup callbacks and expose no asynchronous global setup contribution. This package does not cover them automatically; an entry point must explicitly compose this starter.
- Runtime Session ids must match the Conversation service's identifier grammar and length even though core `SessionId` accepts arbitrary strings.
- If attachment succeeds and an existing setup's publication commit later fails, the Provider may retain an empty idempotent conversation reservation because the Conversation service has no admission rollback operation.
- Authenticated multi-user ownership and tenant access enforcement require a separate composition built on verified identity and tenant scope.
