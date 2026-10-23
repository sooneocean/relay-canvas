import { chromium } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppState, Artifact, ArtifactInfo, Board, ExportJob, Run, RunComparison, Timeline } from '../src/shared/types.js';

const root = process.cwd();
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'relay-editor-smoke-'));
const artifacts = path.join(root, 'work'); mkdirSync(artifacts, { recursive: true });
const portProbe = net.createServer();
await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = (portProbe.address() as net.AddressInfo).port;
await new Promise<void>(resolve => portProbe.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['build/server/main.js'], { cwd: root, env: { ...process.env, RELAY_PORT: String(port), RELAY_DATA_DIR: dataDir, RELAY_ENABLE_REMOTE: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.resume(); child.stderr.resume();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let client: Client | undefined;
let comparisonFixtureError: string | undefined;
async function until<T>(probe: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeout = 30000): Promise<T> {
  const end = Date.now() + timeout;
  do { try { const value = await probe(); if (predicate(value)) return value; } catch { /* bounded startup/poll */ } await delay(100); } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
}
try {
  await until(() => fetch(`${origin}/healthz`).then(r => r.ok), value => value, 'editor server startup');
  const { token } = JSON.parse(readFileSync(path.join(dataDir, 'session.json'), 'utf8')) as { token: string };
  async function api<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${origin}${endpoint}`, { method, headers: { Origin: origin, 'X-Canvas-Token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(response.ok, `${method} ${endpoint}: ${response.status}`);
    return response.json() as Promise<T>;
  }
  client = new Client({ name: 'relay-editor-smoke', version: '0.4.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'build/server/mcp.js')], cwd: root, env: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), RELAY_DATA_DIR: dataDir }, stderr: 'pipe' }));
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.equal(names.length, 17);
  for (const name of ['read_timeline', 'update_timeline', 'export_timeline', 'get_export', 'cancel_export', 'compare_runs', 'save_artifact', 'get_artifact_info']) assert.ok(names.includes(name), name);
  async function tool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const response = await client!.callTool({ name, arguments: args });
    assert.equal(response.isError, false, `MCP ${name} succeeds`);
    return JSON.parse((response.content as { text: string }[])[0].text) as T;
  }
  async function rejectedTool(name: string, args: Record<string, unknown>) {
    let rejected = false;
    try { rejected = Boolean((await client!.callTool({ name, arguments: args })).isError); } catch { rejected = true; }
    assert.ok(rejected, `MCP ${name} must reject invalid arguments: ${JSON.stringify(args)}`);
  }
  const leftRun = await tool<Run>('run_board', { boardId: 'welcome', expectedRevision: 0, operationId: 'editor-run-a', confirmExternal: false });
  await until(() => api<Run>(`/api/runs/${leftRun.id}`), run => run.status === 'succeeded', 'first generation version');
  const identity = { runId: leftRun.id, nodeId: 'motion', artifactIndex: 0 };
  await rejectedTool('get_artifact_info', identity);
  const saved = await tool<Artifact>('save_artifact', identity);
  const info = await tool<ArtifactInfo>('get_artifact_info', identity);
  assert.equal(info.artifact.sha256, saved.sha256); assert.equal(info.artifact.bytes, saved.bytes);
  assert.deepEqual(info.source, identity);
  assert.equal((await api<Run>(`/api/runs/${leftRun.id}`)).results.motion.artifacts[0].localId, saved.localId);
  for (const name of ['save_artifact', 'get_artifact_info']) for (const patch of [{ runId: '../escape' }, { artifactIndex: -1 }, { artifactIndex: 0.5 }, { artifactIndex: 100 }, { url: 'https://invalid.example/a.mp4' }, { path: '/not-a-source' }, { headers: {} }, { key: 'not-a-key' }]) await rejectedTool(name, { ...identity, ...patch });
  const updated = await tool<Board>('apply_operations', { boardId: 'welcome', expectedRevision: 0, operations: [{ type: 'update_node', id: 'brief', data: { prompt: 'Version B: blue horizon with a slow camera movement.' } }] });
  const rightRun = await tool<Run>('run_board', { boardId: 'welcome', expectedRevision: updated.revision, operationId: 'editor-run-b', confirmExternal: false });
  await until(() => api<Run>(`/api/runs/${rightRun.id}`), run => run.status === 'succeeded', 'second generation version');
  await tool<Artifact>('save_artifact', { runId: rightRun.id, nodeId: 'motion', artifactIndex: 0 });
  const comparison = await tool<RunComparison>('compare_runs', { boardId: 'welcome', left: leftRun.id, right: rightRun.id });
  assert.ok(comparison.differences.some(diff => diff.nodeId === 'brief' && diff.fields.includes('prompt')));
  const canonical = JSON.stringify(comparison);
  await tool<Artifact>('save_artifact', { runId: leftRun.id, nodeId: 'frame', artifactIndex: 0 });
  assert.equal(JSON.stringify(await tool<RunComparison>('compare_runs', { boardId: 'welcome', left: leftRun.id, right: rightRun.id })), canonical, 'local save never changes canonical comparison');

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors: string[] = []; let expectedFailure = false; let generationRequests = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !(expectedFailure && /Failed to load resource|net::ERR_/.test(message.text()))) errors.push(message.text()); });
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/runs') generationRequests++; });
  await page.goto(origin);
  await page.getByLabel('project-card-welcome', { exact: true }).click();
  await page.getByTestId('timeline-open').click();
  const dialog = page.getByTestId('timeline-dialog'); await dialog.waitFor();
  await until(() => dialog.evaluate(element => element.contains(document.activeElement)), value => value, 'timeline initially receives keyboard focus');
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press(i % 2 ? 'Tab' : 'Shift+Tab');
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'modal keeps keyboard focus inside');
  }
  const nodesBeforeKeyboard = (await api<AppState>('/api/state')).boards[0].nodes.length;
  await dialog.getByTestId('timeline-close').focus(); await page.keyboard.press('Delete');
  assert.equal(await page.locator('.react-flow__node').count(), nodesBeforeKeyboard, 'modal Delete does not edit background graph');
  await until(() => dialog.getByTestId('timeline-source').locator('option').count(), count => count >= 3, 'timeline source picker loaded');
  const sourceValues = await dialog.getByTestId('timeline-source').locator('option').evaluateAll(options => options.filter(option => (option as HTMLOptionElement).value !== '' && !(option as HTMLOptionElement).disabled).map(option => (option as HTMLOptionElement).value));
  assert.equal(sourceValues.length, 2);
  await dialog.getByTestId('timeline-source').selectOption(sourceValues[0]);
  await dialog.getByTestId('timeline-add').click();
  const clipElements = () => dialog.locator('[data-testid^="timeline-clip-"]');
  await until(() => clipElements().count(), count => count === 1, 'first clip added');
  const firstId = (await clipElements().first().getAttribute('data-testid'))!.replace('timeline-clip-', '');
  await dialog.getByTestId(`timeline-duplicate-${firstId}`).click();
  await until(() => clipElements().count(), count => count === 2, 'clip duplicated');
  await dialog.getByTestId(`timeline-move-right-${firstId}`).click();
  assert.equal(await clipElements().last().getAttribute('data-testid'), `timeline-clip-${firstId}`);
  await dialog.getByTestId(`timeline-remove-${firstId}`).click();
  await until(() => clipElements().count(), count => count === 1, 'clip removed');
  await dialog.getByTestId('timeline-source').selectOption(sourceValues[1]);
  await dialog.getByTestId('timeline-add').click();
  await until(() => clipElements().count(), count => count === 2, 'second source added');
  const clipIds = await clipElements().evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')!.replace('timeline-clip-', '')));
  for (const id of clipIds) { await dialog.getByTestId(`timeline-in-${id}`).fill('0.5'); await dialog.getByTestId(`timeline-out-${id}`).fill('1.5'); }
  let saveStarted = false; let releaseSave!: () => void;
  const held = new Promise<void>(resolve => { releaseSave = resolve; });
  const pattern = '**/api/boards/welcome/timeline';
  await page.route(pattern, async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return; }
    const response = await route.fetch(); saveStarted = true; await held; await route.fulfill({ response });
  });
  try {
    await dialog.getByTestId('timeline-save').click();
    await until(async () => saveStarted, value => value, 'timeline save held after commit');
    await dialog.getByTestId(`timeline-in-${clipIds[0]}`).fill('0.75');
    releaseSave();
    await until(() => dialog.getByTestId('timeline-save').isEnabled(), value => value, 'new edit stays dirty during save');
    assert.equal(await dialog.getByTestId(`timeline-in-${clipIds[0]}`).inputValue(), '0.75');
  } finally { releaseSave(); await page.unroute(pattern); }
  await dialog.getByTestId('timeline-save').click();
  await until(() => api<Timeline>('/api/boards/welcome/timeline'), value => value.clips.some(clip => clip.id === clipIds[0] && clip.inSeconds === 0.75), 'latest edit persisted');
  await dialog.getByTestId('timeline-ruler').waitFor();
  const shorter = await dialog.getByTestId(`timeline-segment-${clipIds[0]}`).boundingBox();
  const longer = await dialog.getByTestId(`timeline-segment-${clipIds[1]}`).boundingBox();
  assert.ok(shorter && longer);
  assert.ok(Math.abs(shorter.width / longer.width - 0.75) < 0.08, 'visible track widths represent clip duration');
  await dialog.getByTestId(`timeline-in-${clipIds[0]}`).fill('0.5');
  await dialog.getByTestId('timeline-save').click();
  await until(() => api<Timeline>('/api/boards/welcome/timeline'), value => value.clips.length === 2 && value.clips.every(clip => clip.inSeconds === 0.5 && clip.outSeconds === 1.5), 'trimmed timeline saved');
  // An external Codex edit must not silently replace a dirty editor draft.
  const beforeConflict = await tool<Timeline>('read_timeline', { boardId: 'welcome' });
  await dialog.getByTestId(`timeline-in-${clipIds[0]}`).fill('0.6');
  await tool<Timeline>('update_timeline', { boardId: 'welcome', expectedRevision: beforeConflict.revision, format: beforeConflict.format, clips: beforeConflict.clips.map(({ id, source, inSeconds, outSeconds }) => ({ id, source, inSeconds, outSeconds })) });
  expectedFailure = true;
  const conflictResponse = page.waitForResponse(response => response.url().endsWith('/api/boards/welcome/timeline') && response.status() === 409);
  await dialog.getByTestId('timeline-save').click();
  await (await conflictResponse).finished();
  assert.equal(await dialog.getByTestId(`timeline-in-${clipIds[0]}`).inputValue(), '0.6');
  const closeConflictResponse = page.waitForResponse(response => response.url().endsWith('/api/boards/welcome/timeline') && response.status() === 409);
  await dialog.getByTestId('timeline-close').click();
  await (await closeConflictResponse).finished();
  assert.equal(await dialog.isVisible(), true, 'conflicted dirty timeline cannot close');
  page.once('dialog', confirmation => void confirmation.accept());
  await dialog.getByTestId('timeline-reload').click();
  await until(() => dialog.getByTestId(`timeline-in-${clipIds[0]}`).inputValue(), value => value === '0.5', 'deliberate reload recovers conflict');
  expectedFailure = false;
  // Controlled storage/network failure preserves the draft and close guard.
  expectedFailure = true;
  await page.route(pattern, async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return; }
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ code: 'CONTROLLED_FAILURE', error: 'Controlled timeline save failure' }) });
  });
  await dialog.getByTestId(`timeline-in-${clipIds[0]}`).fill('0.55');
  const failedClose = page.waitForResponse(response => response.url().endsWith('/api/boards/welcome/timeline') && response.status() === 500);
  await dialog.getByTestId('timeline-close').click(); await (await failedClose).finished();
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await dialog.getByTestId(`timeline-in-${clipIds[0]}`).inputValue(), '0.55');
  await page.unroute(pattern);
  await dialog.getByTestId(`timeline-in-${clipIds[0]}`).fill('0.5');
  await dialog.getByTestId('timeline-save').click();
  await until(() => dialog.getByTestId('timeline-save').isDisabled(), value => value, 'failed-close draft recovers');
  expectedFailure = false;
  const handle = dialog.getByTestId(`timeline-trim-in-${clipIds[0]}`);
  await handle.scrollIntoViewIfNeeded(); const handleBox = await handle.boundingBox(); assert.ok(handleBox);
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down(); await page.mouse.move(handleBox.x + handleBox.width / 2 + 35, handleBox.y + handleBox.height / 2, { steps: 6 }); await page.mouse.up();
  assert.ok(Number(await dialog.getByTestId(`timeline-in-${clipIds[0]}`).inputValue()) > 0.5, 'dragging the trim handle edits the source in-point');
  await dialog.getByTestId(`timeline-in-${clipIds[0]}`).fill('0.5');
  await dialog.getByTestId('timeline-save').click();
  await until(() => dialog.getByTestId('timeline-save').isDisabled(), value => value, 'pointer-trim draft saves');
  const ruler = dialog.getByTestId('timeline-ruler'); const rulerBox = await ruler.boundingBox(); assert.ok(rulerBox);
  const pixelsPerSecond = Number(await dialog.getByTestId('timeline-zoom').inputValue());
  await ruler.click({ position: { x: pixelsPerSecond * 1.25, y: Math.min(10, rulerBox.height / 2) } });
  await until(() => dialog.getByTestId(`timeline-segment-${clipIds[1]}`).getAttribute('aria-current'), value => value === 'true', 'ruler seek selects the actual second clip');
  await until(() => dialog.locator('.timeline-stage-video').evaluate(element => (element as HTMLVideoElement).currentTime), value => Math.abs(value - 0.75) < 0.15, 'ruler seek moves the source video to the trimmed local time');
  await dialog.getByTestId('timeline-scrub').focus(); await page.keyboard.press('Home');
  await dialog.getByTestId('timeline-play').click();
  await until(() => dialog.getByTestId('timeline-scrub').inputValue(), value => Number(value) > 1.2, 'timeline playhead crosses the clip cut');
  await page.screenshot({ path: path.join(artifacts, 'timeline-v04.png'), fullPage: true });
  const exports: ExportJob[] = [];
  for (const format of ['landscape', 'portrait']) {
    await dialog.getByTestId('timeline-format').selectOption(format);
    const previousIds = (await api<AppState>('/api/state')).exports?.map(job => job.id) ?? [];
    let unknownJobId: string | undefined;
    if (format === 'landscape') {
      expectedFailure = true;
      await page.route('**/api/boards/welcome/exports', async route => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        const response = await route.fetch(); const committed = await response.json() as ExportJob;
        unknownJobId = committed.id;
        await route.abort('connectionreset');
      });
      await dialog.getByTestId('timeline-export').click();
      await until(async () => unknownJobId, value => Boolean(value), 'export committed before controlled response loss');
      await until(() => dialog.getByTestId('timeline-export').isEnabled(), value => value, 'unknown export submission can retry');
      await page.unroute('**/api/boards/welcome/exports');
    }
    await dialog.getByTestId('timeline-export').click();
    const state = await until(() => api<AppState>('/api/state'), value => Boolean(value.exports?.some(job => !previousIds.includes(job.id))), `${format} export submitted`);
    const job = state.exports!.find(value => !previousIds.includes(value.id))!;
    if (unknownJobId) {
      assert.equal(job.id, unknownJobId, 'UI transport retry reuses the committed job');
      assert.equal(state.exports!.filter(value => !previousIds.includes(value.id)).length, 1, 'retry does not create a second export');
      expectedFailure = false;
    }
    const finished = await until(() => api<ExportJob>(`/api/exports/${job.id}`), value => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.status), `${format} MP4 render`, 180000);
    assert.equal(finished.status, 'succeeded'); exports.push(finished);
    const artifact = finished.artifact!;
    const preview = dialog.locator(`video[src="${artifact.localUrl}"]`).first();
    await until(() => preview.count(), count => count === 1, 'export preview shown');
    await preview.evaluate(async element => { const video = element as HTMLVideoElement; video.muted = true; await video.play(); });
    await until(() => preview.evaluate(element => (element as HTMLVideoElement).currentTime), value => value > 0.1, `${format} MP4 plays`);
    const downloaded = page.waitForEvent('download');
    await dialog.getByTestId(`timeline-download-${job.id}`).click();
    const download = await downloaded; const file = path.join(dataDir, `${format}.mp4`); await download.saveAs(file);
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), artifact.sha256);
  }
  let timeline = await tool<Timeline>('read_timeline', { boardId: 'welcome' });
  timeline = await tool<Timeline>('update_timeline', { boardId: 'welcome', expectedRevision: timeline.revision, format: timeline.format, clips: timeline.clips.map(({ id, source, inSeconds, outSeconds }) => ({ id, source, inSeconds, outSeconds })) });
  const requested = { boardId: 'welcome', expectedRevision: timeline.revision, operationId: 'mcp-editor-export' };
  const sdkJob = await tool<ExportJob>('export_timeline', requested);
  assert.equal((await tool<ExportJob>('export_timeline', requested)).id, sdkJob.id);
  await until(() => tool<ExportJob>('get_export', { exportId: sdkJob.id }), value => value.status === 'succeeded', 'MCP actual MP4 export', 180000);
  assert.equal((await tool<ExportJob>('cancel_export', { exportId: sdkJob.id })).status, 'succeeded', 'terminal cancel cannot change a completed export');
  await dialog.getByTestId('timeline-close').click();
  await until(() => dialog.count(), count => count === 0, 'timeline closes cleanly');
  assert.equal(await page.getByTestId('timeline-open').evaluate(element => element === document.activeElement), true, 'closing timeline restores opener focus');
  await page.getByTestId('compare-open').click();
  const compare = page.getByTestId('compare-dialog'); await compare.waitFor();
  await until(() => compare.evaluate(element => element.contains(document.activeElement)), value => value, 'comparison receives focus');
  await compare.getByTestId('compare-left-run').selectOption(leftRun.id);
  await compare.getByTestId('compare-right-run').selectOption(rightRun.id);
  await compare.getByTestId('compare-node').selectOption('brief');
  await until(() => compare.innerText(), text => text.includes('Version B: blue horizon'), 'A/B prompt details rendered');
  await compare.getByTestId('compare-node').selectOption('motion');
  await until(() => compare.locator('video').count(), count => count === 2, 'two version outputs shown');
  await compare.getByTestId('compare-play').click();
  await until(() => compare.locator('video').evaluateAll(elements => elements.every(element => (element as HTMLVideoElement).currentTime > 0.05)), value => value, 'A/B playback coordinates both videos');
  await until(() => compare.getByTestId('compare-scrub').inputValue(), value => Number(value) > 0.15, 'comparison scrubber follows the actual media clock');
  await page.screenshot({ path: path.join(artifacts, 'compare-v04.png'), fullPage: true });
  await compare.getByTestId('compare-play').click();
  await until(() => compare.locator('video').evaluateAll(elements => elements.every(element => (element as HTMLVideoElement).paused)), value => value, 'A/B pause coordinates both videos');
  const previousVideos = await compare.locator('video').elementHandles();
  await compare.getByTestId('compare-node').selectOption('brief');
  await until(() => compare.locator('video').count(), count => count === 0, 'text-only comparison removes media');
  if (await compare.getByTestId('compare-play').isEnabled()) await compare.getByTestId('compare-play').click();
  assert.ok((await compare.getByTestId('compare-play').innerText()).includes('Play videos'), 'text-only comparison cannot start hidden old media');
  for (const video of previousVideos) assert.equal(await video.evaluate(element => (element as HTMLVideoElement).paused), true, 'detached comparison source stays paused');
  await compare.getByTestId('compare-node').selectOption('motion');
  await until(() => compare.locator('video').evaluateAll(elements => elements.length === 2 && elements.every(element => (element as HTMLVideoElement).readyState >= 1)), value => value, 'video comparison restored after text-only selection');
  await compare.getByTestId('compare-scrub').press('Home');
  await until(() => compare.locator('video').evaluateAll(elements => elements.every(element => (element as HTMLVideoElement).currentTime < 0.1)), value => value, 'keyboard seek moves both real videos');
  await compare.getByTestId('compare-play').click();
  await until(() => compare.locator('video').evaluateAll(elements => elements.every(element => (element as HTMLVideoElement).ended)), value => value, 'both comparison videos reach their real end');
  await until(() => compare.getByTestId('compare-play').innerText(), value => value.includes('Play videos'), 'completed comparison returns to Play');
  await compare.getByTestId('compare-play').click();
  await until(() => compare.locator('video').evaluateAll(elements => elements.every(element => (element as HTMLVideoElement).currentTime > 0.05 && (element as HTMLVideoElement).currentTime < 1)), value => value, 'completed comparison replays both sources from the beginning');
  const closingVideos = await compare.locator('video').elementHandles();
  await compare.getByTestId('compare-close').click();
  for (const video of closingVideos) assert.equal(await video.evaluate(element => (element as HTMLVideoElement).paused), true, 'closing comparison pauses both playing sources');
  // Controlled comparison-response fixture: use our actual two-second exported
  // MP4 on B beside the original three-second Demo on A. Both media are real,
  // private files; this changes no workspace state and makes unequal ends visible.
  const comparisonPattern = '**/api/boards/welcome/compare?*';
  await page.route(comparisonPattern, async route => {
    try {
      // Replay through our authenticated fixture API, independent of browser
      // fetch-metadata headers stripped by Playwright's APIRequestContext.
      const requested = new URL(route.request().url());
      const payload = await api<RunComparison>(requested.pathname + requested.search);
      const artifact = payload.right.results.motion?.artifacts[0];
      if (artifact) artifact.url = exports[0].artifact!.localUrl!;
      await route.fulfill({ status: 200, contentType: 'application/json', json: payload });
    } catch (error) {
      comparisonFixtureError = error instanceof Error ? error.message : 'Controlled comparison fixture failed';
      // Let the awaited UI acceptance fail through the outer finally cleanup.
      await route.abort('failed').catch(() => undefined);
    }
  });
  await page.getByTestId('compare-open').click();
  await compare.waitFor();
  await compare.getByTestId('compare-node').selectOption('motion');
  await until(() => compare.locator('video').evaluateAll(elements => elements.map(element => element.getAttribute('src'))), values => values.includes(exports[0].artifact!.localUrl!), 'controlled shorter video URL is selected');
  // preload is advisory. Use the real creator Play action to load both sources
  // before requiring their durations; do not depend on offscreen preload policy.
  await compare.getByTestId('compare-play').click();
  await until(() => compare.locator('video').evaluateAll(elements => elements.map(element => (element as HTMLVideoElement).duration)), values => values.length === 2 && values.every(Number.isFinite) && Math.abs(values[0] - values[1]) > 0.5, 'unequal-duration actual media fixture loaded');
  await until(() => compare.locator('video').evaluateAll(elements => ({ ended: elements.some(element => (element as HTMLVideoElement).ended), continuing: elements.some(element => !(element as HTMLVideoElement).ended && !(element as HTMLVideoElement).paused) })), value => value.ended && value.continuing, 'short comparison source ends while longer source continues');
  assert.ok((await compare.getByTestId('compare-play').innerText()).includes('Pause videos'), 'a remaining playing source keeps Pause');
  await until(() => compare.getByTestId('compare-scrub').inputValue(), value => Number(value) > 2.15, 'comparison clock continues beyond the shorter source');
  await compare.getByTestId('compare-scrub').press('Home');
  await until(() => compare.locator('video').evaluateAll(elements => elements.length === 2 && elements.every(element => !(element as HTMLVideoElement).paused && (element as HTMLVideoElement).currentTime > 0.05 && (element as HTMLVideoElement).currentTime < 1)), value => value, 'seeking backward during playback resumes the previously ended shorter source');
  await until(() => compare.locator('video').evaluateAll(elements => elements.every(element => (element as HTMLVideoElement).ended)), value => value, 'unequal comparison reaches both ends');
  await until(() => compare.getByTestId('compare-play').innerText(), value => value.includes('Play videos'), 'unequal comparison finishes in Play state');
  await page.unroute(comparisonPattern);
  for (const width of [1280, 900]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `comparison fits ${width}`);
  }
  await compare.getByTestId('compare-close').click();
  await page.reload(); await page.getByLabel('project-card-welcome', { exact: true }).click();
  await page.getByTestId('timeline-open').click();
  await until(() => page.getByTestId('timeline-dialog').locator('[data-testid^="timeline-clip-"]').count(), count => count === 2, 'timeline survives reload');
  assert.equal(generationRequests, 0, 'editor and comparison never regenerate');
  assert.deepEqual(errors, [], 'no browser errors');
  writeFileSync(path.join(artifacts, 'editor-smoke-report.json'), JSON.stringify({ status: 'PASS', browser: await browser.version(), platform: process.platform, checks: ['17-tool real MCP handshake', 'strict save/info schema and private read-back', 'immutable terminal comparison after local save', 'timeline add/duplicate/reorder/remove/trim', 'save during concurrent edit', 'sequential trimmed preview crosses cut', 'landscape and portrait MP4 browser playback/download/hash', 'MCP timeline/export/status/idempotency/terminal cancel', 'A/B prompts, media clock, seek, ended/replay and unequal-duration videos', 'reload and viewport layouts'], exports: exports.map(job => ({ id: job.id, format: job.snapshot.format, sha256: job.artifact!.sha256 })), paidRequests: 0 }, null, 2));
  console.log('PASS: timeline, real landscape/portrait MP4, A/B comparison and complete MCP journey; zero paid requests.');
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    console.error(JSON.stringify({ editorSmokeFailure: error instanceof Error ? error.message : 'Editor smoke failed', comparisonFixtureError, videos: await page.locator('video').evaluateAll(elements => elements.map(element => { const video = element as HTMLVideoElement; return { label: video.getAttribute('aria-label'), source: video.getAttribute('src'), time: video.currentTime, duration: video.duration, ready: video.readyState, paused: video.paused, mediaErrorCode: video.error?.code }; })) }));
    await page.screenshot({ path: path.join(artifacts, 'editor-smoke-failure.png'), fullPage: true });
    writeFileSync(path.join(artifacts, 'editor-smoke-failure.json'), JSON.stringify({ error: error instanceof Error ? error.message : 'Editor smoke failed', text: await page.locator('body').innerText(), videos: await page.locator('video').evaluateAll(elements => elements.map(element => ({ src: (element as HTMLVideoElement).getAttribute('src'), time: (element as HTMLVideoElement).currentTime, duration: (element as HTMLVideoElement).duration, ready: (element as HTMLVideoElement).readyState, paused: (element as HTMLVideoElement).paused, error: (element as HTMLVideoElement).error?.message }))), scrub: await page.getByTestId('timeline-scrub').inputValue().catch(() => undefined) }, null, 2));
  }
  throw error;
} finally {
  await client?.close(); await browser?.close();
  const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM'); await Promise.race([stopped, delay(3000)]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await stopped; }
  rmSync(dataDir, { recursive: true, force: true });
}
