# Local A/B preference feedback v0.3

Stacked draft PR: #7 → #9 → #11 → this PR. Not deployed or merged.

## Purpose

Provide real, **explicit** local A/B selection signals for future policy evaluation.
No inference is made from downloads, timeline placement, edit frequency, or
automatic aesthetic scoring. This feature is not a trained learning policy.

## Consent and deletion

- Off by default, separate from `RELAY_LEARNING_EVENTS=local` telemetry.
- In Run Compare, choose **啟用本機比較回饋** to store future choices in
  `workspace.json`. This does not upload or share with other users.
- The button **停用並刪除本機回饋** revokes local preference collection and
  clears all previously saved A/B records in the same atomic Store transaction.
- The dialog displays the count and clearly labels that no verified human
  principal exists. Consent revision uses compare-and-swap protection.
- No background model training, network upload, global-learning consent,
  automatic preference labeling, or policy promotion.

## Preference contract and eligibility

The UI offers a deliberate selection of A, B, tie, or neither, plus a bounded
optional reason taxonomy (identity, motion, composition, instruction, technical,
other). This first slice explicitly compares **artifact 0 only** for one
selected node. Both runs must be succeeded, on the same board, and that node's
results must be succeeded, same media kind and different canonical URLs.

The persisted record includes only IDs, output indices, choice, reason code,
consent revision, operation ID, time and `source: local_ui_unverified`.
No prompt, raw feedback text, image/video content, media URL, model API key,
or provider configuration is stored in the preference records. The storage
maximum is 200 records.

`POST /api/learning/feedback` is idempotent by operationId. A changed request
with the same operationId fails, as does recording the same unordered A/B pair
twice under different IDs. The API requires a valid workspace token and
`X-Canvas-Client: ui`, with normal same-origin protections.

## Identity assurance limitations

The current loopback UI and MCP share a workspace token. `X-Canvas-Client: ui`
is a **channel declaration, not proof a human clicked**. Therefore records
MUST NOT be labeled `verified_human`, trusted as independent ground truth, or
used for global training. Before deployment to a multi-user environment,
introduce distinct authenticated principals, scoped tokens and auditable
per-user consent.

The local-only feedback records are intentionally separate from the v0.2
transactional outbox, so simply enabling general observability does not
capture user preference decisions.

## Verification

`npm test` covers opt-in, persistence, idempotence, replay,
consent revision, revocation/deletion, media eligibility, cross-board input,
strict schema, size bounds, and HTTP boundary. Existing Graph benchmark,
Release and E2E gates remain required.

## Next

Verified authenticated actor identities, opt-in encrypted learning export,
quality calibration, preference versioning/editing, trusted holdout evaluation,
and privacy review before any cross-user learning.
