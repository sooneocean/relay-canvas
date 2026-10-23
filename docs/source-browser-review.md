# Timeline source browser acceptance: RC-SOURCES-01

The user's sequence is Ubuntu green, then a searchable and playable-preview timeline source browser, full testing and the next release. Repaired Ubuntu main CI `39933259939` succeeded at `e70084fd8ca18fb103b041ac4ae98ebdefb802b7` before implementation began. See [the media ownership and handoff evidence](compare-handoff-review.md). Published v0.4.0 remains unchanged.

## Approved bounded contract

Plan-verifier returned READY after an ownership clarification. Root approved one creator outcome with exclusive executor ownership of `VideoThumbnail.tsx`, `App.tsx`, `TimelineEditor.tsx` and `styles.css`; root owned acceptance scripts and documentation. Ownership returned before the root's version-only v0.5.0 freeze. Server health/startup/MCP changed only their version strings; no API, schema, credential, FFmpeg or authorization behavior changed in this slice.

Successful same-board video sources are shown as searchable cards, nine per page, ordered by newest run then stable node/output identity. Search includes snapshot node label/prompt/model, node ID, source time and full run ID. Missing snapshot nodes fall back to node ID. Exact `{runId,nodeId,artifactIndex}` is retained independently of identical URLs, search and page state. A selected source stays in its visible summary; unavailable sources explain the failure without substituting another artifact.

Local visible-page cards reuse the extracted frame thumbnail; remote-only cards use a Film fallback until explicit Preview. Preview is a native video in the same dialog, with controls, keyboard focus and an accessible seek range, no autoplay. Browsing, search, selection and preview perform no save, server probe, generation, export or timeline mutation. Only explicit Add/Save-and-Add retains the existing save/info/CAS flow. Closing, changing or losing the source pauses and unloads preview. Identity/URL fences reject old metadata callbacks; unknown duration is not invented.

Root found a thumbnail extraction regression before acceptance: source-change effect cleanup could unload the new URL. The bounded repair gives each URL its own keyed inner video and captures its exact node in cleanup. Browser verification exercises A capture, B URL replacement, old-node unload, component unmount, undecodable thumbnail fallback and recovery. Existing home/gallery callers remain intact.

## Verification contract and current evidence

`scripts/source-browser-smoke.ts` seeds 15 successful historical sources plus excluded failed run/result fixtures in a separate local Store before server start. It includes duplicate URLs across runs/output indexes, nodes absent from the current canvas, missing snapshot nodes, actual saved local files, remote-only playable video and one controlled broken preview. No production fixture endpoint or paid generation is added.

The browser journey checks nine-card pagination, search/reset, page/query retention over live refresh, exact selection while filtered out, keyboard selection, native play/pause and actual-media keyboard seek, preview lifetime, one/all-source disappearance, error retention of dirty trim/format, and 900/1280/1600 layouts with discoverable selected-source/Add controls. Request traffic and board/run/timeline read-back prove browsing/preview is read-only. Explicit index1 Add is saved and read back through the real backend.

`scripts/thumbnail-lifetime-smoke.ts` bundles the actual shared component in memory and uses same-origin fixture media for URL-change/unmount/fallback proof. The existing Compare handoff and single-use/draft tests interact with actual source-card buttons, rather than retaining an unbounded hidden select for tests. The complete original home/gallery/canvas journey, editor MP4 exports, comparison and 17 MCP tools remain release gates.

Final root acceptance, independent outcome verdict and exact-commit main/tag CI are recorded as they complete. The feature is not counted from this document alone. Fixtures do not establish paid-provider live compatibility or LibTV parity; the parent 1,000-round goal remains incomplete.

## Independent challenge and bounded repair

The first fresh outcome review returned **REFUTED** with two reproducible P2 findings: native video-host ArrowRight did not advance media time on Chromium156, and removing every run hid the last manually selected source's summary/reason behind the empty-catalog branch. Root accepted both. The second bounded repair retains native controls and adds an accessible seek range tied to the exact preview video/identity; its keyboard Home/ArrowRight must change actual media time while paused. Empty-catalog rendering must retain exact unavailable selection. The browser helper now challenges both cases rather than weakening the assertions.

That review passed check, 68/68 tests, build and the shared-thumbnail lifecycle/fallback journey. Its first full prelude smoke timed out at quick-video persistence; an isolated fresh quick-create read-back succeeded for both image/video in about 1.5 seconds with revision1 and the correct single-node kind. Keep that failed run as a limitation until the complete fresh workflow and exact-commit CI pass; do not call it a passed run.

Root's first range-Home attempt also timed out; the following isolated fresh journey passed. The acceptance helper now waits for the controlled range to reflect actual paused media time before Home: Home on a range already displaying zero produces no change event, so a test must not assume the asynchronous media timeupdate has already rendered. It still requires actual media to seek to start and then advance by a keyboard range step while remaining paused; no fixed sleep or weakened media/error assertion was added. The final full root and independent results below supersede these failed attempts, without relabeling them as passed.

## Final candidate acceptance

Root's repaired complete `npm run smoke` passed on Chrome155 (`work/v05-repair-final-smoke.log`). Fresh independent re-verification returned **CONFIRMED** on Chromium156, independently passed check, 68/68 core tests, build and the complete `npm run smoke` (`work/v05-independent-repair-{check,test,build,smoke}.log`). It verified both repaired P2 cases, actual keyboard-range media movement, all-source disappearance, zero implicit mutation/probe traffic, real index1 backend read-back, thumbnail URL/unmount/fallback, original home/gallery/canvas, both actual MP4s, handoff/draft and all 17 MCP tools. No reproducible P0–P2 finding remains. Paid requests: zero.

This accepts one source-browser outcome, round9, after the previously accepted eight rounds. Root publication still separately requires clean exact-commit main CI, annotated-tag CI, package verification and public Release asset SHA-256 read-back. The Release and task output report retain those external publication records; this candidate document does not predict their results.
