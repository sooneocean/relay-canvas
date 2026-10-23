import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'vite';
import type { Browser } from '@playwright/test';

/**
 * Test-only UI boundary verifier. The fixture is bundled in memory by Vite,
 * renders the real helper/component, and does not call an app endpoint.
 */
export async function verifyRelayUiBoundaries(browser: Browser, root: string): Promise<void> {
  const appPath = path.join(root, 'src/ui/App.tsx');
  const comparePath = path.join(root, 'src/ui/RunCompare.tsx');
  const entry = `
    import React, { useCallback, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import RunCompare from ${JSON.stringify(comparePath)};
    import { buildRelayFlow } from ${JSON.stringify(appPath)};

    const h = React.createElement;
    const boardId = 'fixture-board';
    const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const videoData = 'data:video/mp4;base64,AAAA';
    const pendingSaves = new Map();
    const saveCalls = [];

    function fail(message) { throw new Error('relay UI boundary: ' + message); }
    function equal(actual, expected, message) { if (actual !== expected) fail(message + ' (expected ' + expected + ', got ' + actual + ')'); }
    function deepEqual(actual, expected, message) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(message);
    }
    function flowNode(id, kind = 'note') {
      return { id, type: 'canvas', position: { x: 0, y: 0 }, data: { kind, label: id } };
    }
    function flowEdge(id) {
      return { id, source: 'node-0', target: 'node-1', type: 'smoothstep', animated: false };
    }
    function relayProvider(overrides = {}) {
      return { id: 'relay-profile', name: 'Fixture relay', protocol: 'relay', baseUrl: 'https://relay.fixture.example/v1', keyEnv: 'RELAY_KEY_V06_FIXTURE', imageModel: 'relay-image-fixture', videoModel: 'relay-video-fixture', ...overrides };
    }
    function verifyPureAppend() {
      const nodes = Array.from({ length: 98 }, (_, index) => flowNode('node-' + index));
      const edges = Array.from({ length: 199 }, (_, index) => flowEdge('edge-' + index));
      const nodeRefs = nodes.slice();
      const edgeRefs = edges.slice();
      const fakeUi = { selection: 'keep-selection', dirty: true, nodes, edges };
      const fakeUiSnapshot = { selection: fakeUi.selection, dirty: fakeUi.dirty };
      const appended = buildRelayFlow(nodes, edges, relayProvider(), prefix => prefix + '-new');
      if (!appended) fail('98/199 append unexpectedly refused');
      equal(appended.nodes.length, 100, '98 nodes must append two nodes');
      equal(appended.edges.length, 200, '199 edges must append one edge');
      equal(appended.nodes[0], nodeRefs[0], 'success must preserve original node object references');
      equal(appended.edges[0], edgeRefs[0], 'success must preserve original edge object references');
      equal(fakeUi.selection, fakeUiSnapshot.selection, 'success must preserve selection');
      equal(fakeUi.dirty, fakeUiSnapshot.dirty, 'success must preserve dirty state');
      equal(appended.nodes[98].data.providerId, 'relay-profile', 'image profile must be selected profile');
      equal(appended.nodes[98].data.model, 'relay-image-fixture', 'image model must be selected model');
      deepEqual(appended.nodes[98].data.params, {}, 'image params must start empty');
      equal(appended.nodes[99].data.providerId, 'relay-profile', 'video profile must be selected profile');
      equal(appended.nodes[99].data.model, 'relay-video-fixture', 'video model must be selected model');
      deepEqual(appended.nodes[99].data.params, {}, 'video params must start empty');
      equal(appended.nodes[99].data.referenceField, 'image_url', 'video reference field must be fixed');
      equal(appended.edges[199].source, appended.imageNodeId, 'relay edge source must be image node');
      equal(appended.edges[199].target, appended.videoNodeId, 'relay edge target must be video node');

      const tooManyNodes = Array.from({ length: 99 }, (_, index) => flowNode('node-' + index));
      const tooManyEdges = Array.from({ length: 200 }, (_, index) => flowEdge('edge-' + index));
      const failureInputs = { nodes: tooManyNodes, edges: tooManyEdges, selection: 'failure-selection', dirty: false };
      const failureNodeRefs = tooManyNodes.slice();
      const failureEdgeRefs = tooManyEdges.slice();
      equal(buildRelayFlow(tooManyNodes, tooManyEdges, relayProvider(), prefix => prefix + '-new'), undefined, '99/200 append must refuse');
      equal(tooManyNodes[0], failureNodeRefs[0], 'capacity refusal must preserve node references');
      equal(tooManyEdges[0], failureEdgeRefs[0], 'capacity refusal must preserve edge references');
      equal(failureInputs.selection, 'failure-selection', 'capacity refusal must preserve fake selection');
      equal(failureInputs.dirty, false, 'capacity refusal must preserve fake dirty state');
      equal(buildRelayFlow(nodes, edges, relayProvider({ imageModel: '' }), prefix => prefix + '-new'), undefined, 'missing model must refuse');
      equal(buildRelayFlow(nodes, edges, relayProvider({ protocol: 'openai' }), prefix => prefix + '-new'), undefined, 'non-relay provider must refuse');
      equal(buildRelayFlow(nodes, edges, relayProvider(), prefix => prefix === 'image' ? 'node-0' : prefix + '-new'), undefined, 'ID collision must refuse atomically');
      equal(nodes.length, 98, 'failure checks must not mutate node input');
      equal(edges.length, 199, 'failure checks must not mutate edge input');
      return { passed: true, maxNodes: appended.nodes.length, maxEdges: appended.edges.length };
    }

    function imageUrl(runId, index) { return imageData + '#' + runId + '-image-' + index; }
    function videoUrl(runId) { return videoData + '#' + runId + '-video-0'; }
    function makeBoard() {
      return {
        schemaVersion: 1,
        id: boardId,
        name: 'Relay UI boundary fixture',
        revision: 1,
        nodes: [
          { id: 'node-image', type: 'canvas', position: { x: 0, y: 0 }, data: { kind: 'image', label: 'Image', providerId: 'relay-profile', model: 'relay-image-fixture', prompt: 'image prompt', params: {} } },
          { id: 'node-video', type: 'canvas', position: { x: 300, y: 0 }, data: { kind: 'video', label: 'Video', providerId: 'relay-profile', model: 'relay-video-fixture', prompt: 'video prompt', params: {}, referenceField: 'image_url' } },
        ],
        edges: [{ id: 'edge-image-video', source: 'node-image', target: 'node-video' }],
        viewport: { x: 0, y: 0, zoom: 1 },
      };
    }
    function makeRun(id, revision) {
      const snapshot = makeBoard();
      return {
        id,
        boardId,
        revision,
        operationId: 'operation-' + id,
        status: 'succeeded',
        startedAt: '2026-10-23T00:00:0' + revision + '.000Z',
        finishedAt: '2026-10-23T00:00:1' + revision + '.000Z',
        snapshot,
        providers: [],
        order: ['node-image', 'node-video'],
        results: {
          'node-image': { nodeId: 'node-image', status: 'succeeded', artifacts: [
            { kind: 'image', url: imageUrl(id, 0), mimeType: 'image/png' },
            { kind: 'image', url: imageUrl(id, 1), mimeType: 'image/png' },
          ] },
          'node-video': { nodeId: 'node-video', status: 'succeeded', artifacts: [
            { kind: 'video', url: videoUrl(id), mimeType: 'video/mp4' },
          ] },
        },
      };
    }
    function canonical(run) {
      return {
        ...run,
        results: Object.fromEntries(Object.entries(run.results).map(([nodeId, result]) => [nodeId, { ...result, artifacts: result.artifacts.map(artifact => ({ kind: artifact.kind, url: artifact.url, demo: artifact.demo })) }])),
      };
    }
    const initialRuns = [makeRun('run-a', 1), makeRun('run-b', 2), makeRun('run-c', 3)];
    function compare(leftId, rightId, runs) {
      const left = runs.find(run => run.id === leftId);
      const right = runs.find(run => run.id === rightId);
      return { boardId, left: canonical(left), right: canonical(right), differences: [{ nodeId: 'node-image', fields: ['artifacts'] }, { nodeId: 'node-video', fields: ['artifacts'] }] };
    }
    function savedArtifact(runId, nodeId, artifactIndex) {
      const extension = nodeId === 'node-video' ? 'b'.repeat(64) : 'a'.repeat(64);
      const kind = nodeId === 'node-video' ? 'video' : 'image';
      return { kind, url: nodeId === 'node-video' ? videoUrl(runId) : imageUrl(runId, artifactIndex), mimeType: kind === 'video' ? 'video/mp4' : 'image/png', localUrl: '/api/media/' + extension };
    }
    function updateArtifact(runs, runId, nodeId, artifactIndex, updater) {
      return runs.map(run => run.id !== runId ? run : ({ ...run, results: { ...run.results, [nodeId]: { ...run.results[nodeId], artifacts: run.results[nodeId].artifacts.map((artifact, index) => index === artifactIndex ? updater(artifact) : artifact) } } }));
    }

    const pureResult = verifyPureAppend();

    function Harness() {
      const [runs, setRuns] = useState(initialRuns);
      const [saveStates, setSaveStates] = useState({});
      const requestJson = useCallback(async endpoint => {
        const query = new URL('http://fixture.invalid' + endpoint).searchParams;
        return compare(query.get('left'), query.get('right'), initialRuns);
      }, []);
      const onSaveAsset = useCallback((runId, nodeId, artifactIndex) => {
        const key = runId + ':' + nodeId + ':' + artifactIndex;
        const existing = pendingSaves.get(key);
        if (existing) return existing.promise;
        saveCalls.push(key);
        setSaveStates(current => ({ ...current, [key]: { status: 'saving' } }));
        let resolveRaw;
        const raw = new Promise(resolve => { resolveRaw = resolve; });
        const promise = raw.then(() => {
          const artifact = savedArtifact(runId, nodeId, artifactIndex);
          setRuns(current => updateArtifact(current, runId, nodeId, artifactIndex, currentArtifact => ({ ...currentArtifact, ...artifact })));
          setSaveStates(current => ({ ...current, [key]: { status: 'saved' } }));
          pendingSaves.delete(key);
          return artifact;
        });
        pendingSaves.set(key, { promise, resolve: resolveRaw, key });
        return promise;
      }, []);
      const releaseSaves = useCallback(() => {
        [...pendingSaves.values()].forEach(entry => entry.resolve());
      }, []);
      const mutateRight = useCallback((kind) => {
        if (kind === 'restore') { setRuns(current => current.map(run => run.id === 'run-b' ? makeRun('run-b', 2) : run)); return; }
        if (kind === 'drift') { setRuns(current => updateArtifact(current, 'run-b', 'node-image', 1, artifact => ({ ...artifact, url: artifact.url + '-drifted' }))); return; }
        if (kind === 'terminal') { setRuns(current => current.map(run => run.id === 'run-b' ? { ...run, status: 'running' } : run)); return; }
        if (kind === 'remove') { setRuns(current => current.map(run => run.id === 'run-b' ? { ...run, results: { ...run.results, 'node-image': { ...run.results['node-image'], artifacts: run.results['node-image'].artifacts.slice(0, 1) } } } : run)); }
      }, []);
      const state = {
        saveCalls: saveCalls.slice(),
        pending: [...pendingSaves.keys()],
        runs: runs.map(run => ({ id: run.id, status: run.status, image: run.results['node-image'].artifacts.map(artifact => ({ url: artifact.url, localUrl: artifact.localUrl })), video: run.results['node-video'].artifacts.map(artifact => ({ url: artifact.url, localUrl: artifact.localUrl })) })),
      };
      const button = (id, onClick) => h('button', { type: 'button', 'data-testid': id, onClick }, id);
      return h(React.Fragment, null,
        h('pre', { 'data-testid': 'fixture-pure' }, JSON.stringify(pureResult)),
        h('nav', null,
          button('fixture-release-saves', releaseSaves),
          button('fixture-right-drift', () => mutateRight('drift')),
          button('fixture-right-terminal', () => mutateRight('terminal')),
          button('fixture-right-remove-index1', () => mutateRight('remove')),
          button('fixture-right-restore', () => mutateRight('restore'))
        ),
        h('pre', { 'data-testid': 'fixture-state' }, JSON.stringify(state)),
        h(RunCompare, { boardId, runs, requestJson, assetSaveStates: saveStates, onSaveAsset, onClose: () => {}, onUseInTimeline: () => true })
      );
    }
    createRoot(document.getElementById('root')).render(h(Harness));
  `;
  const output = await build({
    configFile: false,
    root,
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'in-memory-relay-ui-boundaries',
      resolveId(id) {
        if (id === 'virtual:relay-ui-boundaries' || id.endsWith('/virtual:relay-ui-boundaries')) return '\0relay-ui-boundaries';
      },
      load(id) {
        if (id === '\0relay-ui-boundaries') return entry;
      },
    }],
    build: { write: false, minify: false, lib: { entry: 'virtual:relay-ui-boundaries', name: 'RelayUiBoundaries', formats: ['iife'] } },
  });
  const outputs = Array.isArray(output) ? output.flatMap(item => item.output) : 'output' in output ? output.output : [];
  const script = outputs.find(item => item.type === 'chunk');
  assert.ok(script && script.type === 'chunk');

  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const state = async () => JSON.parse(await page.getByTestId('fixture-state').innerText()) as { saveCalls: string[]; pending: string[]; runs: { id: string; status: string; image: { url: string; localUrl?: string }[]; video: { url: string; localUrl?: string }[] }[] };
  const waitFor = async (probe: () => Promise<boolean>, label: string) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if (await probe().catch(() => false)) return;
      await page.waitForTimeout(50);
    }
    throw new Error('Timed out: ' + label);
  };
  try {
    await page.setContent('<!doctype html><html><body><main id="root"></main></body></html>');
    await page.addScriptTag({ content: script.code });
    await page.getByTestId('fixture-pure').waitFor();
    assert.deepEqual(JSON.parse(await page.getByTestId('fixture-pure').innerText()), { passed: true, maxNodes: 100, maxEdges: 200 });
    await waitFor(async () => await page.getByTestId('compare-save-left-1').isVisible(), 'RunCompare index 1 save control');
    assert.equal(await page.getByTestId('compare-left-run').inputValue(), 'run-a');
    assert.equal(await page.getByTestId('compare-right-run').inputValue(), 'run-b');
    assert.equal(await page.getByTestId('compare-node').inputValue(), 'node-image');

    await page.getByTestId('compare-save-left-1').click();
    await waitFor(async () => (await state()).pending.includes('run-a:node-image:1'), 'full-triple index 1 save pending');
    assert.deepEqual((await state()).saveCalls.filter(key => key === 'run-a:node-image:1'), ['run-a:node-image:1']);
    assert.equal(await page.getByTestId('compare-download-left-0').count(), 0, 'index 0 must remain unsaved');
    await page.getByTestId('fixture-release-saves').click();
    await waitFor(async () => await page.getByTestId('compare-download-left-1').count() === 1, 'index 1 saved download');
    assert.match(await page.getByTestId('compare-download-left-1').getAttribute('href') ?? '', /^\/api\/media\/[a-f0-9]{64}$/);

    await page.getByTestId('fixture-right-drift').click();
    await waitFor(async () => await page.getByTestId('compare-save-right-1').isDisabled(), 'drifted source disables save');
    assert.match(await page.getByText('來源內容已變更').first().innerText(), /來源內容已變更/);
    await page.getByTestId('fixture-right-restore').click();
    await page.getByTestId('compare-right-run').selectOption('run-b');
    await waitFor(async () => await page.getByTestId('compare-right-run').inputValue() === 'run-b' && !(await page.getByTestId('compare-save-right-1').isDisabled()), 'restore re-enables save');
    await page.getByTestId('fixture-right-terminal').click();
    await waitFor(async () => await page.getByTestId('compare-save-right-1').isDisabled(), 'non-terminal source disables save');
    assert.match(await page.getByText('來源 run 狀態為執行中').first().innerText(), /來源 run 狀態為執行中/);
    await page.getByTestId('fixture-right-restore').click();
    await page.getByTestId('compare-right-run').selectOption('run-b');
    await waitFor(async () => await page.getByTestId('compare-right-run').inputValue() === 'run-b' && !(await page.getByTestId('compare-save-right-1').isDisabled()), 'terminal restore re-enables save');
    await page.getByTestId('fixture-right-remove-index1').click();
    await waitFor(async () => await page.getByTestId('compare-save-right-1').isDisabled(), 'removed index disables save');
    assert.match(await page.getByText('這個輸出已不存在').first().innerText(), /這個輸出已不存在/);
    await page.getByTestId('fixture-right-restore').click();
    await page.getByTestId('compare-right-run').selectOption('run-b');
    await waitFor(async () => await page.getByTestId('compare-right-run').inputValue() === 'run-b' && !(await page.getByTestId('compare-save-right-1').isDisabled()), 'removed index restore re-enables save');

    const rapidRight = page.getByTestId('compare-save-right-1');
    await rapidRight.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
    await waitFor(async () => (await state()).pending.includes('run-b:node-image:1'), 'rapid duplicate save pending');
    assert.equal((await state()).saveCalls.filter(key => key === 'run-b:node-image:1').length, 1, 'identical full triple requests coalesce');
    await page.getByTestId('fixture-release-saves').click();
    await waitFor(async () => await page.getByTestId('compare-download-right-1').count() === 1, 'coalesced right save completes');

    await page.getByTestId('compare-left-run').selectOption('run-c');
    await waitFor(async () => await page.getByTestId('compare-left-run').inputValue() === 'run-c' && await page.getByTestId('compare-save-left-1').isVisible(), 'select run C');
    await page.getByTestId('compare-save-left-1').click();
    await waitFor(async () => (await state()).pending.includes('run-c:node-image:1'), 'held async save for run C');
    await page.getByTestId('compare-node').selectOption('node-video');
    await page.getByTestId('compare-left-run').selectOption('run-a');
    await waitFor(async () => await page.getByTestId('compare-left-run').inputValue() === 'run-a' && await page.getByTestId('compare-node').inputValue() === 'node-video', 'switch selected run and node before response');
    await page.getByTestId('fixture-release-saves').click();
    await waitFor(async () => !(await state()).pending.includes('run-c:node-image:1'), 'late save response settles');
    const afterLate = await state();
    const runC = afterLate.runs.find(run => run.id === 'run-c');
    const runA = afterLate.runs.find(run => run.id === 'run-a');
    assert.ok(runC?.image[1].localUrl, 'late response must save its original run/index');
    assert.equal(runA?.video[0].localUrl, undefined, 'late response must not overwrite selected run/node');
    assert.equal(await page.getByTestId('compare-left-run').inputValue(), 'run-a', 'selected run remains after late response');
    assert.equal(await page.getByTestId('compare-node').inputValue(), 'node-video', 'selected node remains after late response');
    assert.deepEqual(errors, [], 'actual RunCompare fixture emits no runtime errors');
  } catch (error) {
    console.error(JSON.stringify({ relayUiBoundaryErrors: errors, body: (await page.locator('body').innerText()).slice(-3500) }));
    throw error;
  } finally {
    await page.close();
  }
}
