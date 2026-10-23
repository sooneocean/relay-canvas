import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'vite';
import type { Browser } from '@playwright/test';
import type { Board, Run, Timeline } from '../src/shared/types.js';

/** Fault injection around the real Timeline component. Vite bundles in memory;
 * this fixture exposes no app endpoint and writes no workspace or build files. */
export async function verifyHandoffIntents(browser: Browser, root: string, board: Board, runs: Run[], timeline: Timeline) {
  const source = (runId: string, artifactIndex = 1) => ({ runId, nodeId: 'archived-motion', artifactIndex });
  const initial = { token: 'initial', originBoardId: board.id, source: source('handoff-a'), canonical: { kind: 'video', url: '/demo-motion.mp4' } };
  const entry = `
    import React, { useCallback, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import TimelineEditor from ${JSON.stringify(path.join(root, 'src/ui/TimelineEditor.tsx'))};
    const h = React.createElement;
    const fixtureBoard = ${JSON.stringify(board)};
    const fixtureRuns = ${JSON.stringify(runs)};
    const fixtureTimeline = ${JSON.stringify(timeline)};
    const initial = ${JSON.stringify(initial)};
    const requests = [];
    let releaseTimeline, releaseCapabilities;
    const delayedTimeline = new Promise(resolve => { releaseTimeline = resolve; });
    const delayedCapabilities = new Promise(resolve => { releaseCapabilities = resolve; });
    function Harness() {
      const [runs, setRuns] = useState(fixtureRuns);
      const [intent, setIntent] = useState(initial);
      const [consumed, setConsumed] = useState([]);
      const requestJson = useCallback((endpoint, init = {}) => {
        requests.push({ endpoint, method: init.method || 'GET' });
        if (endpoint.endsWith('/timeline') && !init.method) return delayedTimeline;
        if (endpoint === '/api/editor/capabilities') return delayedCapabilities;
        return Promise.reject(new Error('Unexpected implicit request: ' + endpoint));
      }, []);
      const consume = token => {
        setConsumed(current => [...current, token]);
        setIntent(current => current?.token === token ? undefined : current);
      };
      const next = (token, runId = 'handoff-a', originBoardId = fixtureBoard.id) => ({ ...initial, token, originBoardId, source: { ...initial.source, runId } });
      const button = (id, action) => h('button', { 'data-testid': id, onClick: action }, id);
      return h(React.Fragment, null,
        h('nav', null,
          button('fixture-load-timeline', () => releaseTimeline(fixtureTimeline)),
          button('fixture-load-capabilities', () => releaseCapabilities({ available: false, ffmpeg: false, ffprobe: false, formats: {}, fps: 24, limits: { maxClips: 12, maxClipSeconds: 60, maxTimelineSeconds: 180, maxSourceBytes: 67108864 } })),
          button('fixture-board-mismatch', () => setIntent(next('mismatch', 'handoff-a', 'other-board'))),
          button('fixture-new-b', () => setIntent(next('new-b', 'handoff-b'))),
          button('fixture-remove-b', () => setRuns(fixtureRuns.filter(run => run.id !== 'handoff-b'))),
          button('fixture-refresh', () => setRuns(structuredClone(fixtureRuns))),
          button('fixture-replay-initial', () => setIntent(initial)),
          button('fixture-late-b', () => setIntent(next('late-b', 'handoff-b')))
        ),
        h('pre', { 'data-testid': 'fixture-state' }, JSON.stringify({ consumed, requests, token: intent?.token })),
        h(TimelineEditor, { board: fixtureBoard, runs, exports: [], requestJson,
          handoffIntent: intent, onHandoffConsumed: consume,
          onSaveArtifact: () => Promise.reject(new Error('Unexpected implicit save')),
          onExportJob: () => { throw new Error('Unexpected implicit export'); }, onClose: () => {} })
      );
    }
    createRoot(document.getElementById('root')).render(h(Harness));
  `;
  const output = await build({
    configFile: false, root, logLevel: 'silent', esbuild: { jsx: 'automatic' }, define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'in-memory-handoff-fixture', resolveId(id) { if (id === 'virtual:handoff-fixture' || id.endsWith('/virtual:handoff-fixture')) return '\0handoff-fixture'; }, load(id) { if (id === '\0handoff-fixture') return entry; } }],
    build: { write: false, minify: false, lib: { entry: 'virtual:handoff-fixture', name: 'HandoffFixture', formats: ['iife'] } },
  });
  const outputs = Array.isArray(output) ? output.flatMap(item => item.output) : 'output' in output ? output.output : [];
  const script = outputs.find(item => item.type === 'chunk');
  assert.ok(script && script.type === 'chunk');
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setContent('<!doctype html><html><body><main id="root"></main></body></html>');
    await page.addScriptTag({ content: script.code });
    const state = async () => JSON.parse(await page.getByTestId('fixture-state').innerText()) as { consumed: string[]; requests: { endpoint: string; method: string }[] };
    const waitFor = async (probe: () => Promise<boolean>, label: string) => {
      const end = Date.now() + 10000;
      while (Date.now() < end) { if (await probe().catch(() => false)) return; await page.waitForTimeout(50); }
      throw new Error(`Timed out: ${label}`);
    };
    await waitFor(async () => (await state()).consumed.includes('initial'), 'initial intent is consumed before delayed timeline/capabilities');
    await page.getByTestId('fixture-load-timeline').click();
    const picker = page.getByTestId('timeline-source');
    await waitFor(async () => await picker.inputValue() === 'handoff-a:archived-motion:1', 'initial exact source survives delayed timeline');
    const clipId = timeline.clips[0].id;
    const trim = page.getByTestId(`timeline-in-${clipId}`);
    await trim.fill('0.4');
    await page.getByTestId('timeline-format').selectOption('portrait');
    await page.getByTestId('fixture-board-mismatch').click();
    await page.getByTestId('timeline-source-unavailable').waitFor();
    assert.match(await page.getByTestId('timeline-source-unavailable').innerText(), /另一張畫布/);
    assert.equal(await picker.inputValue(), 'handoff-a:archived-motion:1');
    assert.equal(await trim.inputValue(), '0.4');
    assert.equal(await page.getByTestId('timeline-format').inputValue(), 'portrait');
    await page.getByTestId('fixture-new-b').click();
    await waitFor(async () => await picker.inputValue() === 'handoff-b:archived-motion:1', 'newer valid intent replaces unavailable exact selection');
    await page.getByTestId('fixture-remove-b').click();
    await page.getByTestId('timeline-source-unavailable').waitFor();
    assert.equal(await picker.inputValue(), 'handoff-b:archived-motion:1', 'missing exact source does not fallback');
    await picker.selectOption('handoff-a:archived-motion:0');
    await page.getByTestId('fixture-load-capabilities').click();
    await page.getByTestId('fixture-refresh').click();
    await page.getByTestId('fixture-replay-initial').click();
    await page.getByTestId('fixture-late-b').click();
    await waitFor(async () => (await state()).consumed.includes('late-b'), 'late intent consumed after manual selection');
    assert.equal(await picker.inputValue(), 'handoff-a:archived-motion:0', 'manual source choice wins over delayed capability, runs refresh and stale/new intents');
    assert.equal(await trim.inputValue(), '0.4', 'intent changes preserve unsaved trim');
    assert.equal(await page.getByTestId('timeline-format').inputValue(), 'portrait', 'intent changes preserve unsaved format');
    const observed = await state();
    for (const token of ['initial', 'mismatch', 'new-b', 'late-b']) assert.equal(observed.consumed.filter(value => value === token).length, 1, `${token} consumed once`);
    assert.deepEqual(observed.requests.map(request => request.method), ['GET', 'GET'], 'intents perform only initial timeline/capability reads');
    assert.deepEqual(errors, [], 'actual component emits no runtime error');
  } catch (error) {
    console.error(JSON.stringify({ handoffIntentFixture: errors, body: (await page.locator('body').innerText()).slice(-2500) }));
    throw error;
  } finally { await page.close(); }
}
