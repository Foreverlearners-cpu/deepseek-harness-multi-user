# Session Persistence

English | [中文](persistence.zh.md)

The **durability seam** for the event log. [session.md](session.md) describes the in-memory `Session` — the append-only `SessionEvent` log that is the source of truth. This page describes how that log is made durable: the abstract `SessionPersistence` service, its backends, the flush checkpoint, crash recovery, and the metadata header that travels alongside the log. The event vocabulary the log carries is enumerated, member by member, in the generated [persistence log event catalog](../persistence-catalog.md).

The seam is a [capability seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md): one abstract service ([dsh-session-persistence](../../packages/session/session-persistence), `ctx.sessionPersistence`) defining locate/create/append, reusable Session preparation, logical load/inspect, physical suffix reads, and lightweight list/snapshot observation over the existing `SessionEvent` — **no parallel persisted event type** — and two interchangeable backends implementing the same contract. See the [session-persistence Agent Note](../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md).

## The flush checkpoint

`session/event` is a *synchronous* notification; persistence plugins copy the event into a per-session controller without blocking the producer. The first pending event starts a fixed batching window, and later events join without resetting its deadline. Expiry starts one durable batch; events admitted during that write receive their own deadline and form a follow-up batch. `session/flush` cancels the wait and drains through quiescence, so the loop still uses it as the ordering and error-observation checkpoint before claiming the next ordinary turn. A rejected background write retains its events and pauses automatic retry; a new event starts a fresh window, while explicit flush retries immediately and reports failure through `agent/error` and the logger, never as a session event past the closed turn. Disposal performs the same final drain. The configured maximum bounds only intentional batching wait, not event-loop scheduling or backend durability latency ([decision](../../.agents/notes/implemented/architecture/2026-08-08-bounded-session-persistence-write-batching.md)).

## Crash recovery preserves an interrupted turn

A backend that reloads a log crashed mid-turn finds an open `turn/start` with no `turn/end`. It does **not** truncate — a single turn can be huge in a long-horizon task (many steps, large tool output), and those events were durably appended before the crash. Instead it closes the orphaned turn with a synthetic `turn/end { reason: { kind: 'interrupted' } }`, keeping the interrupted execution balanced without changing any standalone events before or after it. `interrupted` is the one `TurnEndReason` no loop emits (see [session.md](session.md#why-a-turn-ended-turnendreasonmap)).

Repair applies only to cold sessions. For a live id, `SessionPersistence.load(id)` waits until the authoritative in-memory snapshot is durable and returns it only when balanced; an open live turn rejects rather than receiving synthetic interruption boundaries. HMR adopts a live prefix without closing its active turn.

`SessionPersistence.inspect(id)` constructs an immutable logical Session without publishing it or writing recovery. Cold inspection balances an interrupted turn in memory while leaving torn physical tails untouched; inspection of an already-live Session borrows its current immutable snapshot and may therefore contain an open turn. Coordinator-backed implementations retain the exact cold unpublished Session in a bounded LRU, so repeated history reads and a later `prepare(id)` share one read, decompression, validation, freeze, and Session construction. `prepare(id)` reserves the Session, commits pending repair, and returns a disposable publication handle; `load(id)` uses the same machinery to commit repair without publication. The [Session preparation decision](../../.agents/notes/implemented/architecture/2026-08-05-session-preparation.md) owns this lifecycle.

## `SessionLocation` — optional per-session artifact target

`SessionPersistence.locate(meta)` synchronously resolves a backend-owned independent artifact without reading, creating, or flushing it. JSONL returns the absolute transcript path inside its project/session directory; SQLite returns `undefined` because sessions share one database. A returned path can therefore name a file that does not yet exist or lacks the current unflushed turn; it is a location hint, not authorization or a freshness guarantee.

```ts type-equiv
/**
 * A backend-resolved, per-session local artifact location. The path is an
 * absolute target path and can name an artifact that has not materialized yet.
 * Consumers must treat it as a location hint, never as an authorization token.
 */
interface SessionLocation {
  /** Backend-specific artifact kind, for example `jsonl`. */
  readonly kind: string
  /** Absolute path to this session's backend-owned artifact. */
  readonly path: string
}
```

<a id="sessionheader--metadata-beside-the-log"></a>

## `SessionHeader` — metadata beside the log

Per-session metadata travels **separately** from the event log: format version, cwd, lineage, and the seed boundary are storage concerns, not conversation events, so they stay out of `SessionEventMap` and never reach `deriveMessages()`. The header is attached to a `Session` via `session.header`.

Source: [`packages/core/session/src/types.ts`](../../packages/core/session/src/types.ts)

```ts type-equiv
/**
 * Immutable validated storage metadata, kept outside the conversation event log.
 */
interface SessionHeader {
  /**
   * On-disk format version, stamped from {@link SESSION_FORMAT_VERSION} when the
   * session is created. A persistence backend rejects any other version on load
   * (no migration — see the constant).
   */
  readonly version: number
  /** The session's id (mirrors the {@link Session}'s id). */
  readonly id: SessionId
  /** Immutable owning user when the session is created in a user-aware runtime. */
  readonly userId?: UserId
  /** Non-negative safe-integer Unix epoch milliseconds when the session was created. */
  readonly createdAt: number
  /** Absolute working directory the session was created in (if any). */
  readonly cwd?: string
  /** The session this one was forked from (seed lineage), if any. */
  readonly parentSession?: SessionId
  /**
   * How many leading events were inherited through a seed. Persisting this
   * boundary lets resume and replay distinguish parent history from child work.
   */
  readonly seedLength?: number
  /**
   * Coarse product classification for a session created as a subagent child.
   * This is presentation metadata, not proof that the child is continuable.
   */
  readonly origin?: 'subagent'
  /**
   * Delegation depth: absent (zero) for a top-level session, parent depth + 1
   * for a subagent child. Persisted so a recursion budget survives restart and
   * resume — a runtime-only depth would reset a resumed child to top-level.
   */
  readonly delegationDepth?: number
  /**
   * Id of the agent preset this session's agent was composed from, when the
   * deployment composes per session. Durable because the preset decides the
   * session's tools and prompt: a resume that restored a different composition
   * would replay history the model can no longer act on.
   */
  readonly agentPreset?: string
}
```

## Format refusal — logs a build cannot faithfully read

A backend refuses a log it cannot faithfully interpret with `SessionFormatUnsupportedError`, distinct from `SessionPersistenceCorruptionError` because nothing is damaged. A header `version` ahead of `SESSION_FORMAT_VERSION` names the direction ("written by a newer harness — upgrade the harness to open it"); one behind it states that this build ships no upgrade path. After legacy-shape normalization, an event type outside this build's generated vocabulary (`KNOWN_SESSION_EVENT_TYPES`, emitted by `gen-persistence-catalog`) refuses the same way unless the event's envelope carries `ignorable: true` — silently skipping an unrecognized required event could change how the rest of the log must be read. The message appends the raw log path when the backend keeps one artifact per session, so the refused text stays reachable. The JSONL backend refuses a foreign version straight from the raw header line, before validating today's header shape or decoding any event row — a structurally different future format still reports the upgrade direction, never "corrupt"; SQLite gates whole-file structure through its own `SCHEMA_VERSION` pragma first. Design rationale and the deferred upgrader chain live in the [session-log-version-mechanism note](../../.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.md).

## `CreateSessionOptions` — seeding and metadata

Creating a `Session` through the store takes a `seed` (initial replay or fork history) and `meta` (the storage-level fields the store folds into a `SessionHeader`). The store fills in `version`/`id` and defaults `createdAt`; the caller may supply the validated absolute `cwd`, the `parentSession` lineage, the `seedLength` seed boundary, the optional coarse `origin`, the `delegationDepth`, the `agentPreset` the agent was composed from, and an existing `createdAt`. `origin: 'subagent'` lets product navigation hide duplicate child rows; it does not prove that a descriptor is valid or that the child can resume.

```ts type-equiv
/**
 * Options for creating a {@link Session} via the store. `seed` replays/forks
 * an existing event log; `meta` carries the caller-supplied storage fields the
 * store folds into a {@link SessionHeader}.
 */
interface CreateSessionOptions {
  /** Initial replay or fork history supplied at construction. */
  readonly seed?: readonly SessionEvent[]
  /**
   * Storage metadata read once before publication. `seedLength` is explicit
   * because a resumed seed contains the full stored log, not only its inherited prefix.
   */
  readonly meta?: {
    /** Immutable owning user for user-aware runtimes. */
    readonly userId?: UserId
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly createdAt?: number
    readonly seedLength?: number
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
}
```

Replay/fork is therefore `ctx.sessions.create(id, { seed: seedEvents })`; resuming a *persisted* session into a live agent is `ctx.agents.resume({ resumeSessionId })`.

## `SessionRawArtifact` — verbatim stored artifact text

A backend's own artifact text for one session, byte-identical to what it durably wrote (decoded from its physical encoding). `readRaw` returns it without reconstructing from parsed events, so backend-specific serialization (chunk packing, key order, line breaks) survives. Consumers first test `supportsRawArtifacts`: `false` means the backend does not provide this capability (for example SQLite), while `readRaw(...) === undefined` means a supported backend has no materialized artifact for that session.

```ts type-equiv
/** A backend's own raw artifact text for one session, verbatim. */
interface SessionRawArtifact {
  /** The session header parsed from the artifact's own first line. */
  readonly meta: SessionHeader
  /** The artifact's base filename on disk, without any physical encoding suffix. */
  readonly filename: string
  /** The artifact's full text content, decoded from the backend's physical encoding. */
  readonly content: string
}
```

## Preparation and restoration ownership

`SessionStore.prepare()` accepts ordinary creation options or fresh persistence graphs transferred through `RestoredSessionOptions`. The restoration branch validates and freezes the transferred header and events in place, so callers must retain no mutable aliases. `SessionPreparation` then owns the exact unpublished Session until publication or rollback; disposal is synchronous and idempotent. Persistence inspection exposes only `SessionInspection`, an immutable logical view borrowed from the same prepared Session.

```ts type-equiv
/**
 * Fresh storage values transferred to {@link SessionStore.prepare} without a
 * second serialization copy. Callers retain no mutable aliases.
 */
interface RestoredSessionOptions {
  /** Fresh detached storage events to validate and freeze in place. */
  readonly seed: SessionEvent[]
  /** Fresh detached storage metadata to validate and freeze in place. */
  readonly meta: SessionHeader
  /** Select the persistence ownership-transfer path. */
  readonly seedSource: 'persistence'
}
```

```ts type-equiv
/** Inputs accepted while constructing an unpublished Session. */
type PrepareSessionOptions =
  | (CreateSessionOptions & { readonly seedSource?: undefined })
  | RestoredSessionOptions
```

```ts type-equiv
/** Options for a preparation whose provider retains unpublished state. */
interface SessionPreparationOptions {
  /** Release provider-owned state when the Session was not published. */
  readonly release?: () => void
}
```

```ts public-api
/**
 * One exact unpublished Session and the provider state that keeps it usable.
 * Disposal is synchronous and idempotent. Providers decide whether release
 * returns the Session to a cache or discards it; publication may consume that
 * state before disposal, making the callback a no-op.
 */
declare class SessionPreparation implements Disposable {
  /** The exact Session to use for setup and publication. */
  readonly session: Session;
  /**
   * Wrap an unpublished Session in one preparation lifetime.
   * @param session - exact unpublished Session.
   * @param options - optional provider release behavior.
   * @returns a preparation disposed after publication or rollback.
   */
  static create(session: Session, options?: SessionPreparationOptions): SessionPreparation;
  /** Release provider state once when this preparation leaves its caller. */
  [Symbol.dispose](): void;
}
```

```ts type-equiv
/** Immutable logical session prepared from persistence or a live owner. */
interface SessionInspection {
  /** Validated immutable session metadata. */
  readonly meta: SessionHeader
  /** Validated contiguous logical event log. */
  readonly events: readonly SessionEvent[]
}
```

## Lightweight source revisions

Consumers of derived state compare a cheap opaque revision before loading a full event log. The persistence backend owns its representation and changes it transactionally with append or mutating load repair; callers compare it only for equality.

```ts type-equiv
/**
 * Backend-owned token that identifies both one storage source and one revision
 * of a persisted session log.
 */
type SessionPersistenceRevision = Branded<'SessionPersistenceRevision'>
```

```ts type-equiv
/** Lightweight immutable source identity returned without loading a full log. */
interface SessionPersistenceSnapshot {
  /** Detached metadata for one materialized session. */
  header: SessionHeader
  /** Opaque source-qualified token that changes whenever this stored log changes. */
  revision: SessionPersistenceRevision
}
```

## The backends

All providers implement the same abstract `SessionPersistence` (locate/create/append/prepare/load/inspect/readFrom/list/listSnapshots over `SessionEvent`, with optional cancellation on observation methods) and pass the shared `runPersistenceContract` suite:

- **[dsh-session-persistence-jsonl](../../packages/session/session-persistence-jsonl)** — an append-only logical JSONL log per session, stored as checksummed concatenated Zstandard frames by default or raw lines by configuration, with crash-safe atomic writes, interrupted-turn recovery, and a read/replay path.
- **[dsh-session-persistence-sqlite](../../packages/session/session-persistence-sqlite)** — `node:sqlite`, one row per `SessionEvent`. The row fields `(session_id, seq, type, time, data, source_event_seqs, surface_op)` map 1:1 onto the event, including optional surface metadata, so there is no parallel persisted schema to keep in sync.
- **[dsh-session-persistence-mysql](../../packages/session/session-persistence-mysql)** — tenant/user-scoped InnoDB records through `dsh-mysql`. Consecutive chunk runs are gzip-packed and checksummed while reads reconstruct the original logical events; one transaction locks the session cursor and commits each contiguous batch atomically.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconversationpersistence--mysqlconversationpersistence"></a>

### `ctx.conversationPersistence` — `MysqlConversationPersistence`

MySQL message-only persistence. Streaming chunks remain in the live Session only.

```ts cordis-catalog
/**
 * Wait until all event projections already admitted for one session settle.
 * @param sessionId Session whose pending projection writes should settle.
 */
async flushSession(sessionId: string): Promise<void>

/**
 * List model attempts belonging to one user-owned session.
 * @param sessionId Session to query.
 * @returns Attempts ordered by turn, step, and retry number.
 */
async listAttempts(sessionId: string): Promise<ModelAttempt[]>

/**
 * Read committed semantic outbox events for this user.
 * @param options Cursor and page-size options.
 * @returns A bounded page of outbox events.
 */
async readOutbox(options: { afterSequence?: number; afterOccurredAt?: number; afterEventId?: string; limit?: number } = {}): Promise<ConversationOutboxEvent[]>

/**
 * Create one user-owned conversation.
 * @param input Conversation metadata and optional title.
 * @returns The committed conversation row.
 */
async createConversation(input: CreateConversationInput): Promise<Conversation>

/**
 * Read one user-owned conversation.
 * @param sessionId Conversation identifier.
 * @returns The conversation, or undefined when it is not owned by this user.
 */
async getConversation(sessionId: string): Promise<Conversation | undefined>

/**
 * List this user's conversations.
 * @param options Deletion filter and pagination options.
 * @returns Conversations ordered by most recent update.
 */
async listConversations(options: { includeDeleted?: boolean; limit?: number; offset?: number } = {}): Promise<Conversation[]>

/**
 * Read final semantic messages for one conversation.
 * @param sessionId Conversation identifier.
 * @param options Cursor and page-size options.
 * @returns Messages ordered by their conversation ordinal.
 */
async readMessages(sessionId: string, options: { afterOrdinal?: number; limit?: number } = {}): Promise<ConversationMessage[]>

/**
 * Rebuild a compact, contiguous SessionEvent log from semantic rows. This
 * is intentionally a projection, not a token replay: assistant/chunk rows
 * are absent by construction and only final messages/tool results remain.
 * @param sessionId Conversation identifier.
 * @returns A restored header and message-only event list, or undefined when absent/deleted.
 */
async hydrate(sessionId: string): Promise<HydratedSession | undefined>

/**
 * Append one final semantic message.
 * @param sessionId Conversation identifier.
 * @param input Message and optional file links.
 * @returns The committed message row.
 */
async appendMessage(sessionId: string, input: AppendMessageInput): Promise<ConversationMessage>

/**
 * Append a final-message batch atomically.
 * @param sessionId Conversation identifier.
 * @param inputs Messages in their intended turn order.
 * @param expectedRevision Optional optimistic conversation revision.
 * @returns The committed message rows.
 */
async appendMessages(sessionId: string, inputs: readonly AppendMessageInput[], expectedRevision?: number): Promise<ConversationMessage[]>

/**
 * Update a conversation title and publish its semantic outbox event.
 * @param sessionId Conversation identifier.
 * @param title New title.
 * @param status Title state.
 * @param source Title source label.
 * @param expectedRevision Optional optimistic conversation revision.
 * @param expectedTitleRevision Optional optimistic title revision.
 * @returns The updated conversation row.
 */
async updateTitle( sessionId: string, title: string, status: ConversationTitleStatus, source: string = status, expectedRevision?: number, expectedTitleRevision?: number, ): Promise<Conversation>

/**
 * Replace the conversation extension object.
 * @param sessionId Conversation identifier.
 * @param extensions JSON extension fields.
 * @param expectedRevision Optional optimistic conversation revision.
 * @returns The updated conversation row.
 */
async updateExtensions(sessionId: string, extensions: JsonObject, expectedRevision?: number): Promise<Conversation>

/**
 * Publish file bytes through the independent file-storage service and commit metadata.
 * @param sessionId Conversation identifier.
 * @param input File metadata and bytes.
 * @returns The committed conversation-file metadata row.
 */
async saveFile(sessionId: string, input: RegisterFileInput): Promise<ConversationFile>

/**
 * Read one file metadata row owned by the current user.
 * @param sessionId Conversation identifier.
 * @param fileId File identifier.
 * @returns File metadata, or undefined when it is not owned by this user.
 */
async getFile(sessionId: string, fileId: string): Promise<ConversationFile | undefined>

/**
 * List ready and quarantined file metadata for a conversation.
 * @param sessionId Conversation identifier.
 * @returns Files ordered by creation time.
 */
async listFiles(sessionId: string): Promise<ConversationFile[]>

/**
 * List files linked to one message.
 * @param sessionId Conversation identifier.
 * @param messageId Message identifier.
 * @returns Linked files in message ordinal order.
 */
async listMessageFiles(sessionId: string, messageId: string): Promise<ConversationFile[]>

/**
 * Read file metadata and verified bytes.
 * @param sessionId Conversation identifier.
 * @param fileId File identifier.
 * @param signal Optional cancellation signal.
 * @returns Metadata and bytes from the independent file-storage service.
 */
async readFile(sessionId: string, fileId: string, signal?: AbortSignal): Promise<{ metadata: ConversationFile; data: Buffer }>

/**
 * Link existing user-owned files to one message.
 * @param sessionId Conversation identifier.
 * @param messageId Message identifier.
 * @param fileIds File identifiers in display order.
 * @param relation Semantic relation label.
 */
async linkMessageFiles(sessionId: string, messageId: string, fileIds: readonly string[], relation: string = 'content'): Promise<void>
```

Source: [`packages/session/conversation-persistence-mysql/src/index.ts:348`](../../packages/session/conversation-persistence-mysql/src/index.ts)

<a id="ctxmysql--mysql"></a>

### `ctx.mysql` — `Mysql`

MySQL pool service exposed as `ctx.mysql`. Startup acquires one connection and pings the server; failure rejects plugin activation. connection admits work only while the service is active and resets every reusable lease.

```ts cordis-catalog
/**
 * Lease one pooled connection for a callback. Admission precedes pool
 * acquisition, so disposal waits for callbacks already queued for a lease.
 * The connection is reset, restored to the configured database, and released
 * after callback settlement, including throws. Failed cleanup destroys it.
 * The callback receives a façade without pool lifecycle methods or raw driver
 * state. The façade and prepared statements obtained from it cannot be
 * returned and reject every operation after callback settlement.
 * @param callback - database work scoped to this connection lease.
 * @returns the callback result.
 * @throws when the service is closing, pool acquisition fails, or the callback rejects.
 */
async connection<T>(callback: (connection: MysqlConnection) => T | Promise<T>): Promise<T>

/**
 * Run one callback in a transaction owned by this service. The callback
 * receives a query-only façade; begin, commit and rollback are performed by
 * the service and the leased connection expires after settlement.
 * @param callback - database work that must commit or roll back as one unit.
 * @returns the callback result after the commit is acknowledged.
 * @throws the callback error, rollback error, or commit error.
 */
async transaction<T>(callback: (connection: MysqlTransactionConnection) => T | Promise<T>): Promise<T>
```

Source: [`packages/multi/mysql/src/index.ts:149`](../../packages/multi/mysql/src/index.ts)

<a id="ctxruntimeconfigs--mysqlruntimeconfigstore"></a>

### `ctx.runtimeConfigs` — `MysqlRuntimeConfigStore`

MySQL-backed runtime configuration store for title and other dynamic knobs.

```ts cordis-catalog
/**
 * Read one active runtime configuration value.
 * @param key Configuration key.
 * @returns The active value, or undefined when absent.
 */
async get(key: string): Promise<RuntimeConfig | undefined>

/**
 * Create or update one runtime configuration value.
 * @param input Configuration value and optional optimistic revision.
 * @returns The committed configuration row.
 */
async set(input: RuntimeConfigInput): Promise<RuntimeConfig>

/**
 * Subscribe to committed config changes; callers own the returned disposer.
 * @param listener Callback invoked after a configuration commit.
 * @returns A disposer that removes the listener.
 */
subscribe(listener: RuntimeConfigListener): () => void
```

Source: [`packages/session/conversation-persistence-mysql/src/index.ts:1324`](../../packages/session/conversation-persistence-mysql/src/index.ts)

<a id="ctxsessionpersistence--sessionpersistence-abstract-seam"></a>

### `ctx.sessionPersistence` — `SessionPersistence` (abstract seam)

Durable append-only session storage. Implementations preserve contiguous, losslessly JSON-serializable events; append resolves only after durability, and load balances a complete interrupted tail without rewriting committed events.

```ts cordis-catalog
/**
 * Resolve this backend's independent local artifact for a session without
 * reading, creating, flushing, or otherwise materializing it. Backends such
 * as SQLite that do not own one artifact per session return `undefined`.
 * @param meta - the immutable session header whose artifact is requested.
 * @returns the backend-specific absolute location, when one exists.
 */
abstract locate(meta: SessionHeader): SessionLocation | undefined

/**
 * Read a session's backend-owned artifact text verbatim — the exact durable
 * bytes the backend wrote (decoded from its physical encoding, e.g. a
 * decompressed JSONL). The returned `content` is the raw text, not a
 * reconstruction from parsed events, so it preserves backend-specific
 * serialization (chunk packing, key order, line breaks). Callers first test
 * {@link supportsRawArtifacts}; `undefined` then means only that the requested
 * session has no materialized artifact.
 * @param _id - the persisted session to read (unused by the default: no
 * per-session artifact).
 * @param signal - optional cancellation for backend read work.
 * @returns the raw artifact plus its parsed header, or `undefined` when the
 * session is absent.
 * @throws when this backend does not expose per-session raw artifacts.
 */
readRaw(_id: SessionId, signal?: AbortSignal): Promise<SessionRawArtifact | undefined>

/**
 * Register a new session's metadata. A backend MAY defer the physical write
 * until the first {@link append} (lazy materialization), in which case a
 * created-but-never-appended session is absent from {@link list}
 * — abandoned sessions leave nothing behind.
 * @param meta - the immutable header (id, version, cwd, lineage) to record.
 */
abstract create(meta: SessionHeader): Promise<void>

/**
 * Durably persist a batch of events. Honors the append-only and contiguous-
 * seq contracts: the first event's `seq` MUST equal the stored next-seq
 * (after `load` has durably closed any interrupted turn). Rejects non-JSON-
 * serializable `event.data` with an error naming the offending event type.
 * @param id - the session the batch belongs to.
 * @param events - the contiguous batch to persist, in seq order.
 */
abstract append(id: SessionId, events: readonly SessionEvent[]): Promise<void>

/**
 * Prepare the exact unpublished Session used by resume. Implementations may
 * reuse object graphs retained by an earlier {@link inspect} after confirming
 * their durable revision is still current; disposal releases an unpublished
 * reservation. Revision retries require the durable log to remain unchanged
 * for one read/check round trip; continuous external writers may delay completion.
 * @param id - persisted session to prepare.
 * @param signal - optional cancellation for preparation work.
 * @returns one owned unpublished Session preparation.
 */
async prepare(id: SessionId, signal?: AbortSignal): Promise<SessionPreparation>

/**
 * Load an immutable balanced logical view and commit any required cold
 * recovery. A complete interrupted final turn is preserved and durably
 * closed with missing tool errors plus any open step and turn boundaries;
 * only a torn final record is discarded. Unknown versions and corruption in
 * the committed prefix reject. Implementations MUST NOT crash-repair an
 * identity still bound to a live Session: a balanced live log may return as a
 * durable snapshot, while an open live turn rejects. Returned values may be
 * shared with immutable live or prepared state and must not be mutated.
 * Revision-based implementations may wait for one stable read/check round trip.
 * @param id - the persisted session to reload.
 * @returns the header and a log ending on a balanced `turn/end`.
 */
abstract load(id: SessionId): Promise<SessionInspection>

/**
 * Inspect an immutable logical session without committing recovery or
 * publishing it. A cold complete interrupted turn receives synthetic closers
 * in memory and a torn physical tail remains untouched. An already-live
 * Session instead yields its current immutable snapshot, which may contain an
 * open turn and its `session/end-seed` boundary. Coordinator-backed
 * implementations retain the exact cold unpublished Session for bounded
 * reuse by a later {@link prepare}. A stale ready source is reloaded; a source
 * already committing or reserved for resume remains exclusive, and inspection
 * may borrow its immutable view. Callers borrow only the immutable header and
 * log. Continuous external writers may delay revision convergence.
 * @param id - the persisted session to inspect.
 * @param signal - optional cancellation for queued and backend read work.
 * @returns the validated header and current logical event log.
 */
abstract inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection>

/**
 * Read the stored events from `fromSeq` onward — the read-from-seq
 * primitive for read models that resume from a watermark (e.g. a persisted
 * projection cache folding only the tail past its checkpoint). Unlike
 * {@link inspect}, it is a detached physical suffix read: no preparation
 * cache, torn-tail truncation, synthetic closers, or coordinator-state
 * publication. Only events from the valid contiguous stored prefix are
 * returned, so a torn fragment never reaches the caller. `fromSeq` at or
 * beyond the stored prefix returns an empty event list (never an error).
 * Backends whose medium can seek by seq
 * (SQLite) read only the suffix; sequential media (JSONL, both encodings)
 * still parse the whole artifact and skip forward — the primitive bounds
 * what is RETURNED and refolded, not every backend's physical read.
 * @param id - the persisted session to read.
 * @param fromSeq - first event seq to include; a non-negative safe integer.
 * @param signal - optional cancellation for queued and backend read work.
 * @returns the header and the stored events with `seq >= fromSeq`.
 */
abstract readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }>

/**
 * Lightweight listing from metadata, without a full-log parse.
 * @param signal - optional cancellation for backend listing work.
 * @returns one header per materialized session.
 */
abstract list(signal?: AbortSignal): Promise<SessionHeader[]>

/**
 * List materialized sessions with cheap per-log change tokens.
 *
 * Repeated observations of an unchanged log return the same revision. A
 * successful mutating {@link load} repair changes the next listed revision.
 * Revisions also distinguish independently backed stores so backend-local
 * counters cannot compare equal across different persistence sources.
 * @param signal - optional cancellation for backend snapshot-listing work.
 * @returns one header and opaque revision per materialized session without loading full logs.
 */
abstract listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]>
```

Types: [SessionEvent](session.md) · [SessionId](core.md)

Source: [`packages/session/session-persistence/src/index.ts:84`](../../packages/session/session-persistence/src/index.ts)

<a id="ctxusers--userservice-abstract-seam"></a>

### `ctx.users` — `UserService` (abstract seam)

User identity storage seam. Providers own the durable user records.

```ts cordis-catalog
/**
 * Create an active user; duplicate ids must reject.
 * @param input User identity and optional display name.
 * @returns The committed user record.
 */
abstract create(input: CreateUserInput): Promise<User>

/**
 * Read one user, returning undefined when it is absent from this tenant.
 * @param id User identifier.
 * @returns The user record, or undefined when absent.
 */
abstract get(id: UserId): Promise<User | undefined>

/**
 * Read one active user or reject with a not-found/disabled error.
 * @param id User identifier.
 * @returns The active user record.
 */
abstract requireActive(id: UserId): Promise<User>

/**
 * Disable a user without deleting owned data.
 * @param id User identifier.
 */
abstract disable(id: UserId): Promise<void>

/**
 * List users visible to this configured tenant runtime.
 * @returns Visible user records.
 */
abstract list(): Promise<User[]>
```

Source: [`packages/identity/user/src/index.ts:46`](../../packages/identity/user/src/index.ts)
<!-- END GENERATED cordis-surface -->
