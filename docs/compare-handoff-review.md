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

## Integration acceptance reopened

Exact main CI `39928279569` failed after every creator/editor assertion with one `ERR_EMPTY_RESPONSE` from private media. Packaging steps did not run. This is a failed integration gate, not a successful release check. The local-only CONFIRMED above does not supersede it; round8 moves back to pending until repaired integration passes.

Root and independent security reviewer confirmed `RC-HANDOFF-01-MEDIA-1`: `autoClose:false` prevents automatic EOF destruction but explicit `ReadStream.destroy()` still schedules a native close. Existing `sendMedia` closed the FD through MediaStore on `end`, then destroyed the stream on response `close`, creating a second close owner. Both independent Node22 fixtures forced numeric FD reuse and observed the later close invalidate a new sentinel with `EBADF`. This proves a real lifecycle defect; unique attribution of the specific CI event remains unproven without telemetry.

Root approved the bounded security-executor repair in `server/app.ts` and `tests/media-stream.test.ts`, with `server/media.ts` only if indispensable. Keep the O_NOFOLLOW descriptor, token/cookie/Range boundaries, and all browser-error assertions; transfer stream closure through one lease callback after pending I/O. Required proof includes deterministic delayed-close/FD reuse, byte-exact parallel full/Range with abort and zero leaked leases, fresh security/outcome review and exact Ubuntu CI. This repair does not count as another product round. The user's latest AUTO instruction explicitly requires Ubuntu green before the searchable/playable-preview source browser and v0.5.0 publication.

## Single-owner repair evidence

Approved executor modified only `server/app.ts` and new `tests/media-stream.test.ts`; `server/media.ts` was not changed. Auto-destruction plus custom `fs.close` returns through a per-request `ownsLease` callback exactly once after pending I/O. Response close/error only destroys the stream; pre-stream HEAD/416 and constructor failure still release directly. The descriptor is not reopened by pathname.

Actual production-handler regression: the original b9e70d0 logic fails with sentinel `fstat` EBADF after a delayed native close and exact numeric descriptor reuse. Fixed code passes three new cases: EOF/sentinel ownership, real bundled MP4 concurrent full/two Ranges/abort, and read/construction error plus HEAD/416 cleanup. The test uses a bounded allocator to prove reuse rather than assuming or skipping it. Each case asserts no leaked lease and single release; no browser error was filtered or retried.

Root reran check, all **67/67** core tests, production build and complete original/editor browser smoke on Chrome155: PASS. Independent post-fix security reviewer returned **READY**, independently ran the three production HTTP cases and verified unchanged security boundaries. Reviewed SHA-256: `server/app.ts` `e1d9e99763d26ad2496dcc315c372aef8d88957c46cc10af60accfc8cc9b61a7`; `tests/media-stream.test.ts` `7e841ce01afaaf524f09913aa02020c08234f11d4d68d833d451168a336f3c0d`. Fresh outcome verification and repaired exact-commit Ubuntu CI remain required before integration acceptance.

The fresh outcome verifier initially returned **REFUTED** for a P2 test-proof gap: all implementation/browser checks passed, but the first EOF test could also pass old logic because it inspected before response-close destruction. Root accepted this finding and changed only the test. EOF now waits for actual stream destruction; a fourth HTTP case explicitly holds a read callback, cancels the request, observes destruction, completes I/O, waits for the close path, then exercises exact descriptor reuse. No fixed delay establishes the race and no original browser assertion is relaxed.

Root independently ran the same frozen four-case suite against the fixed handler and an isolated byte-exact b9e70d0 handler copy five times each. All five old runs fail with sentinel `EBADF`; all five fixed runs pass 4/4. Old-handler Git blob `72a0479ab9780ece4c0e373900c524836fabdf8c` matches b9e70d0 exactly. Full root suite now passes **68/68**, and check passes. Production app hash is unchanged; updated test SHA-256 is `20b28a5d1f1d27163dc0bc1653cf43fbb6beee03ceec51754556405768c4b5c2`. Independent security addendum returned **READY**, reran 4/4 and inspected both event gates/cleanup with no finding.

Fresh outcome re-verification returned **CONFIRMED**: independently reran the identical frozen test on old/current handlers and observed EOF/abort sentinel EBADF only on old; reran 68/68 core tests, check and complete Chromium156 editor smoke with zero generation/browser errors and both actual MP4 exports. No P0–P2 or advisory findings. Implementation/test hashes remain frozen. Exact repaired main Ubuntu CI is the remaining integration gate; it must pass before restoring round8 as complete and before source-browser implementation.
