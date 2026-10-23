import assert from 'node:assert/strict';
import { chromium, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRelayFixture, RELAY_FIXTURE_BASE, RELAY_FIXTURE_IMAGE_MODEL, RELAY_FIXTURE_KEY_ENV, RELAY_FIXTURE_MEDIA, RELAY_FIXTURE_VIDEO_MODEL } from './relay-fixture-server.js';
import { verifyRelayUiBoundaries } from './relay-ui-boundaries-smoke.js';
import type { AppState, Artifact, ExportJob, Run, RunComparison, Timeline } from '../src/shared/types.js';

const root = process.cwd(), work = path.join(root, 'work'); mkdirSync(work, { recursive: true });
const fixture = await createRelayFixture(root);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const browser = await chromium.launch({ headless: true, executablePath }).catch(async error => { await fixture.close(); throw error; });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors: string[] = [], unexpectedOutbound: string[] = [];
const requests: { method: string; pathname: string }[] = [];
let controlledSaveFailure = false;
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.type() !== 'error') return;
  if (controlledSaveFailure && message.location().url.endsWith('/save') && /Failed to load resource/.test(message.text())) return;
  errors.push(`${message.text()} ${message.location().url}`);
});
page.on('request', request => { const url = new URL(request.url()); if (url.origin === fixture.origin && url.pathname.startsWith('/api/')) requests.push({ method: request.method(), pathname: url.pathname }); });
async function until<T>(probe: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeout = 20000): Promise<T> {
  const end = Date.now() + timeout;
  do { const value = await probe(); if (predicate(value)) return value; await page.waitForTimeout(50); } while (Date.now() < end);
  throw new Error(`Timed out: relay creator flow ${label}`);
}
const state = () => fixture.api<AppState>('/api/state');
const boardId = fixture.fixtureBoard.id;
const compare = () => page.getByTestId('compare-dialog');
const timeline = () => page.getByTestId('timeline-dialog');
const generationCount = () => requests.filter(request => request.method === 'POST' && request.pathname === '/api/runs').length;
async function downloadArtifact(link: Locator, artifact: Artifact, name: string) {
  const pending = page.waitForEvent('download'); await link.click();
  const download = await pending, file = path.join(fixture.directory, name); await download.saveAs(file);
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), artifact.sha256, 'download bytes equal exact saved artifact');
}
try {
  await verifyRelayUiBoundaries(browser, root);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === fixture.origin) { await route.continue(); return; }
    if (url.origin !== RELAY_FIXTURE_MEDIA) { unexpectedOutbound.push(url.origin); await route.abort('blockedbyclient'); return; }
    const payload = fixture.payloads.get(url.href);
    if (!payload) { unexpectedOutbound.push(url.href); await route.abort('blockedbyclient'); return; }
    const range = request.headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    const headers: Record<string, string> = { 'access-control-allow-origin': fixture.origin, 'content-type': payload.contentType, 'accept-ranges': 'bytes' };
    if (range) {
      const start = Number(range[1]), end = Math.min(payload.bytes.length - 1, range[2] ? Number(range[2]) : payload.bytes.length - 1);
      assert.ok(start <= end); headers['content-range'] = `bytes ${start}-${end}/${payload.bytes.length}`;
      await route.fulfill({ status: 206, headers, body: payload.bytes.subarray(start, end + 1) });
    } else await route.fulfill({ status: 200, headers, body: payload.bytes });
  });
  await page.goto(fixture.origin);
  await page.getByLabel(`project-card-${boardId}`, { exact: true }).click();
  await page.getByLabel('provider-settings', { exact: true }).first().click();
  await page.getByLabel('provider-template', { exact: true }).selectOption('relay');
  await page.getByLabel('add-provider', { exact: true }).click();
  const providerId = await page.getByLabel('provider-id', { exact: true }).inputValue();
  await page.getByLabel('provider-name', { exact: true }).fill('Fixture image + video relay');
  await page.getByLabel('provider-base-url', { exact: true }).fill(RELAY_FIXTURE_BASE);
  await page.getByLabel('provider-key-env', { exact: true }).fill(RELAY_FIXTURE_KEY_ENV);
  await page.getByLabel('provider-image-model', { exact: true }).fill(RELAY_FIXTURE_IMAGE_MODEL);
  await page.getByLabel('provider-video-model', { exact: true }).fill(RELAY_FIXTURE_VIDEO_MODEL);
  assert.equal(await page.getByTestId('relay-flow-add').isDisabled(), true, 'unsaved provider cannot construct a flow');
  await page.getByLabel('provider-save', { exact: true }).click();
  await until(state, value => value.providers.some(provider => provider.id === providerId && provider.protocol === 'relay' && provider.imageModel === RELAY_FIXTURE_IMAGE_MODEL && provider.videoModel === RELAY_FIXTURE_VIDEO_MODEL), 'one combined profile persists');
  await page.getByLabel('provider-diagnostics', { exact: true }).click();
  await until(() => page.locator('.provider-diagnostics').innerText(), value => value.includes('image, video') || value.includes('image,video'), 'declared dual capability');
  await page.getByLabel('query-models', { exact: true }).click();
  await until(() => page.getByLabel('provider-image-model-options').locator('option').count(), value => value === 3, 'real models route through fixed fixture /models');
  assert.deepEqual(fixture.events.map(event => `${event.method} ${event.pathname}`), ['GET /v1/models']);
  assert.equal(generationCount(), 0);
  for (const width of [900, 1280, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `relay settings fits ${width}`);
    await page.screenshot({ path: path.join(work, `relay-provider-${width}-v06.png`), fullPage: true });
  }
  await page.getByTestId('relay-flow-add').click();
  await until(() => page.locator('.react-flow__node').count(), value => value === 2, 'one connected pair appears');
  if (await page.getByLabel('save', { exact: true }).isEnabled()) await page.getByLabel('save', { exact: true }).click();
  const board = await until(async () => (await state()).boards.find(value => value.id === boardId)!, value => value.nodes.length === 2 && value.edges.length === 1, 'connected pair persisted');
  const imageId = board.nodes.find(node => node.data.kind === 'image')!.id;
  const videoId = board.nodes.find(node => node.data.kind === 'video')!.id;
  assert.equal(board.nodes.every(node => node.data.providerId === providerId), true);
  assert.deepEqual(board.edges.map(edge => [edge.source, edge.target]), [[imageId, videoId]]);
  assert.equal(board.nodes.find(node => node.id === imageId)!.data.model, RELAY_FIXTURE_IMAGE_MODEL);
  assert.equal(board.nodes.find(node => node.id === videoId)!.data.model, RELAY_FIXTURE_VIDEO_MODEL);
  assert.deepEqual(fixture.submissions(), { image: 0, video: 0 }, 'setup and flow construction never generate');
  await page.locator(`.react-flow__node[data-id="${imageId}"]`).click();
  await page.getByLabel('prompt-editor').fill('Version A: a red architectural study.');
  await page.getByLabel('run-all', { exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Run remote generation?' }); await confirmation.waitFor();
  assert.deepEqual(fixture.submissions(), { image: 0, video: 0 }); assert.equal(generationCount(), 0, 'fee confirmation precedes run creation and any provider POST');
  await confirmation.getByRole('button', { name: 'Back', exact: true }).click();
  assert.deepEqual(fixture.submissions(), { image: 0, video: 0 }, 'cancelling confirmation never generates');
  const generateVersion = async () => {
    const previous = (await state()).runs.map(run => run.id);
    await page.getByLabel('run-all', { exact: true }).click();
    await page.getByRole('dialog', { name: 'Run remote generation?' }).getByRole('button', { name: 'Confirm run', exact: true }).click();
    const complete = await until(state, value => value.runs.some(run => run.boardId === boardId && !previous.includes(run.id) && ['succeeded', 'failed', 'needs_review'].includes(run.status)), 'confirmed image→video version completes');
    const run = complete.runs.find(run => run.boardId === boardId && !previous.includes(run.id))!;
    assert.equal(run.status, 'succeeded'); assert.equal(run.results[videoId].referenceUrl, run.results[imageId].artifacts[0].url);
    await until(() => page.getByLabel('run-all', { exact: true }).isEnabled(), value => value, 'UI observes terminal generation');
    return run;
  };
  const a = await generateVersion();
  await page.getByLabel('prompt-editor').fill('Version B: a blue architectural study.');
  const b = await generateVersion();
  assert.deepEqual(fixture.submissions(), { image: 2, video: 2 }); assert.equal(generationCount(), 2);
  assert.notEqual(a.results[imageId].artifacts[0].url, b.results[imageId].artifacts[0].url);
  const comparisonPath = `/api/boards/${boardId}/compare?left=${a.id}&right=${b.id}`;
  const canonical = await fixture.api<RunComparison>(comparisonPath);
  const beforeSaveGenerations = generationCount();
  const nonGenerationSnapshot = fixture.submissions();
  await page.getByTestId('compare-open').click();
  await compare().getByTestId('compare-left-run').selectOption(a.id);
  await compare().getByTestId('compare-right-run').selectOption(b.id);
  await compare().getByTestId('compare-node').selectOption(imageId);
  await until(() => compare().getByTestId('compare-save-left-0').isEnabled(), value => value, 'exact image can be saved in Compare');
  assert.equal(await compare().getByTestId('compare-timeline-left-0').isDisabled(), true, 'image remains ineligible for timeline');
  const savePattern = `**/api/runs/${a.id}/artifacts/${imageId}/0/save`;
  controlledSaveFailure = true;
  await page.route(savePattern, route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'CONTROLLED_SAVE_FAILURE', error: 'Controlled fixture save failure' }) }));
  const failureResponse = page.waitForResponse(response => response.url().endsWith(`/api/runs/${a.id}/artifacts/${imageId}/0/save`) && response.status() === 500);
  await compare().getByTestId('compare-save-left-0').click();
  await (await failureResponse).finished();
  await until(() => compare().innerText(), value => /保存失敗|重試/.test(value), 'image save failure is visible');
  assert.equal(await compare().getByTestId('compare-node').inputValue(), imageId);
  await page.unroute(savePattern); controlledSaveFailure = false;
  await compare().getByTestId('compare-save-left-0').click();
  const savedA = await until(() => fixture.api<Run>(`/api/runs/${a.id}`), run => Boolean(run.results[imageId].artifacts[0].localUrl), 'image A saved through real API');
  await compare().getByTestId('compare-download-left-0').waitFor();
  await downloadArtifact(compare().getByTestId('compare-download-left-0'), savedA.results[imageId].artifacts[0], 'image-a.png');
  assert.deepEqual(await fixture.api<RunComparison>(comparisonPath), canonical, 'image cache save leaves canonical comparison unchanged');

  // Canonical comparison can stay readable when live catalog authority drifts;
  // it must not authorize saving a different image at the same index.
  type CatalogMode = 'drift' | 'missing' | 'failed' | 'normal';
  let catalogMode: CatalogMode = 'normal';
  let catalogSeen: CatalogMode = 'normal';
  const writesBeforeDrift = requests.filter(request => request.method === 'POST' && request.pathname.endsWith('/save')).length;
  await page.route('**/api/state', async route => {
    const payload = await state(), mode = catalogMode;
    const run = payload.runs.find(run => run.id === b.id)!;
    if (mode === 'drift') run.results[imageId].artifacts[0].url += '?drift';
    if (mode === 'missing') run.results[imageId].artifacts = [];
    if (mode === 'failed') run.results[imageId].status = 'failed';
    await route.fulfill({ status: 200, contentType: 'application/json', json: payload }); catalogSeen = mode;
  });
  for (const mode of ['drift', 'missing', 'failed'] as const) {
    catalogMode = mode;
    await until(async () => catalogSeen, value => value === mode, `${mode} live catalog delivered`);
    await until(() => compare().getByTestId('compare-save-right-0').isDisabled(), value => value, `${mode} cannot save canonical fallback`);
    assert.equal(await compare().getByTestId('compare-download-right-0').count(), 0);
    assert.equal(await compare().getByTestId('compare-right-run').inputValue(), b.id);
  }
  assert.equal(requests.filter(request => request.method === 'POST' && request.pathname.endsWith('/save')).length, writesBeforeDrift);
  catalogMode = 'normal';
  await until(async () => catalogSeen, value => value === 'normal', 'normal catalog returns');
  await until(() => compare().getByTestId('compare-save-right-0').isEnabled(), value => value, 'exact source can save after restoration');
  await page.unroute('**/api/state');

  // Hold a real successful response while the user changes node and closes.
  // Synchronous double clicks must still submit one exact save request.
  const heldPattern = `**/api/runs/${b.id}/artifacts/${imageId}/0/save`;
  let heldCount = 0; let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(heldPattern, async route => { const response = await route.fetch(); heldCount++; await held; await route.fulfill({ response }); });
  try {
    await compare().getByTestId('compare-save-right-0').evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
    await until(async () => heldCount, value => value === 1, 'duplicate clicks coalesce one save');
    await compare().getByTestId('compare-node').selectOption(videoId);
    await compare().getByTestId('compare-close').click(); release();
    await until(() => compare().count(), value => value === 0, 'late save never reopens Compare');
  } finally { release(); await page.unroute(heldPattern); }
  await page.getByTestId('compare-open').click();
  await compare().getByTestId('compare-left-run').selectOption(a.id);
  await compare().getByTestId('compare-right-run').selectOption(b.id);
  await compare().getByTestId('compare-node').selectOption(videoId);
  await compare().getByTestId('compare-save-left-0').click();
  await compare().getByTestId('compare-save-right-0').click();
  const videos = await until(state, value => [a.id, b.id].every(id => value.runs.find(run => run.id === id)!.results[videoId].artifacts[0].localUrl), 'both exact compared videos saved');
  for (const [side, id] of [['left', a.id], ['right', b.id]] as const) {
    await compare().getByTestId(`compare-download-${side}-0`).waitFor();
    await downloadArtifact(compare().getByTestId(`compare-download-${side}-0`), videos.runs.find(run => run.id === id)!.results[videoId].artifacts[0], `${side}-video.mp4`);
  }
  assert.deepEqual(await fixture.api<RunComparison>(comparisonPath), canonical, 'all local metadata keeps comparison immutable');
  for (const width of [900, 1280, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `relay Compare fits ${width}`);
    await page.screenshot({ path: path.join(work, `relay-compare-${width}-v06.png`), fullPage: true });
  }
  await compare().getByTestId('compare-timeline-left-0').click();
  await until(() => timeline().getByTestId('timeline-source-selected').getAttribute('data-source-key'), value => value === `${a.id}:${videoId}:0`, 'exact relay video handoff');
  await timeline().getByTestId('timeline-add').click();
  await until(() => timeline().locator('[data-testid^="timeline-clip-"]').count(), value => value === 1, 'relay A added');
  await timeline().getByTestId(`timeline-source-card-${b.id}:${videoId}:0`).locator('.timeline-source-card-select').click();
  await timeline().getByTestId('timeline-add').click();
  await until(() => timeline().locator('[data-testid^="timeline-clip-"]').count(), value => value === 2, 'relay B added');
  const clipIds = await timeline().locator('[data-testid^="timeline-clip-"]').evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')!.slice('timeline-clip-'.length)));
  for (const id of clipIds) { await timeline().getByTestId(`timeline-in-${id}`).fill('0.5'); await timeline().getByTestId(`timeline-out-${id}`).fill('1.5'); }
  await timeline().getByTestId(`timeline-move-right-${clipIds[0]}`).click();
  await timeline().getByTestId('timeline-save').click();
  const edit = await until(() => fixture.api<Timeline>(`/api/boards/${boardId}/timeline`), value => value.clips.length === 2 && value.clips.every(clip => clip.inSeconds === 0.5 && clip.outSeconds === 1.5), 'real saved timeline trim');
  assert.deepEqual(edit.clips.map(clip => clip.source), [{ runId: b.id, nodeId: videoId, artifactIndex: 0 }, { runId: a.id, nodeId: videoId, artifactIndex: 0 }]);
  await timeline().getByTestId('timeline-play').click();
  await until(() => timeline().getByTestId('timeline-scrub').inputValue(), value => Number(value) > 1.1, 'joined relay preview crosses cut');
  const exports: ExportJob[] = [];
  for (const format of ['landscape', 'portrait'] as const) {
    await timeline().getByTestId('timeline-format').selectOption(format);
    const beforeIds = (await state()).exports?.map(job => job.id) ?? [];
    await timeline().getByTestId('timeline-export').click();
    const submitted = await until(state, value => Boolean(value.exports?.some(job => !beforeIds.includes(job.id))), `${format} export submits`);
    const id = submitted.exports!.find(job => !beforeIds.includes(job.id))!.id;
    const job = await until(() => fixture.api<ExportJob>(`/api/exports/${id}`), value => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.status), `${format} actual MP4`, 180000);
    assert.equal(job.status, 'succeeded'); exports.push(job);
    const output = timeline().locator(`video[src="${job.artifact!.localUrl}"]`).first();
    await until(() => output.count(), value => value === 1, 'output video shown');
    await output.evaluate(async element => { const video = element as HTMLVideoElement; video.muted = true; await video.play(); });
    await until(() => output.evaluate(element => (element as HTMLVideoElement).currentTime), value => value > 0.1, 'export actually plays');
    await downloadArtifact(timeline().getByTestId(`timeline-download-${id}`), job.artifact!, `${format}.mp4`);
  }
  for (const width of [900, 1280, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `relay timeline fits ${width}`);
    await page.screenshot({ path: path.join(work, `relay-timeline-${width}-v06.png`), fullPage: true });
  }
  assert.equal(generationCount(), beforeSaveGenerations, 'comparison/save/edit/export never generate');
  assert.deepEqual(fixture.submissions(), nonGenerationSnapshot);
  assert.deepEqual(errors, []); assert.deepEqual(unexpectedOutbound, []);
  fixture.assertNoSecret(await state()); fixture.assertNoSecret(await page.locator('body').innerText());
  await timeline().getByTestId('timeline-close').click();
  await page.reload(); await page.getByLabel(`project-card-${boardId}`, { exact: true }).click();
  await page.getByTestId('timeline-open').click();
  await until(() => timeline().locator('[data-testid^="timeline-clip-"]').count(), value => value === 2, 'relay edit survives reload');
  // Saved local files remain usable with the original CDN unavailable.
  await page.route(`${RELAY_FIXTURE_MEDIA}/**`, route => route.abort('blockedbyclient'));
  await timeline().getByTestId('timeline-play').click();
  await until(() => timeline().getByTestId('timeline-scrub').inputValue(), value => Number(value) > 0.1, 'saved relay timeline plays without CDN');
  assert.deepEqual(errors, [], 'reload and offline local playback emit no browser errors');
  assert.deepEqual(unexpectedOutbound, []);
  const report = { status: 'PASS', browser: await browser.version(), fixtureProviderPosts: fixture.submissions(), paidRequests: 0, liveProviderRequests: 0, checks: ['UI profile/models/connected pair without generation', 'explicit external confirmation then two real adapter/service image→video versions', 'exact original image reference and durable remoteId before polling', 'Compare image/video save/retry/download/hash and canonical immutability', 'held save double click/switch/close isolates late response', 'exact Timeline handoff/Add/trim/order/backend read-back', 'actual landscape/portrait MP4 playback/download/hash', '900/1280/1600 layout and persisted local playback without original CDN'], exports: exports.map(job => ({ format: job.snapshot.format, sha256: job.artifact!.sha256 })) };
  writeFileSync(path.join(work, 'relay-flow-report.json'), JSON.stringify(report, null, 2));
  console.log('PASS: custom relay setup → image/video versions → Compare save → Timeline → two local MP4 exports; zero live/paid provider requests.');
} catch (error) {
  await page.screenshot({ path: path.join(work, 'relay-flow-failure.png'), fullPage: true });
  writeFileSync(path.join(work, 'relay-flow-failure.json'), JSON.stringify({ error: String(error), errors, unexpectedOutbound, events: fixture.events, text: await page.locator('body').innerText() }, null, 2));
  throw error;
} finally { await browser.close(); await fixture.close(); }
