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
import { Store } from '../server/store.js';
import { providers, starterBoard } from '../src/shared/defaults.js';
import { verifyHandoffIntents } from './handoff-intents-smoke.js';
import { sourceBrowserFixtures, verifySourceBrowser } from './source-browser-smoke.js';
import { verifyThumbnailLifetime } from './thumbnail-lifetime-smoke.js';
import type { AppState, Artifact, ArtifactInfo, Board, ExportJob, Run, RunComparison, Timeline } from '../src/shared/types.js';

const root = process.cwd();
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'relay-editor-smoke-'));
// This isolated persisted fixture exercises real source validation for an old
// revision, a node deleted from the current canvas, and artifact index > 0.
// No production mutation API or generation request is needed to create it.
const handoffBoard = starterBoard('handoff', 'Comparison handoff fixture');
handoffBoard.revision = 9;
handoffBoard.nodes = handoffBoard.nodes.filter(node => node.id !== 'motion');
handoffBoard.edges = handoffBoard.edges.filter(edge => edge.target !== 'motion');
const historicalBoard = starterBoard('handoff', handoffBoard.name);
historicalBoard.revision = 2;
historicalBoard.nodes.find(node => node.id === 'motion')!.id = 'archived-motion';
historicalBoard.nodes.find(node => node.id === 'archived-motion')!.data.label = 'Archive clip';
historicalBoard.edges.find(edge => edge.target === 'motion')!.target = 'archived-motion';
const fixtureRun = (id: string, revision: number, startedAt: string): Run => ({
  id, boardId: 'handoff', revision, operationId: id, status: 'succeeded', startedAt, finishedAt: startedAt,
  snapshot: { ...structuredClone(historicalBoard), revision }, providers: structuredClone(providers),
  order: ['brief', 'archived-motion'],
  results: {
    brief: { nodeId: 'brief', status: 'succeeded', text: 'Fixture creative brief', artifacts: [] },
    'archived-motion': { nodeId: 'archived-motion', status: 'succeeded', artifacts: [0, 1].map(() => ({ kind: 'video', url: '/demo-motion.mp4', demo: true })) },
  },
});
const fixtureStore = new Store(dataDir);
fixtureStore.transaction(state => {
  state.boards.push(handoffBoard);
  state.runs.push(fixtureRun('handoff-a', 2, '2026-01-02T10:30:00Z'), fixtureRun('handoff-b', 3, '2026-01-03T12:45:00Z'));
  const sources = sourceBrowserFixtures();
  state.boards.push(sources.board);
  state.runs.push(...sources.runs);
});
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
  client = new Client({ name: 'relay-editor-smoke', version: '0.5.0' });
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
  for (const runId of ['handoff-a', 'handoff-b']) await tool<Artifact>('save_artifact', { runId, nodeId: 'archived-motion', artifactIndex: 1 });

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors: string[] = []; let expectedFailure = false; let generationRequests = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !(expectedFailure && /Failed to load resource|net::ERR_/.test(message.text()))) errors.push(`${message.text()} ${message.location().url}`.trim()); });
  page.on('response', response => { if (response.status() >= 400 && !expectedFailure) console.error(`Unexpected fixture response: ${response.status()} ${new URL(response.url()).pathname}`); });
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
  await until(() => dialog.locator('[data-testid^="timeline-source-card-"]').count(), count => count >= 2, 'timeline source cards loaded');
  const sourceValues = await dialog.locator('[data-testid^="timeline-source-card-"]').evaluateAll(cards => cards.map(card => card.getAttribute('data-source-key')!));
  assert.equal(sourceValues.length, 2);
  await dialog.getByTestId(`timeline-source-card-${sourceValues[0]}`).locator('.timeline-source-card-select').click();
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
  await dialog.getByTestId(`timeline-source-card-${sourceValues[1]}`).locator('.timeline-source-card-select').click();
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
  await page.getByTestId('timeline-close').click();
  await until(() => page.getByTestId('timeline-dialog').count(), count => count === 0, 'existing timeline closes before handoff journey');

  // Compare -> Timeline is selection only. Exercise exact historical identities
  // against the real persisted server, not a mocked successful Add response.
  await page.getByLabel('board-name', { exact: true }).selectOption('handoff');
  const handoffCompare = () => page.getByTestId('compare-dialog');
  const handoffTimeline = () => page.getByTestId('timeline-dialog');
  const handoffSource = (runId: string, index: number) => `${runId}:archived-motion:${index}`;
  const selectedHandoffSource = () => handoffTimeline().getByTestId('timeline-source-selected').getAttribute('data-source-key');
  const chooseHandoffSource = (runId: string, index: number) => handoffTimeline().getByTestId(`timeline-source-card-${handoffSource(runId, index)}`).locator('.timeline-source-card-select').click();
  const handoffComparisonPath = '/api/boards/handoff/compare?left=handoff-a&right=handoff-b';
  const beforeHandoff = await api<AppState>('/api/state');
  const handoffCanonical = await api<RunComparison>(handoffComparisonPath);
  const beforeTimeline = await api<Timeline>('/api/boards/handoff/timeline');
  const handoffTraffic: string[] = [];
  const watchHandoff = (request: import('@playwright/test').Request) => {
    const endpoint = new URL(request.url()).pathname;
    if ((request.method() !== 'GET' && /\/api\/(boards\/handoff\/timeline|runs\/|boards\/handoff\/exports)/.test(endpoint)) || /\/artifacts\/[^/]+\/\d+\/info$/.test(endpoint)) handoffTraffic.push(`${request.method()} ${endpoint}`);
  };
  page.on('request', watchHandoff);
  async function openHandoffCompare() {
    await page.getByTestId('compare-open').click();
    await handoffCompare().getByTestId('compare-left-run').selectOption('handoff-a');
    await handoffCompare().getByTestId('compare-right-run').selectOption('handoff-b');
    await handoffCompare().getByTestId('compare-node').selectOption('archived-motion');
    await until(() => handoffCompare().getByTestId('compare-timeline-left-1').isEnabled(), value => value, 'exact historical video is eligible for handoff');
  }
  await openHandoffCompare();
  let releaseHandoffTimeline!: () => void;
  let releaseHandoffCapabilities!: () => void;
  const delayedHandoffTimeline = new Promise<void>(resolve => { releaseHandoffTimeline = resolve; });
  const delayedHandoffCapabilities = new Promise<void>(resolve => { releaseHandoffCapabilities = resolve; });
  const handoffTimelinePattern = '**/api/boards/handoff/timeline';
  const capabilitiesPattern = '**/api/editor/capabilities';
  await page.route(handoffTimelinePattern, async route => { await delayedHandoffTimeline; await route.continue(); });
  await page.route(capabilitiesPattern, async route => { await delayedHandoffCapabilities; await route.continue(); });
  await handoffCompare().getByTestId('compare-timeline-left-1').dblclick();
  await until(() => handoffCompare().count(), count => count === 0, 'handoff closes comparison once');
  await page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
  const handoffTimelineResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/boards/handoff/timeline');
  releaseHandoffTimeline();
  await handoffTimelineResponse;
  await page.unroute(handoffTimelinePattern);
  await until(selectedHandoffSource, value => value === handoffSource('handoff-a', 1), 'A exact artifact index1 is selected');
  await until(() => handoffTimeline().getByTestId('timeline-add').isEnabled(), value => value, 'timeline loads without losing the intent');
  assert.equal(await handoffTimeline().locator('[data-testid^="timeline-clip-"]').count(), 0, 'selection does not add a clip');
  assert.deepEqual(await api<Timeline>('/api/boards/handoff/timeline'), beforeTimeline, 'handoff leaves timeline/revision/format unchanged');
  assert.deepEqual(handoffTraffic, [], 'handoff does not save, probe or export');
  assert.deepEqual((await api<AppState>('/api/state')).boards, beforeHandoff.boards, 'handoff leaves board snapshots unchanged');
  assert.deepEqual((await api<AppState>('/api/state')).runs, beforeHandoff.runs, 'handoff leaves every run unchanged');
  assert.deepEqual(await api<RunComparison>(handoffComparisonPath), handoffCanonical, 'handoff leaves canonical comparison unchanged');

  // A manual choice must survive the ordinary one-second runs refresh and
  // delayed capabilities. It cannot be replaced by an already consumed intent.
  await chooseHandoffSource('handoff-b', 1);
  const handoffCapabilitiesResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/editor/capabilities');
  releaseHandoffCapabilities();
  await handoffCapabilitiesResponse;
  await page.unroute(capabilitiesPattern);
  const refresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state');
  await refresh;
  assert.equal(await selectedHandoffSource(), handoffSource('handoff-b', 1));
  await handoffTimeline().getByTestId('timeline-close').click();
  await page.getByTestId('timeline-open').click();
  await until(() => handoffTimeline().locator('[data-testid^="timeline-source-card-"]').count(), count => count > 1, 'ordinary reopen sources loaded');
  assert.notEqual(await selectedHandoffSource(), handoffSource('handoff-a', 1), 'ordinary reopen does not replay A handoff');
  await handoffTimeline().getByTestId('timeline-close').click();

  await openHandoffCompare();
  await handoffCompare().getByTestId('compare-timeline-right-1').click();
  await until(selectedHandoffSource, value => value === handoffSource('handoff-b', 1), 'B exact artifact index1 is selected');
  assert.deepEqual(handoffTraffic, [], 'both handoff sides remain selection only');
  await handoffTimeline().getByTestId('timeline-add').click();
  await until(() => handoffTimeline().locator('[data-testid^="timeline-clip-"]').count(), count => count === 1, 'explicit Add adds the selected historical B video');
  await handoffTimeline().getByTestId('timeline-save').click();
  const addedTimeline = await until(() => api<Timeline>('/api/boards/handoff/timeline'), value => value.clips.length === 1, 'explicit selected clip saved through real backend');
  assert.deepEqual(addedTimeline.clips[0].source, { runId: 'handoff-b', nodeId: 'archived-motion', artifactIndex: 1 });
  assert.equal(addedTimeline.clips[0].media.duration > 0, true, 'the exact artifact was actually probed');
  await page.screenshot({ path: path.join(artifacts, 'compare-timeline-handoff.png'), fullPage: true });
  await handoffTimeline().getByTestId('timeline-close').click();

  // Remote-only metadata needs an explicit save action. Save/probe failures
  // retain an existing draft, and retry never invokes generation.
  await openHandoffCompare();
  const beforeRemoteTraffic = handoffTraffic.length;
  await handoffCompare().getByTestId('compare-timeline-left-0').click();
  await until(selectedHandoffSource, value => value === handoffSource('handoff-a', 0), 'unsaved source selected exactly');
  assert.match(await handoffTimeline().getByTestId('timeline-add').innerText(), /保存並加入/);
  assert.equal(handoffTraffic.length, beforeRemoteTraffic, 'unsaved handoff still performs no save/probe');
  const retainedClipId = addedTimeline.clips[0].id;
  await handoffTimeline().getByTestId(`timeline-in-${retainedClipId}`).fill('0.25');
  // Defensive overlap: an automation-originated click cannot replace an open
  // dirty timeline, even if Compare was opened behind the normal modal guard.
  await page.getByTestId('compare-open').evaluate(element => (element as HTMLButtonElement).click());
  assert.equal(await handoffTimeline().getByTestId(`timeline-in-${retainedClipId}`).inputValue(), '0.25', 'second handoff does not remount or overwrite dirty timeline');
  assert.equal(await handoffCompare().count(), 0, 'overlapping Compare is rejected before two focus traps can mount');
  assert.match(await page.locator('body').innerText(), /先關閉時間軸/);
  const savePattern = '**/api/runs/handoff-a/artifacts/archived-motion/0/save';
  expectedFailure = true;
  await page.route(savePattern, route => route.fulfill({ status: 500, contentType: 'application/json', json: { error: 'Controlled handoff save failure' } }));
  await handoffTimeline().getByTestId('timeline-add').click();
  await until(() => handoffTimeline().innerText(), text => /保存失敗|Controlled handoff save failure/.test(text), 'explicit save failure is shown');
  assert.equal(await handoffTimeline().getByTestId(`timeline-in-${retainedClipId}`).inputValue(), '0.25', 'save failure preserves draft');
  assert.equal(await handoffTimeline().locator('[data-testid^="timeline-clip-"]').count(), 1);
  await page.unroute(savePattern);
  const infoPattern = '**/api/runs/handoff-a/artifacts/archived-motion/0/info';
  await page.route(infoPattern, route => route.fulfill({ status: 500, contentType: 'application/json', json: { error: 'Controlled handoff probe failure' } }));
  await handoffTimeline().getByTestId('timeline-add').click();
  await until(() => handoffTimeline().innerText(), text => text.includes('Controlled handoff probe failure'), 'explicit probe failure is shown');
  assert.equal(await handoffTimeline().getByTestId(`timeline-in-${retainedClipId}`).inputValue(), '0.25', 'probe failure preserves draft');
  assert.equal(await handoffTimeline().locator('[data-testid^="timeline-clip-"]').count(), 1);
  await page.unroute(infoPattern);
  await handoffTimeline().getByTestId('timeline-add').click();
  await until(() => handoffTimeline().locator('[data-testid^="timeline-clip-"]').count(), count => count === 2, 'explicit retry succeeds without regeneration');
  expectedFailure = false;
  await handoffTimeline().getByTestId('timeline-save').click();
  const retriedTimeline = await until(() => api<Timeline>('/api/boards/handoff/timeline'), value => value.clips.length === 2 && value.clips[0].inSeconds === 0.25, 'retry preserves earlier draft and saves exact source');
  assert.deepEqual(retriedTimeline.clips[1].source, { runId: 'handoff-a', nodeId: 'archived-motion', artifactIndex: 0 });
  assert.deepEqual(await api<RunComparison>(handoffComparisonPath), handoffCanonical, 'explicit local save also preserves canonical comparison');
  await handoffTimeline().getByTestId('timeline-close').click();

  // Controlled live-catalog failures leave the canonical comparison visible,
  // but it is never enough authority to hand a changed source into Timeline.
  type CatalogMode = 'normal' | 'drift' | 'failed-run' | 'failed-result' | 'missing-artifact' | 'nonvideo' | 'active' | 'missing-run';
  let catalogMode: CatalogMode = 'normal';
  let seenCatalogMode: CatalogMode | undefined;
  const statePattern = '**/api/state';
  await page.route(statePattern, async route => {
    const payload = await api<AppState>('/api/state');
    const run = payload.runs.find(value => value.id === 'handoff-a')!;
    const mode = catalogMode;
    if (mode === 'drift') run.results['archived-motion'].artifacts[1].url = '/demo-motion.mp4?changed';
    if (mode === 'failed-run') run.status = 'failed';
    if (mode === 'failed-result') run.results['archived-motion'].status = 'failed';
    if (mode === 'missing-artifact') run.results['archived-motion'].artifacts.splice(1, 1);
    if (mode === 'nonvideo') run.results['archived-motion'].artifacts[1].kind = 'image';
    if (mode === 'active') run.status = 'running';
    if (mode === 'missing-run') payload.runs = payload.runs.filter(value => value.id !== 'handoff-a');
    await route.fulfill({ status: 200, contentType: 'application/json', json: payload });
    seenCatalogMode = mode;
  });
  await openHandoffCompare();
  for (const mode of ['drift', 'failed-run', 'failed-result', 'missing-artifact', 'nonvideo'] as CatalogMode[]) {
    catalogMode = mode;
    await until(async () => seenCatalogMode, value => value === mode, `${mode} live catalog received`);
    await until(() => handoffCompare().getByTestId('compare-timeline-left-1').isDisabled(), value => value, `${mode} cannot hand off canonical fallback`);
    assert.equal(await handoffTimeline().count(), 0);
  }
  for (const mode of ['active', 'missing-run'] as CatalogMode[]) {
    catalogMode = mode;
    await until(async () => seenCatalogMode, value => value === mode, `${mode} live catalog received`);
    await until(() => handoffCompare().getByTestId('compare-timeline-left-1').count(), count => count === 0, `${mode} cannot show an eligible fallback action`);
  }
  catalogMode = 'normal';
  await until(async () => seenCatalogMode, value => value === 'normal', 'live catalog restored');
  await handoffCompare().getByTestId('compare-left-run').selectOption('handoff-a');
  await handoffCompare().getByTestId('compare-right-run').selectOption('handoff-b');
  await handoffCompare().getByTestId('compare-node').selectOption('archived-motion');
  await until(() => handoffCompare().getByTestId('compare-timeline-left-1').isEnabled(), value => value, 'restored exact identity can hand off again');
  const beforeDisappearanceTraffic = handoffTraffic.length;
  await handoffCompare().getByTestId('compare-timeline-left-1').click();
  await until(selectedHandoffSource, value => value === handoffSource('handoff-a', 1), 'source selected before disappearance');
  catalogMode = 'missing-artifact';
  await until(async () => seenCatalogMode, value => value === 'missing-artifact', 'selected artifact disappears in live catalog');
  await handoffTimeline().getByTestId('timeline-source-unavailable').waitFor();
  assert.equal(await selectedHandoffSource(), handoffSource('handoff-a', 1), 'unavailable source keeps exact index and never substitutes another video');
  assert.equal(handoffTraffic.length, beforeDisappearanceTraffic, 'disappearance causes no hidden save, probe or timeline write');
  assert.deepEqual(await api<Timeline>('/api/boards/handoff/timeline'), retriedTimeline, 'disappearance does not alter persisted timeline');
  await chooseHandoffSource('handoff-b', 1);
  catalogMode = 'normal';
  await until(async () => seenCatalogMode, value => value === 'normal', 'source catalog returns after manual choice');
  assert.equal(await selectedHandoffSource(), handoffSource('handoff-b', 1), 'reappearing old source cannot replace manual choice');
  await page.unroute(statePattern);
  page.off('request', watchHandoff);
  await handoffTimeline().getByTestId('timeline-close').click();

  // A dirty canvas uses the existing navigation save guard. Failed save keeps
  // Compare selection; two synchronous clicks while its reply is pending claim
  // only one handoff and one board save.
  const boardSavePattern = '**/api/boards/handoff';
  expectedFailure = true;
  await page.route(boardSavePattern, async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return; }
    await route.fulfill({ status: 500, contentType: 'application/json', json: { error: 'Controlled handoff canvas guard failure' } });
  });
  await page.locator('.react-flow__node[data-id="brief"]').click();
  await page.getByLabel('prompt-editor').fill('Keep this dirty canvas while choosing a video.');
  await openHandoffCompare();
  await handoffCompare().getByTestId('compare-timeline-left-1').click();
  await until(() => handoffCompare().getByTestId('compare-timeline-left-1').isEnabled(), value => value, 'failed canvas save releases handoff claim for retry');
  assert.equal(await handoffCompare().getByTestId('compare-left-run').inputValue(), 'handoff-a');
  assert.equal(await handoffCompare().getByTestId('compare-node').inputValue(), 'archived-motion');
  assert.equal(await handoffTimeline().count(), 0, 'failed canvas save keeps comparison open');
  assert.equal(await page.getByLabel('prompt-editor').inputValue(), 'Keep this dirty canvas while choosing a video.', 'failed handoff guard preserves canvas draft');
  await page.unroute(boardSavePattern);
  let releaseCanvasGuard!: () => void;
  const pendingCanvasGuard = new Promise<void>(resolve => { releaseCanvasGuard = resolve; });
  let heldCanvasSaves = 0;
  await page.route(boardSavePattern, async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return; }
    heldCanvasSaves++;
    const payload = await api<Board>('/api/boards/handoff', 'PUT', route.request().postDataJSON());
    await pendingCanvasGuard;
    await route.fulfill({ status: 200, contentType: 'application/json', json: payload });
  });
  try {
    await handoffCompare().getByTestId('compare-timeline-left-1').evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
    await until(async () => heldCanvasSaves, count => count === 1, 'one canvas save is pending despite two rapid handoff clicks');
    assert.equal(await handoffCompare().count(), 1);
    assert.equal(await handoffTimeline().count(), 0);
    const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/boards/handoff' && value.request().method() === 'PUT');
    releaseCanvasGuard();
    await response;
    await until(selectedHandoffSource, value => value === handoffSource('handoff-a', 1), 'successful guarded handoff opens exact selected source once');
    assert.equal(heldCanvasSaves, 1);
    assert.equal(await handoffCompare().count(), 0);
    assert.deepEqual(await api<Timeline>('/api/boards/handoff/timeline'), retriedTimeline, 'guarded handoff does not add or rewrite timeline');
  } finally { releaseCanvasGuard(); await page.unroute(boardSavePattern); }
  expectedFailure = false;
  await verifySourceBrowser(browser, root, origin, api);
  await verifyThumbnailLifetime(browser, root, origin);
  await verifyHandoffIntents(browser, root, handoffBoard, (await api<AppState>('/api/state')).runs.filter(run => run.boardId === 'handoff'), retriedTimeline);
  assert.equal(generationRequests, 0, 'editor and comparison never regenerate');
  assert.deepEqual(errors, [], 'no browser errors');
  writeFileSync(path.join(artifacts, 'editor-smoke-report.json'), JSON.stringify({ status: 'PASS', browser: await browser.version(), platform: process.platform, checks: ['17-tool real MCP handshake', 'strict save/info schema and private read-back', 'immutable terminal comparison after local save', 'timeline add/duplicate/reorder/remove/trim', 'save during concurrent edit', 'sequential trimmed preview crosses cut', 'landscape and portrait MP4 browser playback/download/hash', 'MCP timeline/export/status/idempotency/terminal cancel', 'A/B prompts, media clock, seek, ended/replay and unequal-duration videos', 'reload and viewport layouts', 'A/B compare handoff, historical deleted node and exact index1 persisted via real backend', 'selection-only handoff leaves boards, runs, timeline and canonical comparison unchanged', 'delayed timeline/capabilities, manual choice, runs refresh and close/reopen', 'dirty timeline rejects overlapping handoff; explicit save/probe failures preserve draft', 'failed/active/missing/drifted live sources cannot hand off canonical fallback', 'disappearing selected artifact remains unavailable without fallback'], exports: exports.map(job => ({ id: job.id, format: job.snapshot.format, sha256: job.artifact!.sha256 })), paidRequests: 0 }, null, 2));
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
