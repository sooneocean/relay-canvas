import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Locator } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createSourceFixture, SOURCE_MEDIA_ORIGIN, SOURCE_VIDEO_MODEL } from './v07-source-fixture.js';
import { verifyImportNetwork } from './import-network-smoke.js';
import type { AppState, Artifact, Board, ExportJob, LocalAsset, Run, RunComparison, Timeline } from '../src/shared/types.js';

const root = process.cwd(), work = path.join(root, 'work'); mkdirSync(work, { recursive: true });
const fixture = await createSourceFixture(root);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const browser = await chromium.launch({ headless: true, executablePath }).catch(async error => { await fixture.close(); throw error; });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors: string[] = [], unexpectedOutbound: string[] = [];
const imports: { url: string; bytes: number; sha256: string }[] = [];
let controlledImportFailure = false;
let client: Client | undefined;
const state = () => fixture.api<AppState>('/api/state');
const boardId = fixture.fixtureBoard.id;
const board = async () => (await state()).boards.find(item => item.id === boardId)!;
const timeline = () => page.getByTestId('timeline-dialog');
const compare = () => page.getByTestId('compare-dialog');
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.type() !== 'error') return;
  if (controlledImportFailure && message.location().url.includes(`/api/boards/${boardId}/imports?`) && /Failed to load resource/.test(message.text())) return;
  errors.push(`${message.text()} ${message.location().url}`);
});
page.on('request', request => {
  if (request.method() !== 'POST' || !request.url().startsWith(`${fixture.origin}/api/boards/${boardId}/imports?`)) return;
  const bytes = request.postDataBuffer() ?? Buffer.alloc(0);
  imports.push({ url: request.url(), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
});
async function until<T>(probe: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeout = 25000): Promise<T> {
  const end = Date.now() + timeout;
  do { const value = await probe(); if (predicate(value)) return value; await page.waitForTimeout(50); } while (Date.now() < end);
  throw new Error(`Timed out: media sources ${label}`);
}
async function selectNode(id: string) {
  const close = page.getByLabel('close-floating-composer', { exact: true });
  if (await close.isVisible()) await close.click();
  await page.locator('.react-flow__controls-fitview').click();
  await page.locator(`.react-flow__node[data-id="${id}"]`).click();
}
async function download(link: Locator, artifact: Artifact, label: string) {
  const event = page.waitForEvent('download'); await link.click(); const item = await event;
  const file = path.join(fixture.directory, label); await item.saveAs(file);
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), artifact.sha256);
}
async function importFile(filename: string): Promise<LocalAsset> {
  const previous = (await state()).localAssets?.length ?? 0;
  await page.getByTestId('import-media-input').setInputFiles(fixture.files[filename]);
  const current = await until(state, value => (value.localAssets?.length ?? 0) === previous + 1, `${filename} registry commit`);
  const asset = current.localAssets!.find(item => item.name === filename)!; assert.ok(asset);
  await until(() => page.locator(`.react-flow__node[data-id="${asset.nodeId}"]`).count(), value => value === 1, `${filename} node read-back`);
  assert.equal((await board()).nodes.find(node => node.id === asset.nodeId)!.data.assetId, asset.id);
  assert.equal(asset.artifact.sha256, fixture.fileHash(fixture.files[filename]));
  assert.ok(asset.artifact.localUrl?.startsWith('/api/media/'));
  return asset;
}
async function newRun(selected = false, external = false, imageQuantity = 0): Promise<Run> {
  const previous = (await state()).runs.map(run => run.id);
  await page.getByLabel(selected ? 'run-selected' : 'run-all', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Run remote generation?' });
  if (external) {
    await dialog.waitFor();
    assert.equal(await dialog.getByTestId('requested-image-quantity').innerText(), String(imageQuantity));
    await dialog.getByRole('button', { name: 'Confirm run', exact: true }).click();
  }
  const complete = await until(state, value => value.runs.some(run => run.boardId === boardId && !previous.includes(run.id) && ['succeeded', 'failed', 'needs_review'].includes(run.status)), 'run terminal');
  const run = complete.runs.find(run => run.boardId === boardId && !previous.includes(run.id))!;
  assert.equal(run.status, 'succeeded');
  await until(() => page.getByLabel('run-all', { exact: true }).isEnabled(), value => value, 'run UI observes terminal');
  return run;
}
try {
  const network = await verifyImportNetwork(fixture);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === fixture.origin) { await route.continue(); return; }
    const payload = fixture.payloads.get(url.href);
    if (url.origin !== SOURCE_MEDIA_ORIGIN || !payload) { unexpectedOutbound.push(url.origin); await route.abort('blockedbyclient'); return; }
    const range = request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    const headers: Record<string, string> = { 'content-type': payload.contentType, 'accept-ranges': 'bytes', 'access-control-allow-origin': fixture.origin };
    if (range) {
      const start = Number(range[1]), end = Math.min(payload.bytes.length - 1, range[2] ? Number(range[2]) : payload.bytes.length - 1);
      headers['content-range'] = `bytes ${start}-${end}/${payload.bytes.length}`;
      await route.fulfill({ status: 206, headers, body: payload.bytes.subarray(start, end + 1) });
    } else await route.fulfill({ status: 200, headers, body: payload.bytes });
  });
  await page.goto(fixture.origin);
  await page.getByLabel(`project-card-${boardId}`, { exact: true }).click();
  const png = await importFile('local-green.png');
  assert.deepEqual(fixture.submissions(), { images: 0, videos: 0, localReferences: 0 });
  assert.equal((await state()).runs.length, 0, 'import never creates a fake run');
  await page.getByTestId('local-asset-preview').waitFor();
  await until(() => page.locator('.local-asset-media img').evaluate(element => (element as HTMLImageElement).naturalWidth), value => value === 320, 'imported PNG actually decodes');
  await download(page.getByTestId('local-asset-download'), png.artifact, 'download-local.png');

  // Lose a real committed response, then retry the exact original operation/file.
  const importPattern = `**/api/boards/${boardId}/imports?*`;
  controlledImportFailure = true;
  let lost = false;
  await page.route(importPattern, async route => {
    const response = await route.fetch(); assert.ok(response.ok()); lost = true;
    await route.abort('failed');
  });
  await page.getByTestId('import-media-input').setInputFiles(fixture.files['local-movie.mp4']);
  await until(async () => lost, value => value, 'response lost after actual import commit');
  await page.getByTestId('import-media-retry').waitFor();
  const committed = (await state()).localAssets!.find(item => item.name === 'local-movie.mp4')!;
  const revisionAfterCommit = (await board()).revision, nodeCountAfterCommit = (await board()).nodes.length;
  await page.unroute(importPattern); controlledImportFailure = false;
  await page.getByTestId('import-media-retry').click();
  await until(() => page.getByTestId('import-media-retry').count(), value => value === 0, 'same-file replay recovered');
  const mp4 = (await state()).localAssets!.find(item => item.id === committed.id)!;
  assert.equal((await board()).revision, revisionAfterCommit); assert.equal((await board()).nodes.length, nodeCountAfterCommit);
  const replayRequests = imports.filter(item => new URL(item.url).searchParams.get('operationId') === mp4.id);
  assert.equal(replayRequests.length, 2); assert.deepEqual(replayRequests[0], replayRequests[1], 'response-loss retries same metadata and raw bytes');
  const webm = await importFile('local-motion.webm');
  await importFile('local-photo.jpg');

  // A held real import response must preserve edits made after submission.
  await selectNode(png.nodeId);
  let heldReady = false; let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(importPattern, async route => { const response = await route.fetch(); heldReady = true; await held; await route.fulfill({ response }); });
  try {
    await page.getByTestId('import-media-input').setInputFiles(fixture.files['local-art.webp']);
    await until(async () => heldReady, value => value, 'held import committed');
    const label = page.locator('.inspector-content input').first();
    await label.fill('Keep this newer local edit'); release();
    await until(() => page.locator('body').innerText(), value => /保留|版本|重新|較新/.test(value), 'late import preserves newer edit');
    assert.equal(await label.inputValue(), 'Keep this newer local edit');
    await until(() => page.getByLabel('reload-board', { exact: true }).count(), value => value > 0, 'import conflict offers deliberate reload');
    await page.getByLabel('reload-board', { exact: true }).click();
  } finally { release(); await page.unroute(importPattern); }
  await until(() => page.locator('.react-flow__node').count(), value => value === 5, 'deliberate reload includes committed source');
  assert.equal((await state()).localAssets!.length, 5);
  const webp = (await state()).localAssets!.find(asset => asset.name === 'local-art.webp')!;
  await selectNode(webp.nodeId);
  await until(() => page.locator('.local-asset-media img').evaluate(element => (element as HTMLImageElement).naturalWidth), value => value === 1, 'real WebP actually decodes');

  // Matching extension/MIME alone cannot turn HTML into an image.
  const invalid = path.join(fixture.directory, 'invalid.png'); writeFileSync(invalid, '<html>not raster media</html>');
  controlledImportFailure = true;
  await page.getByTestId('import-media-input').setInputFiles({ name: 'invalid.png', mimeType: 'image/png', buffer: readFileSync(invalid) });
  await page.getByTestId('import-media-retry').waitFor();
  assert.equal((await state()).localAssets!.length, 5); assert.equal((await board()).nodes.length, 5);
  controlledImportFailure = false;
  await page.reload(); await page.getByLabel(`project-card-${boardId}`, { exact: true }).click();
  const localRun = await newRun();
  assert.equal(Object.values(localRun.results).filter(result => result.status === 'succeeded').length, 5);
  assert.ok(Object.values(localRun.results).every(result => result.artifacts[0].localId));
  assert.deepEqual(fixture.submissions(), { images: 0, videos: 0, localReferences: 0 }, 'local asset passthrough never generates');

  // Real Codex MCP can reference imported IDs, but cannot invent foreign media.
  client = new Client({ name: 'media-source-smoke', version: '0.7.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'build/server/mcp.js')], cwd: root, env: { PATH: process.env.PATH ?? '', RELAY_DATA_DIR: fixture.directory }, stderr: 'pipe' }));
  assert.equal((await client.listTools()).tools.length, 17);
  let currentBoard = await board();
  const assetNode = { id: 'import-copy', type: 'canvas', position: { x: 200, y: 500 }, data: { kind: 'asset', label: 'Imported reference copy', assetKind: 'image', assetId: png.id } };
  const rejected = await client.callTool({ name: 'apply_operations', arguments: { boardId, expectedRevision: currentBoard.revision, operations: [{ type: 'add_node', node: { ...assetNode, data: { ...assetNode.data, assetId: 'unknown-source' } } }] } });
  assert.equal(rejected.isError, true); assert.equal((await board()).revision, currentBoard.revision);
  const patched = await client.callTool({ name: 'apply_operations', arguments: { boardId, expectedRevision: currentBoard.revision, operations: [
    { type: 'add_node', node: assetNode },
    { type: 'add_node', node: { id: 'import-motion', type: 'canvas', position: { x: 620, y: 500 }, data: { kind: 'video', label: 'Imported image to video', providerId: 'source-relay', model: SOURCE_VIDEO_MODEL, prompt: 'Animate this imported image.', referenceField: 'image_url', params: {} } } },
    { type: 'connect', edge: { id: 'import-edge', source: 'import-copy', target: 'import-motion' } },
  ] } });
  assert.equal(patched.isError, false);
  await until(() => page.locator('.react-flow__node[data-id="import-motion"]').count(), value => value === 1, 'MCP imported reference syncs to UI');
  await selectNode('import-motion');
  await page.getByLabel('run-selected', { exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Run remote generation?' });
  await confirmation.waitFor(); await confirmation.getByTestId('local-reference-disclosure').waitFor();
  assert.deepEqual(fixture.submissions(), { images: 0, videos: 0, localReferences: 0 });
  await confirmation.getByRole('button', { name: 'Back', exact: true }).click();
  const localMotion = await newRun(true, true);
  assert.equal(localMotion.results['import-motion'].referenceUrl, png.artifact.url, 'durable reference retains canonical local identity');
  assert.deepEqual(fixture.submissions(), { images: 0, videos: 1, localReferences: 1 });
  fixture.assertNoLeaks(await state()); fixture.assertNoLeaks(readFileSync(fixture.store.file, 'utf8'));
  assert.equal((await client.callTool({ name: 'save_artifact', arguments: { runId: localMotion.id, nodeId: 'import-motion', artifactIndex: 0 } })).isError, false);

  await page.getByLabel('provider-settings', { exact: true }).first().click();
  await page.locator('.provider-row').filter({ hasText: 'Fixture multiple image + video relay' }).click();
  await page.getByTestId('relay-flow-add').click();
  currentBoard = await until(board, value => value.nodes.length === 9, 'generated pair saved');
  const generatedImage = currentBoard.nodes.find(node => node.data.kind === 'image')!.id;
  const generatedVideo = currentBoard.nodes.find(node => node.data.kind === 'video' && node.id !== 'import-motion')!.id;
  await selectNode(generatedImage);
  await page.getByTestId('image-count').selectOption('2');
  await page.getByTestId('image-response-format').selectOption('b64_json');
  await page.getByLabel('prompt-editor').fill('Version A, multiple candidate images.');
  await selectNode(generatedVideo);
  const a = await newRun(true, true, 2);
  assert.equal(a.results[generatedImage].artifacts.length, 2);
  await selectNode(generatedImage); await page.getByLabel('prompt-editor').fill('Version B, multiple candidate images.'); await selectNode(generatedVideo);
  const b = await newRun(true, true, 2);
  assert.equal(b.results[generatedImage].artifacts.length, 2);
  assert.deepEqual(fixture.submissions(), { images: 2, videos: 3, localReferences: 1 });
  const comparisonPath = `/api/boards/${boardId}/compare?left=${a.id}&right=${b.id}`;
  const canonical = await fixture.api<RunComparison>(comparisonPath);
  await page.getByTestId('compare-open').click();
  await compare().getByTestId('compare-left-run').selectOption(a.id); await compare().getByTestId('compare-right-run').selectOption(b.id);
  await compare().getByTestId('compare-node').selectOption(generatedImage);
  for (const [side, runId] of [['left', a.id], ['right', b.id]] as const) {
    await compare().getByTestId(`compare-save-${side}-1`).click();
    const saved = await until(() => fixture.api<Run>(`/api/runs/${runId}`), value => Boolean(value.results[generatedImage].artifacts[1].localUrl), 'second output save');
    assert.equal(saved.results[generatedImage].artifacts[0].localId, undefined, 'saving index1 does not save index0');
    await download(compare().getByTestId(`compare-download-${side}-1`), saved.results[generatedImage].artifacts[1], `second-${side}.png`);
  }
  assert.deepEqual(await fixture.api<RunComparison>(comparisonPath), canonical);
  // Explicit MCP saves for remaining previews make the later offline check
  // independent of any unused remote-only canvas thumbnail.
  for (const runId of [a.id, b.id]) assert.equal((await client.callTool({ name: 'save_artifact', arguments: { runId, nodeId: generatedImage, artifactIndex: 0 } })).isError, false);
  for (const width of [900, 1280, 1600]) { await page.setViewportSize({ width, height: 1000 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: path.join(work, `v07-multi-compare-${width}.png`), fullPage: true }); }
  await compare().getByTestId('compare-node').selectOption(generatedVideo);
  for (const side of ['left', 'right']) await compare().getByTestId(`compare-save-${side}-0`).click();
  await until(state, value => [a.id, b.id].every(id => Boolean(value.runs.find(run => run.id === id)!.results[generatedVideo].artifacts[0].localUrl)), 'generated videos saved');
  await compare().getByTestId('compare-timeline-left-0').click();
  const sources = [{ runId: b.id, nodeId: generatedVideo, artifactIndex: 0 }, { runId: localRun.id, nodeId: mp4.nodeId, artifactIndex: 0 }, { runId: localRun.id, nodeId: webm.nodeId, artifactIndex: 0 }];
  const firstInfo = `**/api/runs/${a.id}/artifacts/${generatedVideo}/0/info`;
  let releaseInfo!: () => void, enteredInfo!: () => void;
  const heldInfo = new Promise<void>(resolve => { releaseInfo = resolve; });
  const infoEntered = new Promise<void>(resolve => { enteredInfo = resolve; });
  await page.route(firstInfo, async route => { enteredInfo(); await heldInfo; await route.continue(); });
  await timeline().getByTestId('timeline-add').click();
  try {
    await Promise.race([infoEntered, page.waitForTimeout(25000).then(() => { throw new Error('Timed out: held first source probe'); })]);
    await timeline().getByTestId(`timeline-source-card-${b.id}:${generatedVideo}:0`).locator('.timeline-source-card-select').click();
    assert.equal(await timeline().getByTestId('timeline-add').isDisabled(), true, 'switching source keeps Add disabled while prior addition is pending');
  } finally { releaseInfo(); }
  await until(() => timeline().locator('[data-testid^="timeline-clip-"]').count(), value => value === 1, 'first addition settled before next source');
  await page.unroute(firstInfo);
  let expectedClips = 1;
  for (const source of sources) {
    await timeline().getByTestId(`timeline-source-card-${source.runId}:${source.nodeId}:${source.artifactIndex}`).locator('.timeline-source-card-select').click();
    await timeline().getByTestId('timeline-add').click();
    expectedClips++;
    await until(() => timeline().locator('[data-testid^="timeline-clip-"]').count(), value => value === expectedClips, 'source addition settles sequentially');
  }
  await until(() => timeline().locator('[data-testid^="timeline-clip-"]').count(), value => value === 4, 'imported/generated mixed sources added');
  const clipIds = await timeline().locator('[data-testid^="timeline-clip-"]').evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')!.slice('timeline-clip-'.length)));
  for (const id of clipIds) { await timeline().getByTestId(`timeline-in-${id}`).fill('0.25'); await timeline().getByTestId(`timeline-out-${id}`).fill('1.25'); }
  await timeline().getByTestId(`timeline-move-right-${clipIds[0]}`).click();
  await timeline().getByTestId('timeline-save').click();
  const edit = await until(() => fixture.api<Timeline>(`/api/boards/${boardId}/timeline`), value => value.clips.length === 4 && value.clips.every(clip => clip.inSeconds === 0.25 && clip.outSeconds === 1.25), 'mixed edit persisted');
  assert.deepEqual(edit.clips.map(clip => clip.source), [sources[0], { runId: a.id, nodeId: generatedVideo, artifactIndex: 0 }, sources[1], sources[2]]);
  await timeline().getByTestId('timeline-play').click();
  await until(() => timeline().getByTestId('timeline-scrub').inputValue(), value => Number(value) > 2.1, 'mixed playback crosses into imported source');
  const exports: ExportJob[] = [];
  for (const format of ['landscape', 'portrait'] as const) {
    await timeline().getByTestId('timeline-format').selectOption(format);
    const previous = (await state()).exports?.map(job => job.id) ?? [];
    await timeline().getByTestId('timeline-export').click();
    const submitted = await until(state, value => Boolean(value.exports?.some(job => !previous.includes(job.id))), `${format} submitted`);
    const id = submitted.exports!.find(job => !previous.includes(job.id))!.id;
    const job = await until(() => fixture.api<ExportJob>(`/api/exports/${id}`), value => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.status), `${format} mixed MP4`, 180000);
    assert.equal(job.status, 'succeeded'); exports.push(job);
    const player = timeline().locator(`video[src="${job.artifact!.localUrl}"]`).first(); await player.waitFor();
    await player.evaluate(async element => { const video = element as HTMLVideoElement; video.muted = true; await video.play(); });
    await until(() => player.evaluate(element => (element as HTMLVideoElement).currentTime), value => value > 0.1, 'actual exported playback');
    await download(timeline().getByTestId(`timeline-download-${id}`), job.artifact!, `mixed-${format}.mp4`);
  }
  for (const width of [900, 1280, 1600]) { await page.setViewportSize({ width, height: 1000 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: path.join(work, `v07-mixed-timeline-${width}.png`), fullPage: true }); }
  await timeline().getByTestId('timeline-close').click(); await page.reload(); await page.getByLabel(`project-card-${boardId}`, { exact: true }).click();
  await page.getByTestId('timeline-open').click();
  await until(() => timeline().locator('[data-testid^="timeline-clip-"]').count(), value => value === 4, 'mixed edit survives reload');
  await page.route(`${SOURCE_MEDIA_ORIGIN}/**`, route => route.abort('blockedbyclient'));
  await timeline().getByTestId('timeline-play').click();
  await until(() => timeline().getByTestId('timeline-scrub').inputValue(), value => Number(value) > 2.1, 'mixed local playback works without provider CDN');
  fixture.assertNoLeaks(await state()); fixture.assertNoLeaks(await fixture.api<RunComparison>(comparisonPath)); fixture.assertNoLeaks(readFileSync(fixture.store.file, 'utf8'));
  assert.deepEqual(errors, []); assert.deepEqual(unexpectedOutbound, []);
  assert.deepEqual(fixture.submissions(), { images: 2, videos: 3, localReferences: 1 }, 'save/compare/edit/export/reload never generates');
  const report = { status: 'PASS', browser: await browser.version(), network, importedFormats: ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'], imports: (await state()).localAssets!.length, fixtureSubmissions: fixture.submissions(), paidRequests: 0, liveProviderRequests: 0, checks: ['raw UI import and private preview/download/hash', 'same-operation committed-response-loss recovery', 'late import preserves edits and deliberate reload', 'invalid signature rejection', 'local passthrough zero provider calls', 'real MCP assetId authority and UI sync', 'disclosed local image transfer with canonical-only persistence', 'two multi-output generations with exact index1 comparison save/download', 'mixed imported/generated MP4/WebM trims/order and cross-cut playback', 'both real MP4 formats/playback/download/hash and offline-CDN reload'], exports: exports.map(job => ({ format: job.snapshot.format, sha256: job.artifact!.sha256 })) };
  writeFileSync(path.join(work, 'v07-media-sources-report.json'), JSON.stringify(report, null, 2));
  console.log('PASS: multi-output relay + five local media formats → MCP/source-safe generation → exact Compare → mixed timeline → both local MP4 exports; zero live/paid requests.');
} catch (error) {
  await page.screenshot({ path: path.join(work, 'v07-media-sources-failure.png'), fullPage: true });
  writeFileSync(path.join(work, 'v07-media-sources-failure.json'), JSON.stringify({ error: String(error), errors, unexpectedOutbound, events: fixture.events, body: await page.locator('body').innerText() }, null, 2));
  throw error;
} finally { await client?.close(); await browser.close(); await fixture.close(); }
