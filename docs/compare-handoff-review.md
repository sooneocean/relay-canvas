# Compare to Timeline acceptance: RC-HANDOFF-01

The parent goal remains 1,000 verified product improvements toward LibTV competitiveness. This slice is one creator outcome, not a new claim of parity. The v0.4.0 release and its published assets remain unchanged.

## Approved contract

Plan-verifier returned READY for RC-HANDOFF-01 before this slice. Root approved a UI-only handoff after exact v0.4 main/tag CI and public asset read-back. Published prerequisite commit: `c8ae1dd3aa9d5caf1f3509378d47918865ca9ca6`; main CI `39922254516`, tag CI `39922847198`, archive SHA-256 `8d11cc605a3f0e2ff39764f87f9a1cd8d6cd8ec96e494876939bdfce9d6f8ee9`.

The clean base adds only an ignored `.worktrees/` rule in `300ffbd`, then isolates source/build/tests on `codex/compare-timeline-handoff`. User's running primary source/build and workspace were not changed by implementation. Root owns integration and publication.

- An explicit action on either Compare output selects the same board's exact `{runId,nodeId,artifactIndex}` in Timeline. It performs no implicit artifact save, probe, clip add, export or generation.
- Current live successful run/result, exact 0..99 index, video kind and canonical URL establish eligibility. Historical revisions and deleted current-canvas nodes remain eligible. Canonical fallback rendering alone is insufficient authority.
- App revalidates at click and navigation completion and preserves the existing canvas save guard. Timeline validates application, consumes each token once, and preserves exact unavailable identity. Manual choice wins over delayed loads and later catalog refreshes.
- Failed/active/missing/drifted sources explain why they cannot be used. Source disappearance never substitutes another clip. Closing clears parent intent; ordinary reopen has no old intent.
- Handoff leaves timeline clips/format/revision/draft and board/run/canonical comparison unchanged. Explicit Add uses the existing save/info/CAS path and persists exact source identity.
- Single-dialog entry guards protect a dirty Timeline and prevent competing focus traps. No server, shared schema, credential, FFmpeg or authorization change is included.

## Verification scope

`scripts/editor-smoke.ts` seeds a separate isolated Store before server start, with two successful historical runs, a node absent from the current canvas, and two artifacts per node. A/B index1 is selected, then explicit Add is saved through the real server and read back. This is not a mocked successful Add. Board, run, timeline and canonical snapshots and request traffic prove selection-only semantics.

The same browser journey covers delayed timeline/capabilities, runs refresh, manual override, double click, close/reopen, overlapping-dialog rejection, save/probe failure preserving dirty trim, active/failed/missing/nonvideo/drifted catalogs, unavailable exact selection and explicit retry with zero generation requests. Its existing 17-tool journey, real MP4 playback/download/hash, sequential cuts and comparison playback checks remain intact.

`scripts/handoff-intents-smoke.ts` additionally bundles the actual Timeline component in memory with Vite. Controlled prop transitions challenge single-use tokens, board mismatch, newer intent, unavailable selection, delayed capability response and unsaved format/trim preservation. It creates no app endpoint and writes no workspace/build files. Component fixtures supplement the real backend journey.

Status: local acceptance passed on 2026-10-23. Root ran `npm run check`, `npm test` (64/64), `npm run test:release`, `npm run build`, and the complete `npm run smoke` on Chrome155. Fresh outcome verifier independently returned **CONFIRMED**, ran the complete editor smoke on Chromium156.0.8078.4, check, 64/64 core tests and diff check, and found no reproducible P0–P2 or advisory findings. It inspected real backend source read-back and the component fixture, rather than accepting test counts alone. No source/scripts changed after that verdict; only these evidence/counter documents changed. Round8 is one verified unreleased creator outcome. Exact-commit remote CI is still an integration gate; this does not publish or modify v0.4.0. Automated fixtures do not prove paid-provider live generation or competitor parity.

Root expanded the UI asset scope to `index.html` and `public/favicon.svg` after real Chrome reported the missing automatic `/favicon.ico` request as a 404 in both browser journeys. The local explicit SVG favicon fixes that request; browser-error assertions remain intact. This incidental repair is not another improvement round.
