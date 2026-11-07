# Durable Local Learning Outbox v0.2

Status: stacked draft PR on top of the synthetic Graph benchmark. No production deployment.

## Goal and scope

This replaces the v0.1 **best-effort post-commit observation** with a bounded
**transactional outbox in the same canonical workspace.json write** as the
board revision or run state change. It never changes execution policy or starts
generation, and never provides inferred "human accepted" labels.

- Opt-in only: `RELAY_LEARNING_EVENTS=local`. Without it, no new learning
  metadata or journal entries are generated. No cloud transmission.
- Each committed event is sealed as a strict, allowlisted record with a stable
  UUID `eventId`, `episodeId`, `actor: unattributed`, and `scope: local_only`.
  No prompt, model provider URL/key, artifact URL, creative content, or free-text error.
- `src/shared/schema.ts` validates all outbox records when reading and writing
  the workspace. `CanvasService.state()` explicitly strips learning metadata
  so the browser/API state never exposes a learning ledger.
- Every successful `save` or `patch` queues revision metadata in the same
  transaction; a patch also queues the operation-type summary. A run start
  and its terminal transition queue their records in the same respective
  run transactions.

## Delivery and recovery

`LocalLearningOutbox.flush()` appends the **same event ID** to the local
`learning-events.v1.jsonl` journal, fsyncs the append, then removes that
event from the transactional outbox. A crash after append but before removal
can yield a duplicate physical row with the same stable ID; `summarizeLearningJournal`
deduplicates it for logical counts.

On startup, the existing Store marks outstanding runs `interrupted`.
A durable observed-run ID marker lets the outbox reconcile a corresponding
terminal event without retransmitting any external generation request.

Delivery is **at least once**, not exactly once. Outbox entries are capped at
1,024 to bound storage. If the queue cannot drain and fills, new nonterminal
observations are dropped with a persisted count; this deliberately preserves
creative work instead of crashing or blocking paid jobs. Terminal observation
markers are retained for later reconciliation when capacity is available.

An incomplete final journal line stops new appends (instead of silently
concatenating invalid JSON) and leaves events pending in the outbox. Manual
local repair of the torn tail is required; the reader can report it. A
symlink, unexpected file mode, full journal or inaccessible file also stops
delivery without affecting the primary canvas operation.

## Privacy and actor attribution

An event from the current loopback UI or MCP cannot yet be reliably attributed
to a specific **human** or **Agent** principal; therefore actor is explicitly
`unattributed`, not "human", even if a user clicked the UI. Similarly, an
export, download or saved artifact is **not** counted as explicit acceptance.

Local opt-in is not consent for cross-user training. A future authenticated
actor/consent and feedback contract, UI consent handling, reset/export controls,
and organizational retention policy must be implemented before central
aggregation, training or use in production multi-user workspaces.

## Acceptance tests

`npm test` includes loss/rollback, inaccessible journal, restart delivery,
append-before-ack duplication, interrupted run reconciliation, full queue,
privacy redaction and disablement. `npm run benchmark:graph` remains the
deterministic graph regression gate. No paid provider request is made.

## Limitations

- Only board revision/patch and run lifecycle are wired: imported assets,
  exports, timeline edits and direct provider updates are not yet observed.
- Outbox events do not contain patch operation **values**, so no full graph
  reconstruction is possible from the learning journal alone.
- File-backed Store transactions are process-local; future multi-process
  deployments require a real transactional database and concurrency control.
- Retention, removal of all historical workspace learning metadata, and
  durable per-user consent management remain future security work.
