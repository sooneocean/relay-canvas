# Local learning events v0.1 (opt-in)

The learning journal records a minimal, allowlisted Decision Episode event stream for future offline evaluation.
It does **not** train models, share data, change the Agent policy, or run extra generation.

## Opt-in and retention

Default: **disabled**. Set `RELAY_LEARNING_EVENTS=local` in the server environment to enable a local-only append journal:

```bash
RELAY_LEARNING_EVENTS=local npm start
```

Events are written to `$RELAY_DATA_DIR/learning-events.v1.jsonl` (or `.relay-canvas/learning-events.v1.jsonl`).
The file is private (mode `0600`), stored in a non-Git runtime directory, and capped at **16 MiB**.
To stop new events, unset the environment variable and restart. To delete previously collected events,
stop the service and delete only the journal file. No network transmission is implemented.

## Allowlisted events

- `board.revision_committed`: board ID, revision, node/edge counts.
- `board.patch_committed`: board ID, revision and operation type sequence (not operation values).
- `run.started`: board ID/revision, run ID, number of generations, whether any are remote.
- `run.finished`: terminal status and counts of successful nodes / artifacts.

Every entry has schema version, event ID, timestamp and a grouping episode ID. **Not collected**:
prompts, node text, characters, media URLs, provider endpoint/API configuration, secret keys, generated
content, error messages, or free-text user feedback. A saved artifact or completed run is **not**
interpreted as human acceptance or measured creative quality.

## Operational boundaries

This is a best-effort observability slice, **not** a transactional outbox.
A crash between committing the workspace and appending the journal can leave a missing event;
filesystem errors may leave an incomplete final JSONL line. Readers must tolerate/truncate invalid
trailing lines, deduplicate event IDs, and reconcile against canonical run records.
Journal errors fail open for the primary canvas operation and emit a generic warning only once.
Refuse symbolic links, non-regular files, permissive file modes, and growth past the cap.

The events intentionally exclude private creative content. Separate explicit consent and privacy
controls are required before any cross-user learning, cloud collection, content analysis, feedback
labels, or model training. `board.patch_committed` is a mutation signal, not proof the Agent made
the change; source attribution requires a future authenticated actor contract.

## Next milestones

1. Add a durable transactional outbox and event recovery/reconciliation.
2. Introduce authenticated actor and consent scopes with retained privacy settings.
3. Add explicit compare/selection feedback, Episode Builder and controlled replay evaluations.
4. Only then test learned Skills or model routing using separate holdout datasets.
