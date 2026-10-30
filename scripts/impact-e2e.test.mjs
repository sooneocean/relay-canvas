import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPlan, runPlan, SUITES } from './impact-e2e.mjs';

const all = SUITES.map(suite => suite.id);
const pr = changedFiles => selectPlan({ event: 'pull_request', changedFiles });

test('push/main/tag CI always runs all smoke and package checks', () => {
  for (const event of ['push', 'workflow_dispatch', undefined]) {
    const plan = selectPlan({ event, changedFiles: ['README.md'] });
    assert.equal(plan.full, true);
    assert.deepEqual(plan.suites, all);
    assert.equal(plan.packageSmoke, true);
  }
});

test('documentation and unit-test-only PRs need no browser or package smoke', () => {
  for (const files of [
    ['README.md', 'docs/local-media.md'],
    ['tests/media-stream.test.ts'],
    ['scripts/release-gate.mjs', 'scripts/release-gate.test.mjs'],
  ]) {
    const plan = pr(files);
    assert.equal(plan.full, false);
    assert.deepEqual(plan.suites, []);
    assert.equal(plan.packageSmoke, false);
  }
});

test('standalone smoke changes map to their sole journey', () => {
  const paths = [
    ['scripts/smoke.ts', 'core'],
    ['scripts/editor-smoke.ts', 'editor'],
    ['scripts/source-browser-smoke.ts', 'editor'],
    ['scripts/thumbnail-lifetime-smoke.ts', 'editor'],
    ['scripts/handoff-intents-smoke.ts', 'editor'],
    ['scripts/relay-flow-smoke.ts', 'relay'],
    ['scripts/relay-ui-boundaries-smoke.ts', 'relay'],
    ['scripts/relay-fixture-server.ts', 'relay'],
    ['scripts/media-sources-smoke.ts', 'media'],
    ['scripts/import-network-smoke.ts', 'media'],
    ['scripts/v07-source-fixture.ts', 'media'],
  ];
  for (const [file, suite] of paths) {
    assert.deepEqual(pr([file]).suites, [suite], file);
  }
});

test('timeline, comparison and editor backend include every related smoke', () => {
  for (const file of [
    'src/ui/TimelineEditor.tsx',
    'src/ui/RunCompare.tsx',
    'server/editor.ts',
    'server/editor-supervisor.ts',
  ]) {
    assert.deepEqual(pr([file]).suites, ['editor', 'relay', 'media'], file);
  }
});

test('VideoThumbnail edits always exercise core project cards and gallery integration', () => {
  assert.deepEqual(pr(['src/ui/VideoThumbnail.tsx']).suites, ['core', 'editor', 'relay', 'media']);
});

test('package scripts run package smoke even for a narrow PR', () => {
  const plan = pr(['scripts/package-release.mjs']);
  assert.deepEqual(plan.suites, []);
  assert.equal(plan.packageSmoke, true);
  assert.equal(plan.full, false);
});

test('union of known changed paths is stable and ordered', () => {
  const plan = pr(['docs/research.md', 'scripts/media-sources-smoke.ts', 'scripts/smoke.ts']);
  assert.deepEqual(plan.suites, ['core', 'media']);
  assert.equal(plan.packageSmoke, false);
});

test('unknown or shared change fails closed to all smoke + package', () => {
  for (const file of [
    'server/media.ts', 'server/security.ts', 'server/service.ts', 'server/app.ts',
    'src/shared/schema.ts', 'src/ui/App.tsx', 'src/ui/styles.css',
    'package-lock.json', 'package.json', 'public/demo-motion.mp4',
    '.github/workflows/ci.yml', 'scripts/impact-e2e.mjs',
    'scripts/impact-e2e.test.mjs', 'new-unmapped-file.ts',
  ]) {
    const plan = pr([file]);
    assert.equal(plan.full, true, file);
    assert.deepEqual(plan.suites, all, file);
    assert.equal(plan.packageSmoke, true, file);
  }
});

test('missing diff, invalid paths and suspicious rename destinations fail closed', () => {
  for (const input of [
    { changedFiles: [], diffOk: true },
    { changedFiles: ['docs/foo.md'], diffOk: false },
    { changedFiles: ['/absolute/path'] },
    { changedFiles: ['../docs/x.md'] },
    { changedFiles: ['docs\\x.md'] },
    { changedFiles: [null] },
  ]) {
    const plan = selectPlan({ event: 'pull_request', ...input });
    assert.equal(plan.full, true);
    assert.deepEqual(plan.suites, all);
  }
});

test('runner invokes suites serially in fixed order and stops on failure', () => {
  const observed = [];
  const mock = (_command, args) => {
    observed.push(args.at(-1));
    return { status: observed.length === 2 ? 1 : 0 };
  };
  const ok = runPlan(pr(['scripts/smoke.ts', 'scripts/media-sources-smoke.ts', 'scripts/relay-flow-smoke.ts']), mock, () => {});
  assert.equal(ok, false);
  assert.deepEqual(observed, ['scripts/smoke.ts', 'scripts/relay-flow-smoke.ts']);
});
