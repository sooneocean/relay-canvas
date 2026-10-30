# Impact-selected E2E in CI

The repository's four browser smoke journeys are standalone `tsx` programs, not
Playwright Test Runner test files. This is a conservative file-to-suite selector;
it does not attempt to select individual lines or Playwright tests.

## Policy

- PRs run `npm run check`, `npm test`, `npm run test:release` and `npm run build`.
- Known PR file changes select a subset of `core`, `editor`, `relay`, `media`.
- Docs-only and unit-test-only PRs skip browser setup and smoke, but still run
  the static checks, unit tests and build.
- Package script changes run `package:release` and `smoke:package`.
- Release-gate implementation changes are release-sensitive and require all smoke journeys and package checks.
- Any shared/core/unknown file, unsafe diff, invalid path or empty diff falls
  back to all four browser journeys **and** package smoke.
- `push` on `main` and `v*` tags always runs all four journeys and package smoke.
  Do not weaken this: the release gate requires a successful exact-commit main
  and tag CI.
- Suites run **one at a time** in the fixed order `core → editor → relay → media`.
  `npm test` also uses `--test-concurrency=1` to bound Node test-file workers.
- Existing Demo/fixture testing remains offline; never call paid AI providers.
- A PR passing only its selected suites is not evidence of full regression.
  Main/tag CI is the full gate.

## Local usage

```bash
node --test scripts/impact-e2e.test.mjs
npm test

# In a branch with the base commit available:
GITHUB_EVENT_NAME=pull_request \
PR_BASE_SHA="$(git merge-base origin/main HEAD)" \
node scripts/impact-e2e.mjs --plan

GITHUB_EVENT_NAME=pull_request \
PR_BASE_SHA="$(git merge-base origin/main HEAD)" \
node scripts/impact-e2e.mjs --run

# Defaults to full regression outside a PR event:
node scripts/impact-e2e.mjs --run
```

`--plan` writes `needs_browser`, `needs_package`, `full` and `selected_suites`
to `GITHUB_OUTPUT` in GitHub Actions, and prints the impact decision for review.
`--run` executes only the selected scripts and stops at the first failure.

## Next improvements

1. Split `editor-smoke.ts` and `media-sources-smoke.ts` into independent
   fixtures/scenarios with isolated test state and rerun support.
2. Capture wall-clock and *process-tree* peak RSS for Node, Chromium, MCP and
   FFmpeg. JavaScript heap usage alone is not total memory.
3. Compare FFmpeg/Chromium install times with existing runner capabilities.
4. Validate PR selection against full regression on main and expand mapping
   only when the relevant cross-module paths are proven safe.
