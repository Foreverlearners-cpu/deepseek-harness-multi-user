# dsh-session-checkpoint-policy

English | [中文](README.zh.md)

Checkpoint policy plugin for persisted agents. It establishes mandatory barriers before a model adapter receives a request, before a top-level tool body may produce an external side effect, and at each `agent/pre-step` boundary. Ordinary background checkpoints use a time strategy by default and can be extended through a policy registry.

## Plugin (namespace: `session-checkpoint-policy`)

This function plugin consumes `ctx.sessions`, `ctx.llm`, `ctx.tools`, and the presence of `ctx.sessionPersistence`. The default waits three seconds after a session becomes dirty before an asynchronous flush; it can also be configured explicitly:

```yaml
- id: session-persistence
  name: '@deepseek-ai/dsh-session-persistence-jsonl'

- id: session-checkpoints
  name: '@deepseek-ai/dsh-session-checkpoint-policy'
  config:
    strategy: time
    intervalMs: 3000
    forceAtTurnEnd: true
    forceAtShutdown: true
```

Persistence and checkpoint scheduling are intentionally separate Cordis plugins. A persistence backend starts bounded background batches for `session/event` appends and makes each requested `session/flush` an immediate quiescence barrier; this policy chooses the ordinary time checkpoint and the request, tool-dispatch, and next-step barriers. Loading a backend without this policy is valid, but a crash may lose events still inside the configured batching window or an outstanding write. First-party persisted apps and runtimes mount both plugins explicitly; a specialized deployment may deliberately omit or replace the policy.

The time scheduler marks only durable message events (`user/message`, `assistant/message`, `tool/result`, and title updates) as dirty. Raw `assistant/chunk` events do not participate in the counter or cause token-level flushes. With the message-only MySQL projection, chunks are not written to the message tables; an event-log backend such as JSONL may still retain them under that backend's own contract.

The policy wraps `llm/stream` lazily, so the downstream stream is not constructed until the live session's buffered request events are durable. It wraps `tools/execute` after pre-execute policy and guards; a top-level tool body runs only after its recorded call is durable. If cancellation lands while that flush is pending, the wrapper returns the canonical `ABORTED_BEFORE_DISPATCH` result without entering the tool body. Nested tool dispatches reuse the outer model-visible call's checkpoint. `agent/pre-step` persists the preceding response/result batch before request derivation.

Checkpoint rejection is fail-closed at the model and tool boundaries: neither the adapter nor the top-level tool body runs. A step-boundary rejection fails the turn before another request starts. Concurrent tool checkpoints share the session store's serialized persistence drain and cannot duplicate sequence numbers.

### Extending the strategy

Strategies implement the `CheckpointPolicy` contract. A deployment can register a factory before loading this plugin and select it with `strategy`:

```ts
import { registerCheckpointPolicy } from '@deepseek-ai/dsh-session-checkpoint-policy'
import type { CheckpointInput, ResolvedConfig } from '@deepseek-ai/dsh-session-checkpoint-policy'

registerCheckpointPolicy('event-count', (_config: ResolvedConfig) => ({
  shouldCheckpoint: (input: CheckpointInput) => input.durableEventCount >= 10,
}))
```

Future `event-count`, `hybrid`, or `manual` strategies do not require changes to the scheduler, Session, or persistence backends.

## Model Experience

### Interrupted calls

#### What the model sees

The plugin adds no prompt or tool schema. A hard crash after a tool checkpoint but before its result leaves a durable unmatched call; session recovery supplies the model-visible `TOOL_OUTCOME_UNKNOWN` result owned by `dsh-session`. The message permits retry for read-only or idempotent work and requires state verification or user confirmation for calls that may have side effects.

#### Token effect

Successful checkpoints add no tokens and do not change the request. Recovery adds one short tool-result message to balance the interrupted transcript.

#### KV Cache effect

The repair result is appended after the reusable prefix, so it does not invalidate earlier cache entries.

## Known Limitations and Deferred Work

- The policy durably records execution intent, not generic exactly-once effects. Side-effecting tools should forward `exec.callId` as an idempotency key when their provider supports one.
- Streaming `assistant/chunk` events are not part of this plugin's time checkpoint and have no per-chunk checkpoint; the message-only projection does not save them. Whether an event-log backend retains chunks is owned by that backend, and a hard crash may lose the current in-memory batch or outstanding write.
- A persisted call without a result cannot prove whether its external effect completed. Recovery therefore records an unknown outcome instead of retrying automatically.
