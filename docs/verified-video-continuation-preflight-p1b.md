# P1-b: Verified Continuation Preflight (Read-only)

Status: **Draft. Review-only provenance gate, not an execution capability token**. Stacked on PR #10 (which stacks on PR #8 and #6). This slice changes no existing provider/run/board behavior, has no paid requests and does not deploy.

## Why

Sequential generation can accidentally consume unreviewed or corrupted media as its next conditioning input. This opt-in preflight verifies a server-owned checkpoint chain before planning a continuation. It does **not** mean the visual quality of a video was independently measured. The P0-b approval currently means an assertion made with the local session token, not verified named-user identity.

## API

POST /api/boards/:boardId/video-integrity/continuations/preflight

Authenticated by the existing local Origin/Host/X-Canvas-Token security middleware. JSON body:

```json
{
  "expectedLedgerRevision": 3,
  "parentCheckpointId": "checkpoint-1",
  "anchorIds": ["anchor-1"],
  "mode": "continue",
  "startMs": 5000,
  "endMs": 10000
}
```

Modes:

- continue: must use the newest checkpoint approved for this board (by ledger commit order).
- rollback_branch: explicitly branch from a previously approved checkpoint; never a rejected, missing or proposed candidate.

Response status=preflight_only includes the board/revision, verified parent and anchor content hashes, planned next time range, generationStarted=false, visualQualityVerified=false, approvalIsNamedHuman=false and recheckRequiredAtDispatch=true. No opaque authorization token is issued.

## Fail-closed checks

1. Strict request grammar: limited IDs, anchor count, no duplicate anchors, maximum 60-second next interval, no extra fields.
2. Global ledger revision must match expectedLedgerRevision; stale revision returns 409.
3. Parent must be a real immutable verified checkpoint backed by an operator-approved candidate for this board.
4. Existing approved parent must be latest for ordinary continuation; older parents require explicit rollback_branch.
5. Anchor set must exactly match the approved parent's trusted anchor IDs; callers cannot silently drop or substitute anchors.
6. New segment start time must match the approved parent's end time.
7. Ledger.analysisSource checks actual saved media ownership and re-hashes candidate, original anchors and prior checkpoint media. A tampered file is rejected.
8. A successful preflight is a read-only informational response and never mutates the ledger, calls an AI provider or authorizes future dispatch.

## Security and operational boundaries

Preflight is **not** a permission to generate video. The source could be modified after the response, and new ledger revisions can be committed. A future controlled dispatcher must invoke this exact gate again immediately before executing the provider-specific request, then hold an appropriate lock or use transactional dispatch claims. Existing /api/runs continues to behave as before and is NOT globally protected by this gate.

Current source imports are allowed as anchor records after local byte-level verification; an imported file is not scientifically proven to be an original scene. No identity/pose/geometry scorer, reviewer signature, automatic video repair or prompt-to-provider binding is provided in this PR.

## Tests

Run npm run check, npm test, npm run test:release, npm run build and impact-selected E2E.

Fixture tests cover: valid checkpoint lineage, no-write behavior, no paid generation, proposed/missing/cross-board parent, stale ledger, swapped anchors, incorrect timeline start, invalid body grammar, latest-only mode, explicit rollback branching, tampered media bytes, Origin/token security and read-only API response.

## Follow-on PR

Implement a capability-aware controlled video executor. It must re-run preflight inside dispatch, pin approved input hashes, verify provider support for first/last/anchor conditioning, and require explicit paid-generation confirmation. Do not silently update existing provider paths until integration tests and privacy/security review pass. Add audited quality scorers separately, beginning with identity recognition only on appropriately authorized subjects and test data.