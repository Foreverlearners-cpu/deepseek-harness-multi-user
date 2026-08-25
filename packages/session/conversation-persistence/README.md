# @deepseek-ai/dsh-conversation-persistence

English | [中文](README.zh.md)

Projects complete runtime Session events into `@deepseek-ai/dsh-conversation` records. It excludes stream chunks and keeps Provider writes bounded without changing the Session log.

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `maxDelayMs` | `500` | Fixed window from the first pending record |
| `maxBatchRecords` | `64` | Record-count trigger and maximum append size, except an indivisible source group |
| `maxBatchBytes` | `524288` | UTF-8 encoded complete-record trigger and maximum append size; one oversized source group is written alone |
| `maxPendingRecords` | `4096` | Per-Session bound including records currently writing |
| `toolEffects` | `{}` | Exact tool-name map to `read-only` or `external-side-effect` |

## Attachment and Use

Mount a `ConversationService` Provider, `SessionStore`, and this plugin. Register tool-effect and extension-event policies before creating Sessions. Then attach each Session before its first semantic event:

```ts
ctx.effect(() => ctx.conversationPersistence.registerToolEffectClassifier(request => {
  if (request.toolName.startsWith('read_')) return 'read-only'
  if (request.toolName.startsWith('write_')) return 'external-side-effect'
  return undefined
}))

const session = ctx.sessions.create()
await ctx.conversationPersistence.attach(session, {
  tenantId,
  userId,
  conversationId,
  sessionId: conversationSessionId(session.id),
  origin: 'top-level',
  delegationDepth: 0,
})
```

Unknown tool effects fail admission instead of defaulting to read-only. `registerEventProjector()` provides the equivalent explicit integration point for plugin-owned required Session events. An unhandled required event creates a sticky error; an event marked `ignorable: true` may be skipped.

`registerRecordPreparer()` adds ordered asynchronous work after projection and before Provider append. A preparer can durably externalize a complete large payload and replace it with an object reference. It must preserve the record id, source sequence, and type; a violation or preparation failure becomes the Session's sticky persistence error.

Call `ctx.sessions.flush(session)` before reading durable conversation state. The plugin also starts a final drain when the Session or plugin is disposed.

## Mapping and Ordering

The built-in mapper persists `user/message`, `assistant/message`, `tool/call`, `tool/result`, and `turn/end`. It ignores chunks, step markers, request snapshots, todo snapshots, and seed boundaries. Visible message text includes only `text` blocks. Tool results preserve the complete tool-result message content, including an empty result.

An aborted, interrupted, or failed turn creates `assistant/interrupted` only when its latest started step has no complete `assistant/message`; partial text is never stored. Every turn end also creates `turn/completed`. A cancellation before a step or after a complete assistant message does not invent an interrupted assistant attempt.

Record ids use `sessionId~sourceSequence` plus a semantic suffix when one source creates multiple records. Message records retain the LLM message id already present in Session data. Turn and step ids are deterministic from the Session id and numeric turn/step positions.

One Session event may atomically create an adjacent record group with the same `sourceSequence`. Providers must commit that group atomically, and batching never splits it even when the group alone exceeds a configured count or byte limit. On attachment, the plugin scans existing records and drops the whole queued source group when that `sourceSequence` is already present.

Writes are serialized within one Session; different Sessions can write concurrently. Count, complete-record byte size, or the fixed timer closes a batch. Capacity, mapping, and Provider failures are sticky for that Session and every later flush reports the first failure.

## Model Experience

### Semantic persistence

#### What the model sees

Nothing. The plugin registers no tool, prompt section, model message, or Session event.

#### Token effect

Zero. Chunks and records do not alter model input.

#### KV Cache effect

None. Persistence does not rewrite the model-visible prefix.

## Known Limitations and Deferred Work

- Approval events require an explicit projector because the current Session decision event does not identify whether a user, administrator, or policy made the decision, and an approval request may omit a tool call id.
- Subagent lifecycle and file publication have no durable Session event mapping in this package.
- Tool results remain inline unless a record preparer externalizes them. The file-metadata plugin supplies the 256 KiB object-storage policy.
- This package supplies no MySQL or local-file Conversation Provider.
