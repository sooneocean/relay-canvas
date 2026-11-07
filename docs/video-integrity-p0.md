# ReachFlow Video Integrity P0 — immutable lineage and repair planning

Status: **draft / fixture-only / provider-neutral**. This proposal is additive and isolated from Board v1, Run, Timeline, MediaStore, existing generation adapters, World IR PR #4, and Scene Store PR #5.

## Objective
Prevent sequential AI-video generation from silently promoting a degraded last frame into the sole source of truth. Each generated segment must reference immutable, independently approved original media plus an optional last-verified checkpoint; suspect segments never become authoritative without another explicit verification step.

## Files and contracts

- src/shared/video-integrity.ts: strict v1 types and runtime validation for anchor provenance, verified checkpoints, candidate segment manifests, assessor metrics and drift events.
- tests/video-integrity.test.ts: deterministic fixture coverage, no paid generation.
- evaluateVideoIntegrity returns: accept, manual_review, restore, local_inpaint, regenerate_segment, rollback_and_regenerate.
- The accept action means the **pure policy check passed**. It does not imply that a scorer was run, that media was actually examined, or that a checkpoint was saved. These enforcement responsibilities belong to trusted service code in a future PR.

## Security and integrity invariants

1. Never trust a client-supplied media digest, scorer score, reviewer ID or verification status. The server must hash and independently validate local bytes and their ownership before registering an anchor.
2. Anchor records are append-only; a replacement or human-approved generated asset becomes a new anchor, never an overwrite of an existing source. Store immutable artifact hashes and board ownership.
3. The evaluator fails closed on missing/cross-board anchors, absent or mismatched prior checkpoints, unsupported metrics, low confidence and invalid inputs.
4. A verified checkpoint must be created only by a trusted, authenticated and atomic server transaction after reviewing actual scorer evidence and policy compliance.
5. No automatically rejected candidate may be supplied as the parent of a subsequent segment. Repairs create new artifact versions; original candidate media remains unchanged.
6. Do not expose arbitrary paths, media URLs, key environment variables or remote provider credentials through this contract. Reuse existing signed, content-addressed /api/media authority and existing Origin/session boundary.

## Default policy (NOT calibrated ground truth)

Required metrics: subject, background, temporal, semantic and imaging. Minimum score: 0.80 except imaging at 0.75. Minimum assessor and event confidence: 0.80. Maximum affected area for local inpainting: 0.25 of the frame. All are engineering hypotheses requiring validation on an annotated benchmark; a higher score does not establish identity fidelity.

- Missing metric or uncertain evidence => manual review.
- High-confidence local geometry drift of at most 25%, isolated to one segment => local inpaint.
- Motion drift or larger local geometry drift => regenerate affected segment.
- Identity, global scene geometry, semantics or persistent drift => rollback to previously verified checkpoint; for first segment regenerate from original anchors.
- Compression or color-only event => propose non-destructive restoration.
- Failing metric without an explainable localized drift event => manual review.
- A segment passes only if every required metric clears the threshold and no drift event remains.

## Follow-up PR slices

**P0-b: durable sidecar ledger.** Add read-only and mutation API under existing token/origin boundary; append-only anchor/candidate/checkpoint journal, SHA-256 by server-side verified media bytes, optimistic concurrency, idempotency and replay protection, no changes to current StoreData. Tests must cover cross-board references, restart, tampered hash, permission/symlink protections, concurrent writes, rollback and no-write on errors.

**P1: actual detector adapters.** Implement subject/face-object matching, occlusion-aware temporal comparison, background/geometry consistency, semantic checks, and imaging quality on local fixture videos. Store scorer version and input digest, calibrate per-shot applicability and precision/recall with human labels before any automated checkpoint commit.

**P1: conditioning router.** Connect anchor and checkpoint reference to existing preflightGeneration, passing only supported inputs based on each provider's proven capability. Never assume multi-image, first-last-frame, keyframe, or KV-cache support in all closed APIs.

**P2: non-destructive repair executor.** SAM2 mask tracking, coherent local video inpainting, restoration and segmented re-generation; re-score every repaired candidate, retry with bounded budgets, keep full lineage.

**P3: model-level interventions.** Evaluate attention-anchor memory, KV-cache compression and forcing/corrector techniques on eligible self-hosted models, separately from cloud provider adapters.

## Verification

- Local targeted module: TypeScript strict compile and 8 Node tests passed.
- GitHub integration gates required: npm run check, npm test, npm run build; verify CI before merging.
- No live provider tests, paid generation, public main changes, workspace migration or deployment were performed.
- Public GitHub main may diverge from private Gitea/Jenkins ReachFlow; reconciliation remains required before release.
