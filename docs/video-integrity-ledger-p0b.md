# Video Integrity P0-b — Local Immutable Lineage Ledger

Status: **Draft, local-only, manual-review prototype**. Stacked on [P0 PR #6](https://github.com/sooneocean/relay-canvas/pull/6), not on World IR / World Scene Store PRs. No production rollout, remote generation, model scoring, paid calls or modification of Board v1 / Timeline / Run data.

## What this slice provides

- An append-only sidecar at `<RELAY_DATA_DIR>/video-integrity.json` with per-workspace monotonically increasing revision, SHA-256 chain, operation receipt and strict invariant replay on every read.
- Anchors can be registered only for **already imported media on the same board**, after server-side byte-by-byte SHA-256 re-verification using `MediaStore.verifyArtifact`. Imported source means *first registered user asset*, not a scientific guarantee that the asset was never AI-generated.
- Candidates can be registered only for saved local video owned by the board. Each manifest must reference existing same-board trusted anchors and optionally an existing approved parent checkpoint. Candidates enter **proposed**, never automatically approved.
- A checkpoint can only arise from a separate explicit `confirmReviewed: true` POST. The server re-verifies the actual candidate and anchor media before append. The action is labeled `explicit_local_operator`; the existing session token **does not establish a named human identity** and can be used by any trusted caller holding that token. Production identity-backed review remains future work.
- Rejected candidates have no checkpoint. A future candidate referencing a rejected or unknown parent is rejected.
- Optimistic concurrency via `expectedRevision`, idempotency via `operationId`, content-hash receipt and no-write on conflict. Replay returns the original committed revision and current revision separately.

## Existing security boundary

Routes use the already-shipped `createBoundary`: loopback host, same-origin and `X-Canvas-Token`. This does **not** constitute multi-user authorization. Media may be used only when registered to the relevant board in `StoreData.localAssets`, succeeded `Run` artifacts or succeeded `Export` artifacts. A file with the same global SHA-256 but belonging to another board is not sufficient.

The sidecar is single-writer and protected by the existing local workspace lock. Refuses non-0600 files, symlinks, invalid chains, duplicate operations, broken lineage and oversized records; preserves existing journal bytes on rejection. The hash chain detects accidental edits, **not deliberate tampering by an attacker who can rewrite the journal and hashes**. Migrate to a transactional database plus identity/audit keys for multi-process deployments.

## API (all under current authenticated local session)

| Method | Path | Input / behavior |
|---|---|---|
| GET | `/api/boards/:id/video-integrity` | Returns current global revision and this board's anchors, candidates and checkpoints |
| POST | `/api/boards/:id/video-integrity/anchors` | `{operationId,expectedRevision,artifactSha256}` |
| POST | `/api/boards/:id/video-integrity/candidates` | `{operationId,expectedRevision,candidate}` |
| POST | `/api/boards/:id/video-integrity/candidates/:candidateId/approve` | `{operationId,expectedRevision,confirmReviewed:true,reason}` |
| POST | `/api/boards/:id/video-integrity/candidates/:candidateId/reject` | `{operationId,expectedRevision,reason}` |

Successful first write: 201; idempotent replay: 200. All actions return `{revision,currentRevision,operationId,replayed,action}`. Errors use current AppError JSON envelope, with 400 for invalid requests, 404 for unowned media, 409 for stale revision, invalid lineage or changed bytes, and 500 for corrupted/unsafe journal.

Candidate manifest follows `src/shared/video-integrity.ts`, but **assessments and events must be empty arrays in P0-b**. The browser or agent is not trusted to submit quality scores. This prototype provides human/operator review and lineage, not machine-evaluated video quality.

### Example write sequence

1. Import a reference image using the existing local media import endpoint, save its content hash.
2. POST `/anchors` with the imported image digest and revision 0; returns anchor ID equal to `operationId`.
3. Save a candidate video locally, then POST `/candidates` with its digest, anchor ID, optional approved parent checkpoint, start/end times, empty assessments/events, and revision 1.
4. Independently inspect the video. Explicitly POST `/approve` with `confirmReviewed: true` and a reason, or POST `/reject`. A successful approval returns checkpoint ID equal to the approval operation ID.
5. To create the next candidate, set its `parentCheckpointId` to the approved checkpoint ID; reference original anchors again. Invalid or rejected parent fails closed.

## Non-goals and risk

- **No automatic real visual scoring**: P0-b never claims a candidate passed VBench/identity/optical-flow checks.
- **No automatic generation enforcement**: Existing `/api/runs` and provider routes remain unchanged. Unverified media is blocked **when registering lineage through this new API**, not globally at the generation router; P1 must add a capability-aware generation preflight.
- **No multi-user or LLM-resistant human approval**: a process with the local session token can assert `confirmReviewed:true`. UI-only human verification is not a security boundary. Introduce role-scoped credentials and reviewer signatures before enabling agent-initiated review.
- No asset retention pinning or garbage-collection integration, no cryptographic signer, no automatic repair or high-resolution enhancement.
- Prototype journal limits: at most 4000 commits / 16 MiB. More substantial deployment requires a transactional store.

## Validation

```bash
npm run check
npm test
npm run test:release
npm run build
```

Test coverage targets: CAS & replay after fresh ledger instance; forged score rejected; parent approval/rejection lineage; cross-board identical media; actual byte-level tamper; unsafe permissions; hash-chain corruption no-write; and unauthorized / authenticated HTTP routes.

Do not merge the stacked PR before P0 PR #6 is merged and rebased. Do not deploy this work until private Gitea/Jenkins ReachFlow source compatibility and release tests are independently verified.
