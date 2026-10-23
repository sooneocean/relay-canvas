import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import type { Browser, Request } from '@playwright/test';
import { providers, starterBoard } from '../src/shared/defaults.js';
import type { AppState, Artifact, Board, Run, Timeline } from '../src/shared/types.js';

const boardId = 'source-browser';
const nodeId = 'historical-video';
const key = (runId: string, index = 0) => `${runId}:${nodeId}:${index}`;

/** Private startup fixture only: no paid generation or production fixture API. */
export function sourceBrowserFixtures(): { board: Board; runs: Run[] } {
  const board = starterBoard(boardId, 'Source library acceptance');
  board.revision = 12;
  board.nodes = board.nodes.filter(node => node.id !== 'motion');
  board.edges = board.edges.filter(edge => edge.target !== 'motion');
  const makeRun = (id: string, day: number, label: string, artifacts: Artifact[]): Run => {
    const snapshot = starterBoard(boardId, board.name);
    snapshot.revision = 1;
    const video = snapshot.nodes.find(node => node.id === 'motion')!;
    video.id = nodeId;
    video.data = { ...video.data, label, prompt: `Copper skyline sequence ${id}`, model: `fixture-model-${id}` };
    snapshot.edges.find(edge => edge.target === 'motion')!.target = nodeId;
    const startedAt = `2026-02-${String(day).padStart(2, '0')}T10:30:00Z`;
    return { id, boardId, revision: 1, operationId: id, status: 'succeeded', startedAt, finishedAt: startedAt,
      snapshot, providers: structuredClone(providers), order: [nodeId],
      results: { [nodeId]: { nodeId, status: 'succeeded', artifacts } } };
  };
  const runs = Array.from({ length: 6 }, (_, index) => makeRun(`source-${index}`, 20 - index, `Sunrise study ${index}`, [0, 1].map(() => ({ kind: 'video', url: '/demo-motion.mp4', demo: true }))));
  runs.push(makeRun('source-remote', 21, 'Remote ocean take', [{ kind: 'video', url: '/demo-motion.mp4?remote-source=1' }]));
  runs.push(makeRun('source-broken', 22, 'Unavailable preview take', [{ kind: 'video', url: '/source-preview-broken.mp4' }]));
  const missingSnapshot = makeRun('source-no-snapshot', 14, 'Deleted snapshot fallback', [{ kind: 'video', url: '/demo-motion.mp4', demo: true }]);
  missingSnapshot.snapshot.nodes = missingSnapshot.snapshot.nodes.filter(node => node.id !== nodeId);
  missingSnapshot.snapshot.edges = [];
  runs.push(missingSnapshot);
  const failedRun = makeRun('source-failed-run', 23, 'Must never appear', [{ kind: 'video', url: '/demo-motion.mp4', demo: true }]);
  failedRun.status = 'failed'; runs.push(failedRun);
  const failedResult = makeRun('source-failed-result', 24, 'Must never appear', [{ kind: 'video', url: '/demo-motion.mp4', demo: true }]);
  failedResult.results[nodeId].status = 'failed'; runs.push(failedResult);
  return { board, runs };
}

export async function verifySourceBrowser(browser: Browser, root: string, origin: string,
  api: <T>(endpoint: string, method?: string, body?: unknown) => Promise<T>) {
  // Seed real locally saved artifacts before the read-only browser contract.
  for (const index of [0, 1]) await api(`/api/runs/source-0/artifacts/${nodeId}/${index}/save`, 'POST');
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors: string[] = [];
  const mutations: string[] = [];
  const mediaRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    // The one intentionally missing preview has its own exact request path;
    // unrelated media/server failures remain fatal.
    if (message.type() === 'error' && !message.location().url.includes('/source-preview-broken.mp4')) errors.push(`${message.text()} ${message.location().url}`);
  });
  const watch = (request: Request) => {
    const endpoint = new URL(request.url()).pathname;
    if (endpoint.startsWith('/api/') && (request.method() !== 'GET' || endpoint.endsWith('/info'))) mutations.push(`${request.method()} ${endpoint}`);
    if (endpoint.endsWith('.mp4') || endpoint.startsWith('/api/media/')) mediaRequests.push(request.url());
  };
  page.on('request', watch);
  const until = async <T>(probe: () => Promise<T>, predicate: (value: T) => boolean, label: string) => {
    const end = Date.now() + 15000;
    do { const value = await probe(); if (predicate(value)) return value; await page.waitForTimeout(50); } while (Date.now() < end);
    throw new Error(`Timed out: source browser ${label}`);
  };
  const dialog = page.getByTestId('timeline-dialog');
  const cards = () => dialog.locator('[data-testid^="timeline-source-card-"]');
  const search = () => dialog.getByTestId('timeline-source-search');
  const selected = () => dialog.getByTestId('timeline-source-selected').getAttribute('data-source-key');
  const choose = async (runId: string, index = 0) => {
    await search().fill(runId);
    await dialog.getByTestId(`timeline-source-card-${key(runId, index)}`).locator('.timeline-source-card-select').click();
    assert.equal(await selected(), key(runId, index));
  };
  const preview = () => dialog.getByTestId('timeline-source-preview-video');
  try {
    await page.route('**/source-preview-broken.mp4', route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Controlled absent preview' }));
    await page.goto(origin);
    await page.getByLabel(`project-card-${boardId}`, { exact: true }).click();
    await page.getByTestId('timeline-open').click();
    await dialog.waitFor();
    await until(() => cards().count(), count => count === 9, 'bounded first page');
    const before = await api<AppState>('/api/state');
    const beforeTimeline = await api<Timeline>(`/api/boards/${boardId}/timeline`);
    const firstPage = await cards().evaluateAll(elements => elements.map(element => element.getAttribute('data-source-key')));
    assert.equal(firstPage[0], key('source-broken'), 'newest source first');
    assert.equal(await cards().filter({ hasText: 'Must never appear' }).count(), 0, 'failed runs and results are excluded');
    assert.ok(firstPage.includes(key('source-0', 1)), 'duplicate URL outputs retain distinct cards');
    assert.ok(await dialog.getByTestId(`timeline-source-card-${key('source-0', 1)}`).locator('.timeline-source-card-select').getAttribute('aria-label'), 'full source identity is accessible');
    assert.match(await dialog.getByTestId(`timeline-source-card-${key('source-0', 1)}`).innerText(), /2/);
    // Card thumbnails are limited to the visible page; remote-only cards do not
    // start their videos until the explicit Preview action.
    assert.equal(mediaRequests.some(url => url.includes('remote-source=1') || url.includes('source-preview-broken.mp4')), false);
    assert.ok(await dialog.locator('.video-thumbnail').count() <= 9);
    await dialog.getByTestId('timeline-source-next').click();
    await until(() => cards().count(), count => count === 6, 'second page');
    const secondPage = await cards().evaluateAll(elements => elements.map(element => element.getAttribute('data-source-key')));
    assert.equal(new Set([...firstPage, ...secondPage]).size, 15, 'pages cover all exact sources without duplicates');
    assert.equal(await dialog.getByTestId('timeline-source-next').isDisabled(), true);
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
    await refreshed;
    assert.deepEqual(await cards().evaluateAll(elements => elements.map(element => element.getAttribute('data-source-key'))), secondPage, 'refresh retains page');
    await dialog.getByTestId('timeline-source-prev').click();
    await search().fill('copper skyline');
    assert.equal(await cards().count(), 9, 'snapshot prompt is searchable');
    await search().fill('Sunrise study 3');
    assert.equal(await cards().count(), 2, 'snapshot label is searchable');
    await search().fill('fixture-model-source-4');
    assert.equal(await cards().count(), 2, 'snapshot model is searchable');
    await page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
    assert.equal(await search().inputValue(), 'fixture-model-source-4', 'refresh retains query');
    assert.equal(await cards().count(), 2);
    await search().fill('historical-video');
    assert.equal(await cards().count(), 9, 'deleted node ID is searchable');
    await search().fill('2026-02-20');
    assert.equal(await cards().count(), 2, 'stable source date is searchable');
    await search().fill('source-no-snapshot');
    assert.equal(await cards().count(), 1);
    assert.match(await cards().first().innerText(), /historical-video/, 'missing snapshot node falls back to exact node ID');
    await choose('source-0', 1);
    await search().fill('nothing matches this query');
    assert.equal(await cards().count(), 0);
    assert.equal(await selected(), key('source-0', 1), 'filter cannot change exact selected output');
    assert.equal(await dialog.getByTestId('timeline-add').isEnabled(), true, 'filtered selection keeps explicit Add discoverable');
    await dialog.getByTestId('timeline-source-reset').click();
    await until(() => cards().count(), count => count === 9, 'reset returns first page');
    await choose('source-0', 0);
    await search().fill('source-0');
    const keyboardCard = dialog.getByTestId(`timeline-source-card-${key('source-0', 1)}`).locator('.timeline-source-card-select');
    await keyboardCard.focus(); await page.keyboard.press('Enter');
    assert.equal(await selected(), key('source-0', 1), 'keyboard selects the exact output');
    assert.equal(await keyboardCard.getAttribute('aria-pressed'), 'true');
    await dialog.getByTestId('timeline-source-preview').click();
    await until(() => preview().evaluate(element => (element as HTMLVideoElement).readyState), value => value >= 2, 'selected local video ready');
    assert.equal(await preview().evaluate(element => (element as HTMLVideoElement).paused), true, 'preview does not autoplay');
    await preview().focus(); await page.keyboard.press('Space');
    await until(() => preview().evaluate(element => (element as HTMLVideoElement).currentTime), value => value > 0.15, 'native keyboard preview playback advances');
    await page.keyboard.press('Space');
    assert.equal(await preview().evaluate(element => (element as HTMLVideoElement).paused), true, 'native keyboard pauses');
    const sourceSeek = dialog.getByTestId('timeline-source-preview-seek');
    // Media timeupdate is asynchronous. Wait for the displayed controlled
    // range to catch up before Home; Home on an already-zero range emits no
    // input/change event even if the video has advanced in the meantime.
    await until(async () => Math.abs(Number(await sourceSeek.inputValue()) - await preview().evaluate(element => (element as HTMLVideoElement).currentTime)), difference => difference <= 0.051, 'paused range reflects actual media time');
    await sourceSeek.focus(); await page.keyboard.press('Home');
    await until(() => preview().evaluate(element => (element as HTMLVideoElement).currentTime), value => value <= 0.02, 'keyboard Home actually seeks to source start');
    await page.keyboard.press('ArrowRight');
    await until(() => preview().evaluate(element => (element as HTMLVideoElement).currentTime), value => value >= 0.09 && value <= 0.25, 'keyboard range seeks actual media after Home');
    assert.equal(await preview().evaluate(element => (element as HTMLVideoElement).paused), true, 'seeking does not start playback');
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.screenshot({ path: path.join(root, 'work', 'source-browser-preview.png'), fullPage: true });
    await page.setViewportSize({ width: 1600, height: 1000 });
    const oldPreview = await preview().elementHandle(); assert.ok(oldPreview);
    await choose('source-remote');
    await until(() => oldPreview.evaluate(element => (element as HTMLVideoElement).paused && !element.getAttribute('src')), value => value, 'source change pauses and unloads prior video');
    assert.equal(await preview().count(), 0, 'new selection requires an explicit Preview');
    await dialog.getByTestId('timeline-source-preview').click();
    await until(() => preview().evaluate(element => (element as HTMLVideoElement).readyState), value => value >= 2, 'remote-only source actually previews without saving');
    assert.match(await preview().getAttribute('src') ?? '', /remote-source=1/);
    await search().fill('no matches while previewing');
    assert.equal(await preview().count(), 1, 'selected off-page preview stays visible with its identity');
    assert.equal(await selected(), key('source-remote'));
    const remotePreview = await preview().elementHandle(); assert.ok(remotePreview);
    await dialog.getByTestId('timeline-source-preview-close').click();
    await until(() => remotePreview.evaluate(element => (element as HTMLVideoElement).paused && !element.getAttribute('src')), value => value, 'explicit preview close unloads');
    assert.equal(await preview().count(), 0);
    assert.deepEqual(mutations, [], 'search/page/select/preview trigger no save/info/timeline/export/generation request');
    const afterBrowse = await api<AppState>('/api/state');
    assert.deepEqual(afterBrowse.boards, before.boards);
    assert.deepEqual(afterBrowse.runs, before.runs);
    assert.deepEqual(await api<Timeline>(`/api/boards/${boardId}/timeline`), beforeTimeline);

    // Explicit Add remains the real server-backed operation, preserving index1.
    await choose('source-0', 1);
    await dialog.getByTestId('timeline-add').click();
    await until(() => dialog.locator('[data-testid^="timeline-clip-"]').count(), count => count === 1, 'explicit Add');
    await dialog.getByTestId('timeline-save').click();
    const saved = await until(() => api<Timeline>(`/api/boards/${boardId}/timeline`), timeline => timeline.clips.length === 1, 'exact backend read-back');
    assert.deepEqual(saved.clips[0].source, { runId: 'source-0', nodeId, artifactIndex: 1 });
    const clipId = saved.clips[0].id;
    await dialog.getByTestId(`timeline-in-${clipId}`).fill('0.25');
    await dialog.getByTestId('timeline-format').selectOption('portrait');
    await choose('source-broken');
    await dialog.getByTestId('timeline-source-preview').click();
    await until(() => dialog.innerText(), text => /預覽.*失敗|無法.*預覽|無法.*播放/.test(text), 'controlled preview error');
    assert.equal(await dialog.getByTestId(`timeline-in-${clipId}`).inputValue(), '0.25', 'preview failure preserves trim draft');
    assert.equal(await dialog.getByTestId('timeline-format').inputValue(), 'portrait');
    assert.equal(await selected(), key('source-broken'));
    await choose('source-remote');
    await dialog.getByTestId('timeline-source-preview').click();
    await until(() => preview().evaluate(element => (element as HTMLVideoElement).readyState), value => value >= 2, 'preview recovers');
    // Removing the selected source in a controlled catalog response must unload
    // it without selecting a different source or mutating the dirty timeline.
    const livePreview = await preview().elementHandle(); assert.ok(livePreview);
    let removeAllSources = false;
    await page.route('**/api/state', async route => {
      const payload = await api<AppState>('/api/state');
      payload.runs = payload.runs.filter(run => removeAllSources ? run.boardId !== boardId : run.id !== 'source-remote');
      await route.fulfill({ status: 200, contentType: 'application/json', json: payload });
    });
    await dialog.getByTestId('timeline-source-unavailable').waitFor();
    assert.equal(await selected(), key('source-remote'));
    await until(() => livePreview.evaluate(element => (element as HTMLVideoElement).paused && !element.getAttribute('src')), value => value, 'disappearance unloads preview');
    assert.equal(await dialog.getByTestId(`timeline-in-${clipId}`).inputValue(), '0.25');
    removeAllSources = true;
    await until(() => dialog.locator('.timeline-source-panel > .timeline-section-heading > span').innerText(), total => total === '0', 'entire source catalog disappears');
    assert.equal(await selected(), key('source-remote'), 'last selected source retains exact unavailable summary even when catalog is empty');
    await dialog.getByTestId('timeline-source-unavailable').waitFor();
    assert.equal(await dialog.getByTestId(`timeline-in-${clipId}`).inputValue(), '0.25');
    await page.unroute('**/api/state');
    await page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
    await until(() => cards().count(), count => count === 1, 'original remote selection filter returns after catalog restoration');
    await choose('source-0', 1);
    await search().fill('');
    for (const width of [900, 1280, 1600]) {
      await page.setViewportSize({ width, height: 1000 });
      await dialog.evaluate(element => { element.scrollTop = 0; });
      const geometry = await dialog.evaluate(element => {
        const add = element.querySelector('[data-testid="timeline-add"]')!.getBoundingClientRect();
        const selected = element.querySelector('[data-testid="timeline-source-selected"]')!.getBoundingClientRect();
        return { viewport: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth, addTop: add.top, selectedTop: selected.top };
      });
      assert.equal(geometry.overflow, false, `${width}px has no page overflow`);
      assert.ok(geometry.addTop >= 0 && geometry.addTop < geometry.viewport && geometry.selectedTop < geometry.viewport, `${width}px selected source and Add are discoverable`);
      await page.screenshot({ path: path.join(root, 'work', `source-browser-${width}.png`), fullPage: true });
    }
    await dialog.getByTestId('timeline-source-preview').click();
    await until(() => preview().evaluate(element => (element as HTMLVideoElement).readyState), value => value >= 2, 'last local preview ready');
    const closingPreview = await preview().elementHandle(); assert.ok(closingPreview);
    await preview().focus(); await page.keyboard.press('Space');
    await dialog.getByTestId('timeline-close').click();
    await until(() => dialog.count(), count => count === 0, 'dirty editor saves before closing');
    await until(() => closingPreview.evaluate(element => (element as HTMLVideoElement).paused && !element.getAttribute('src')), value => value, 'dialog close unloads preview');
    assert.deepEqual(errors, [], 'no unexpected source-browser browser errors');
    writeFileSync(path.join(root, 'work', 'source-browser-report.json'), JSON.stringify({ status: 'PASS', browser: await browser.version(), sources: 15, pageSize: 9, checks: ['newest order and exact duplicate-URL identity', 'search snapshot label/prompt/model/node/date/run and missing snapshot fallback', 'pagination/reset and refresh retention', 'filtered selection and keyboard operation', 'native play/pause and actual-media keyboard range seek, remote-only preview and lifetime cleanup', 'zero implicit mutation/probe requests and unchanged board/run/timeline', 'real backend exact index1 Add/read-back', 'controlled preview error preserves dirty trim/format', 'one and all sources disappearing preserve exact unavailable selection and unload preview', '900/1280/1600 overflow and Add discoverability'], paidRequests: 0 }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(root, 'work', 'source-browser-failure.png'), fullPage: true });
    writeFileSync(path.join(root, 'work', 'source-browser-failure.json'), JSON.stringify({ error: String(error), errors, mutations, preview: await preview().evaluateAll(elements => elements.map(element => { const video = element as HTMLVideoElement; return { src: video.getAttribute('src'), time: video.currentTime, duration: video.duration, paused: video.paused }; })), seek: await dialog.getByTestId('timeline-source-preview-seek').evaluateAll(elements => elements.map(element => { const input = element as HTMLInputElement; return { value: input.value, min: input.min, max: input.max, disabled: input.disabled, focused: document.activeElement === input }; })), text: await page.locator('body').innerText() }, null, 2));
    throw error;
  } finally { await page.close(); }
}
