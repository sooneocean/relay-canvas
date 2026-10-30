import { appendFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';

// The existing smoke programs are standalone, serial journeys, not Playwright Test cases.
// Keep selection explicit and fail closed until they are split into independent tests.
export const SUITES = Object.freeze([
  { id: 'core', file: 'scripts/smoke.ts', browser: true },
  { id: 'editor', file: 'scripts/editor-smoke.ts', browser: true },
  { id: 'source-browser', file: 'scripts/source-browser-runner.ts', browser: true },
  { id: 'thumbnail', file: 'scripts/thumbnail-smoke.ts', browser: true },
  { id: 'relay', file: 'scripts/relay-flow-smoke.ts', browser: true },
  { id: 'media', file: 'scripts/media-sources-smoke.ts', browser: true },
  { id: 'media-network', file: 'scripts/media-network-smoke.ts', browser: false },
]);
const ALL = SUITES.map(suite => suite.id);
const EDITOR_MEDIA = ['editor', 'relay', 'media'];
const TIMELINE_MEDIA = ['editor', 'source-browser', 'relay', 'media'];
const THUMBNAIL_MEDIA = ['core', 'editor', 'source-browser', 'thumbnail', 'relay', 'media'];

function classify(file) {
  if (/^(?:docs\/|README\.md$|AGENTS\.md$|CHANGELOG\.md$|LICENSE$)/.test(file)) return { suites: [] };
  if (/^tests\/[^/]+\.test\.ts$/.test(file) || file === 'scripts/release-gate.test.mjs') return { suites: [] };
  if (/^scripts\/package-(?:release|smoke)\.mjs$/.test(file)) return { suites: [], packageSmoke: true };

  // Explicitly mapped stand-alone smoke entrypoints and their helper fixtures.
  if (file === 'scripts/smoke.ts') return { suites: ['core'] };
  if (/^scripts\/(?:editor-smoke|handoff-intents-smoke)\.ts$/.test(file)) return { suites: ['editor'] };
  if (/^scripts\/(?:source-browser-smoke|source-browser-runner)\.ts$/.test(file)) return { suites: ['source-browser'] };
  if (/^scripts\/(?:thumbnail-lifetime-smoke|thumbnail-smoke)\.ts$/.test(file)) return { suites: ['thumbnail'] };
  if (/^scripts\/(?:relay-flow-smoke|relay-ui-boundaries-smoke|relay-fixture-server)\.ts$/.test(file)) return { suites: ['relay'] };
  if (file === 'scripts/media-sources-smoke.ts') return { suites: ['media'] };
  if (/^scripts\/(?:import-network-smoke|media-network-smoke)\.ts$/.test(file)) return { suites: ['media-network'] };
  if (file === 'scripts/v07-source-fixture.ts') return { suites: ['media', 'media-network'] };

  // Features exercised by several integration journeys.
  if (file === 'src/ui/TimelineEditor.tsx') return { suites: TIMELINE_MEDIA };
  if (file === 'src/ui/RunCompare.tsx') return { suites: EDITOR_MEDIA };
  if (file === 'src/ui/VideoThumbnail.tsx') return { suites: THUMBNAIL_MEDIA };
  if (/^server\/(?:editor|editor-supervisor)\.ts$/.test(file)) return { suites: EDITOR_MEDIA };

  // Shared UI, persistence, media routes, schemas, dependencies, and CI are
  // deliberately left unmapped: they require every smoke and package check.
  return null;
}

function fullPlan(reason, changedFiles = []) {
  return { full: true, reason, changedFiles, suites: [...ALL], packageSmoke: true };
}

export function selectPlan({ event, changedFiles, diffOk = true }) {
  if (event !== 'pull_request') return fullPlan('non-PR release gate');
  if (!diffOk || !Array.isArray(changedFiles) || changedFiles.length === 0) return fullPlan('missing or unsafe PR diff');

  const selected = new Set();
  let packageSmoke = false;
  for (const file of changedFiles) {
    if (typeof file !== 'string' || !file || file.startsWith('/') || file.includes('\\') || file.split('/').includes('..')) {
      return fullPlan('invalid changed path', changedFiles);
    }
    const rule = classify(file);
    if (!rule) return fullPlan(`unmapped change: ${file}`, changedFiles);
    for (const suite of rule.suites) selected.add(suite);
    packageSmoke ||= rule.packageSmoke === true;
  }
  return {
    full: false,
    reason: 'known PR impact mapping',
    changedFiles,
    suites: ALL.filter(id => selected.has(id)),
    packageSmoke,
  };
}

export function runPlan(plan, spawn = spawnSync, log = console.log) {
  for (const suite of SUITES) {
    if (!plan.suites.includes(suite.id)) continue;
    const start = Date.now();
    log(`E2E start: ${suite.id} (${suite.file})`);
    const outcome = spawn(process.execPath, ['scripts/profile-smoke.mjs', suite.id, suite.file], { stdio: 'inherit' });
    if (outcome.error || outcome.status !== 0) {
      log(`E2E failed: ${suite.id} (${Date.now() - start}ms)`);
      return false;
    }
    log(`E2E passed: ${suite.id} (${Date.now() - start}ms)`);
  }
  return true;
}

function planFromEnvironment() {
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request') return selectPlan({ event: process.env.GITHUB_EVENT_NAME });
  const sha = process.env.PR_BASE_SHA ?? '';
  if (!/^[a-f0-9]{40}$/.test(sha)) return selectPlan({ event: 'pull_request', diffOk: false });
  try {
    // --no-renames includes both sides of a moved file; a removed high-risk file
    // cannot be hidden by a rename into a documentation path.
    const result = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${sha}...HEAD`], { maxBuffer: 8 * 1024 * 1024 });
    const changedFiles = result.toString('utf8').split('\0').filter(Boolean);
    return selectPlan({ event: 'pull_request', changedFiles });
  } catch {
    return selectPlan({ event: 'pull_request', diffOk: false });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  if (action !== '--plan' && action !== '--run') {
    console.error('Usage: node scripts/impact-e2e.mjs --plan|--run');
    process.exitCode = 2;
  } else {
    const plan = planFromEnvironment();
    console.log(JSON.stringify(plan, null, 2));
    if (action === '--plan') {
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(process.env.GITHUB_OUTPUT, [
          `needs_smoke=${plan.suites.length > 0}`,
          `needs_browser=${plan.suites.some(id => SUITES.find(suite => suite.id === id)?.browser !== false)}`,
          `needs_package=${plan.packageSmoke}`,
          `full=${plan.full}`,
          `selected_suites=${plan.suites.join(',')}`,
          '',
        ].join('\n'));
      }
    } else {
      if (!runPlan(plan)) process.exitCode = 1;
    }
  }
}
