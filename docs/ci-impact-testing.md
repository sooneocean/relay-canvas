# Impact-selected E2E and memory profiling

The repository's smoke journeys are standalone TypeScript programs, not
Playwright Test Runner cases. PR impact selection operates at **scenario
entrypoint** granularity and intentionally fails closed.

## New independent acceptance scenarios

- `core`: home/canvas/MCP persistence.
- `editor`: Compare, Timeline, handoff and real MP4 export.
- `source-browser`: historical Timeline source selection, playback and state isolation.
- `thumbnail`: isolated VideoThumbnail URL changes, cleanup and decode fallback.
- `relay`: fictional provider flow using local controlled fixtures.
- `media`: real local media import, source-safe generation, mixed Timeline/export.
- `media-network`: **real HTTP upload deadline** (about 30 seconds), disconnect
  and duplicate Content-Length; deliberately no browser and no paid providers.

Previously, `editor` also invoked both `source-browser` and `thumbnail`, while
`media` also waited for `media-network`. Each scenario now has its own test
entrypoint and fixture lifetime. Full regression still includes all seven.

## CI policy

- PRs always run TypeScript checks, serial Node unit tests and Build.
- Mapped narrow changes select the smallest *conservatively verified* scenarios.
- An unknown/shared/core file change or failed/empty diff selects the full
  browser **and** package regression. Filename renames are treated as a
  deletion plus an addition.
- Documentation and unit-test-only PRs need no browser.
- `media-network` only PRs run the 30s network scenario without installing
  Chromium. Changes to its shared media fixture run `media` too.
- Main and v* tag commits always run all scenarios and package checks: this
  protects the exact-commit release gate.
- E2E scenarios run serially, never in parallel. Node unit tests use
  `--test-concurrency=1`. Tests use local Demo/fixture providers only.
- A selected-only green PR is **not** proof of a full system regression.
  Main/tag CI remains the authoritative full gate.

## Resource reports

Each scenario runs through `scripts/profile-smoke.mjs`, which samples its
spawned Node process and descendants through `ps` every 400ms, recording:
- Wall clock time and final status;
- Maximum *observed aggregate process-tree RSS*, process count and five
  largest resident processes at that sample;
- Chromium and FFmpeg RSS subsets at the tree's peak sample;
- Sampling availability/errors.

JSON reports appear at `work/e2e-profile-<scenario>.json` and are uploaded as
the GitHub Actions artifact `e2e-resource-profiles`. Test failures still
propagate. The monitor never calls external generation APIs.

**RSS is approximate**, and summing resident memory across processes can
double-count shared pages. Polling can also miss short-lived FFmpeg processes.
The measurement is not PSS, system memory pressure, macOS Memory Pressure,
or a guaranteed peak; use OS-level tools if testing memory limits precisely.
Unavailable samples are `null`, never fabricated as zero.

## Local usage

```bash
npm run test:impact
npm test
npm run build
npm run smoke

# For a PR branch whose base is available:
GITHUB_EVENT_NAME=pull_request \
PR_BASE_SHA="$(git merge-base origin/main HEAD)" \
node scripts/impact-e2e.mjs --plan

GITHUB_EVENT_NAME=pull_request \
PR_BASE_SHA="$(git merge-base origin/main HEAD)" \
node scripts/impact-e2e.mjs --run

# Standalone 30s network-only scenario:
node scripts/profile-smoke.mjs media-network scripts/media-network-smoke.ts
```

`--plan` writes `needs_smoke`, `needs_browser`, `needs_package`, `full` and
`selected_suites` to `GITHUB_OUTPUT`. `--run` invokes the profiling wrapper
for each selected scenario and stops on the first failure.

## Next steps

1. Split the remaining large `editor` and `media` journey internals into
   shorter isolated sub-scenarios without weakening handoff/export checks.
2. Compare the seven-scenario baseline against a PR that selects only
   `thumbnail`, only `source-browser` or only `media-network`.
3. Consider process PSS and cgroup memory ceilings where available; do not
   infer OOM from a browser HTTP error without resource evidence.
4. Only broaden impact mapping with explicit source-to-test coverage evidence.
