# Graph Intelligence Benchmark v0.1

This is the second slice of ReachFlow Verified Learning System, stacked on the opt-in
observation PR. It provides a **synthetic, offline, deterministic regression gate** for
existing CanvasService.patch/validate behavior, not a trained Agent or production metric.

## Run

```bash
npm run benchmark:graph
npm test
npm run check
```

`benchmark:graph` prints machine-readable JSON, exits with status 1 if any expected
behavior changes, and **never** calls a provider or paid model.

## Coverage

The public, versioned fixture suite in `tests/fixtures/graph-benchmark-v01.ts`
contains 29 cases covering:

- Successful edits: node updates, positions, add/remove, cascade delete, connections,
  compound atomic patches, model settings.
- Guardrails: stale revision, missing references, malformed IDs/edges, duplicate
  inputs, invalid topology, reserved parameter injection, missing asset source,
  and atomic rollback.
- Deterministic plans: selected-node ancestor closure, missing provider/prompt,
  unknown selection, 20-generation limit.

Fixtures contain only synthetic content, no user project/creatives/secrets.
`replayGraphBenchmark` executes reference patches through the **real service
implementation**. `scoreGraphCandidate` compares a proposal against the canonical
reference result, rather than crediting arbitrary schema-valid or no-op edits.
`compareGraphPolicies` reports repaired/regressed/both-passed/both-failed paired cases;
it does not claim statistical significance or actual model improvement.

## Observability replay: intentionally limited

`summarizeLearningJournal(text)` validates and summarizes the v0.1 local opt-in
JSONL journal. It deduplicates identical event IDs, counts orphan run terminal
events and incomplete runs, tolerates only a *torn last JSON line*, and rejects
corrupt completed records. Journal metadata cannot reconstruct a Graph Patch,
the prompt, the original artwork, or a human acceptance decision. It is not
a replacement for event-sourced transaction logs.

## Limitations and next steps

- The case fixtures are public and are **not** a blind holdout set.
- This benchmark proves graph/domain behavior only, not LLM planning quality.
- A candidate Agent must be evaluated through an isolated policy adapter; it must
  not be given reference patches or test verdicts.
- The v0.1 local journal remains best-effort, not an atomic outbox.
- Before claiming Learning Gain: add separately held-out cases, authenticated actor
  attribution, explicit consent and human preference labels, and run repeated,
  paired policy comparisons with appropriate confidence intervals.
