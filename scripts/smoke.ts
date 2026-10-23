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
import type { AppState, Board, Run } from '../src/shared/types.js';

const root = process.cwd();
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'relay-smoke-'));
const portProbe = net.createServer();
await new Promise<void>(r => portProbe.listen(0, '127.0.0.1', r));
const port = (portProbe.address() as net.AddressInfo).port;
await new Promise<void>(r => portProbe.close(() => r()));
const origin = `http://127.0.0.1:${port}`;
const logs: string[] = [];
const launchServer = () => spawn(process.execPath, ['build/server/main.js'], { cwd: root, env: { ...process.env, RELAY_DATA_DIR: dataDir, RELAY_PORT: String(port), RELAY_ENABLE_REMOTE: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
let child = launchServer();
child.stdout.on('data', b => logs.push(String(b))); child.stderr.on('data', b => logs.push(String(b)));
const artifacts = path.join(root, 'work'); mkdirSync(artifacts, { recursive: true });
const failures: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let client: Client | undefined;
async function until<T>(probe: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeout = 15000): Promise<T> {
  const start = Date.now();
  do { try { const result = await probe(); if (predicate(result)) return result; } catch { /* startup or transient poll */ } await delay(100); } while (Date.now() - start < timeout);
  throw new Error(`Timed out: ${label}`);
}
try {
  await until(() => fetch(`${origin}/healthz`).then(r => r.ok), x => x, 'server startup');
  let session = JSON.parse(readFileSync(path.join(dataDir, 'session.json'), 'utf8')) as { token: string };
  async function api<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${origin}${endpoint}`, { method, headers: { Origin: origin, 'X-Canvas-Token': session.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`API ${endpoint}: ${response.status}`);
    return response.json() as Promise<T>;
  }
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  let expectedNetworkFailure = false;
  let sessionRequests = 0;
  let generationRequests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/session') sessionRequests++; });
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/runs' && request.method() === 'POST') generationRequests++; });
  page.on('pageerror', e => failures.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error' && !(expectedNetworkFailure && /Failed to load resource|net::ERR_/.test(msg.text()))) failures.push(msg.text()); });
  await page.goto(origin);
  await page.getByLabel('project-card-welcome', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'home-smoke.png'), fullPage: true });
  await page.getByLabel('project-card-welcome', { exact: true }).click();
  await page.getByLabel('board-name', { exact: true }).waitFor();
  await page.locator('.react-flow__node').first().waitFor();
  assert.equal(await page.locator('.react-flow__node').count(), 4);
  const brief = page.locator('.react-flow__node[data-id="brief"]');
  await brief.click();
  await page.getByLabel('prompt-editor').fill('Smoke test: a quiet desert arch at dawn.');
  if (await page.getByLabel('save', { exact: true }).isEnabled()) await page.getByLabel('save', { exact: true }).click();
  await until(() => api<AppState>('/api/state'), s => s.boards[0].nodes[0].data.prompt === 'Smoke test: a quiet desert arch at dawn.', 'prompt saved');
  // Drag the node by its title; validate actual server coordinates after autosave.
  const before = (await api<AppState>('/api/state')).boards[0].nodes.find(n => n.id === 'brief')!.position;
  const header = await brief.locator('.node-heading').boundingBox(); assert.ok(header);
  await page.mouse.move(header.x + 30, header.y + 8); await page.mouse.down(); await page.mouse.move(header.x + 90, header.y + 65, { steps: 8 }); await page.mouse.up();
  await until(() => api<AppState>('/api/state'), s => s.boards[0].nodes.find(n => n.id === 'brief')!.position.x !== before.x, 'drag persisted');
  // Exercise a real handle-to-handle gesture, adding text alongside the image input.
  const source = await brief.locator('.react-flow__handle.source').boundingBox();
  const target = await page.locator('.react-flow__node[data-id="motion"] .react-flow__handle.target').boundingBox();
  assert.ok(source && target);
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 16 });
  await page.mouse.up();
  await until(() => api<AppState>('/api/state'), s => s.boards[0].edges.some(e => e.source === 'brief' && e.target === 'motion'), 'new connection persisted');
  await page.getByLabel('run-all', { exact: true }).click();
  const complete = await until(() => api<AppState>('/api/state'), s => s.runs[0]?.status === 'succeeded', 'Demo image/video workflow');
  assert.equal(complete.runs[0].results.motion.referenceUrl, complete.runs[0].results.frame.artifacts[0].url);
  await page.locator('.react-flow__node[data-id="frame"] img').waitFor();
  await until(() => page.locator('.react-flow__node[data-id="motion"] video').evaluate(el => (el as HTMLVideoElement).readyState), n => n >= 2, 'video ready');
  await page.locator('.react-flow__node[data-id="motion"] video').evaluate(async el => { const video = el as HTMLVideoElement; video.muted = true; await video.play(); });
  await until(() => page.locator('.react-flow__node[data-id="motion"] video').evaluate(el => (el as HTMLVideoElement).currentTime), n => n > 0.05, 'video playback advances');
  await page.locator('.react-flow__node[data-id="motion"] video').evaluate(el => (el as HTMLVideoElement).pause());
  await page.screenshot({ path: path.join(artifacts, 'canvas-smoke.png'), fullPage: true });
  const downloadPromise = page.waitForEvent('download');
  await page.getByLabel('export-board').click();
  const download = await downloadPromise; const downloadPath = path.join(dataDir, 'export.json'); await download.saveAs(downloadPath);
  const exported = JSON.parse(readFileSync(downloadPath, 'utf8')) as Board;
  assert.equal(exported.schemaVersion, 1); assert.equal(exported.nodes[0].data.prompt, 'Smoke test: a quiet desert arch at dawn.');
  assert.equal('runs' in exported, false);
  const imported = { ...exported, name: 'Imported smoke board' };
  await page.locator('input[type="file"]').setInputFiles({ name: 'board.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
  await until(() => api<AppState>('/api/state'), s => s.boards[0].name === imported.name, 'JSON import autosaved');
  await page.reload();
  await page.getByLabel('project-card-welcome', { exact: true }).click();
  await page.locator('.react-flow__node[data-id="brief"]').click();
  await until(() => page.getByLabel('prompt-editor').inputValue(), x => x === 'Smoke test: a quiet desert arch at dawn.', 'saved graph hydrated on reload');
  // Real stdio SDK handshake and typed tool calls through the same HTTP boundary.
  client = new Client({ name: 'relay-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'build/server/mcp.js')], cwd: root, env: { ...Object.fromEntries(Object.entries(process.env).filter((x): x is [string, string] => x[1] !== undefined)), RELAY_DATA_DIR: dataDir }, stderr: 'pipe' });
  await client.connect(transport);
  const tools = await client.listTools(); assert.equal(tools.tools.length, 9);
  const list = await client.callTool({ name: 'list_boards', arguments: {} }); assert.equal(list.isError, false);
  const board = (await api<AppState>('/api/state')).boards[0];
  const patch = await client.callTool({ name: 'apply_operations', arguments: { boardId: board.id, expectedRevision: board.revision, operations: [{ type: 'update_node', id: 'brief', data: { prompt: 'Codex changed this exact canvas.' } }] } });
  assert.equal(patch.isError, false);
  await until(() => page.getByLabel('prompt-editor').inputValue(), x => x === 'Codex changed this exact canvas.', 'MCP updates visible without reload');
  const fresh = (await api<AppState>('/api/state')).boards[0];
  const call = await client.callTool({ name: 'run_board', arguments: { boardId: fresh.id, expectedRevision: fresh.revision, operationId: 'mcp-smoke-operation', nodeId: 'motion', confirmExternal: false } });
  assert.equal(call.isError, false);
  const run = JSON.parse((call.content as { text: string }[])[0].text) as Run;
  await until(() => api<Run>(`/api/runs/${run.id}`), r => r.status === 'succeeded', 'MCP Demo run');
  const repeated = await client.callTool({ name: 'run_board', arguments: { boardId: fresh.id, expectedRevision: fresh.revision, operationId: 'mcp-smoke-operation', nodeId: 'motion', confirmExternal: false } });
  assert.equal(JSON.parse((repeated.content as { text: string }[])[0].text).id, run.id);
  await page.getByLabel('add-node-note').click();
  assert.equal(await page.locator('.react-flow__node').count(), 5);
  await page.getByLabel('delete-node').click();
  assert.equal(await page.locator('.react-flow__node').count(), 4);
  await page.getByLabel('provider-settings').first().click();
  await page.getByText('Remote generation disabled', { exact: true }).waitFor();
  await page.getByLabel('provider-diagnostics', { exact: true }).click();
  await page.getByLabel('query-models', { exact: true }).click();
  await until(() => page.getByLabel('provider-image-model-options', { exact: true }).locator('option').count(), count => count >= 3, 'Demo models discovered without generation');
  await page.getByLabel('provider-template', { exact: true }).selectOption('videos');
  const providerIdsBefore = (await api<AppState>('/api/state')).providers.map(p => p.id);
  await page.getByLabel('add-provider', { exact: true }).click();
  assert.equal(await page.getByLabel('query-models', { exact: true }).isDisabled(), true);
  let providerSaveStarted = false;
  let releaseProviderSave!: () => void;
  const providerSaveHeld = new Promise<void>(resolve => { releaseProviderSave = resolve; });
  await page.route('**/api/providers', async route => {
    if (route.request().method() !== 'PUT') { await route.continue(); return; }
    const response = await route.fetch(); providerSaveStarted = true;
    await providerSaveHeld; await route.fulfill({ response });
  });
  try {
    await page.getByLabel('provider-save', { exact: true }).click();
    await until(async () => providerSaveStarted, value => value, 'provider save held after server commit');
    await page.getByLabel('provider-name', { exact: true }).fill('Custom video edited during save');
    releaseProviderSave();
    await until(() => page.getByLabel('provider-save', { exact: true }).isEnabled(), value => value, 'new provider draft remains dirty');
    assert.equal(await page.getByLabel('provider-name', { exact: true }).inputValue(), 'Custom video edited during save');
  } finally { releaseProviderSave(); await page.unroute('**/api/providers'); }
  await page.getByLabel('provider-save', { exact: true }).click();
  await until(() => api<AppState>('/api/state'), s => s.providers.some(p => p.protocol === 'videos' && !providerIdsBefore.includes(p.id)), 'custom videos profile persisted');
  await until(() => api<AppState>('/api/state'), s => s.providers.some(p => p.name === 'Custom video edited during save'), 'latest provider draft persisted');
  await page.getByLabel('provider-diagnostics', { exact: true }).click();
  await page.locator('.provider-diagnostics').waitFor();
  await page.screenshot({ path: path.join(artifacts, 'providers-v03.png'), fullPage: true });
  await page.getByLabel('close-panel').click();
  const customVideoProvider = (await api<AppState>('/api/state')).providers.find(p => p.name === 'Custom video edited during save')!;
  await page.locator('.react-flow__node[data-id="motion"]').click();
  await page.locator('.select-with-action select').selectOption(customVideoProvider.id);
  await page.getByLabel('video-seconds', { exact: true }).selectOption('8');
  await page.getByLabel('video-size', { exact: true }).selectOption('1280x720');
  await page.getByLabel('video-seconds', { exact: true }).selectOption('');
  assert.equal(await page.getByLabel('video-size', { exact: true }).inputValue(), '1280x720');
  await page.getByLabel('video-size', { exact: true }).selectOption('');
  assert.equal(await page.getByLabel('video-seconds', { exact: true }).inputValue(), '');
  await until(() => api<AppState>('/api/state'), s => {
    const node = s.boards.find(b => b.id === 'welcome')?.nodes.find(n => n.id === 'motion');
    return node?.data.providerId === customVideoProvider.id && Object.keys(node.data.params ?? {}).length === 0;
  }, 'video defaults remove both optional fields from persisted node');
  await page.locator('.select-with-action select').selectOption('demo');
  const sessionsBeforeNavigation = sessionRequests;
  // All navigation paths share the same guard. A failed save must never discard a draft.
  const second = await api<Board>('/api/boards', 'POST', { name: 'Navigation target' });
  await until(() => page.getByLabel('board-name', { exact: true }).locator('option').count(), n => n >= 2, 'second project visible');
  const savePattern = '**/api/boards/welcome';
  const entries = ['home', 'project', 'assets'] as const;
  const faults = ['offline', 'server-error', 'conflict', 'new-edit'] as const;
  for (const entry of entries) for (const fault of faults) {
    await page.locator('.react-flow__node[data-id="brief"]').click();
    const editor = page.getByLabel('prompt-editor');
    const text = `Unsaved ${entry} ${fault}`;
    const edgeCount = await page.locator('.react-flow__edge').count();
    let attempts = 0;
    let releaseSave: (() => void) | undefined;
    const heldSave = new Promise<void>(resolve => { releaseSave = resolve; });
    expectedNetworkFailure = fault !== 'new-edit';
    await page.route(savePattern, async route => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      attempts++;
      if (fault === 'new-edit') {
        const response = await route.fetch();
        await heldSave;
        await route.fulfill({ response });
      } else if (fault === 'offline') await route.abort('internetdisconnected');
      else await route.fulfill({ status: fault === 'conflict' ? 409 : 500, contentType: 'application/json', body: JSON.stringify({ error: fault === 'conflict' ? 'REVISION_CONFLICT' : 'SAVE_FAILED', message: 'Controlled save failure' }) });
    });
    try {
      await editor.fill(text);
      if (entry === 'home') await page.getByLabel('back-home').click();
      else if (entry === 'project') await page.getByLabel('board-name', { exact: true }).selectOption(second.id);
      else await page.getByLabel('assets-nav', { exact: true }).click();
      await until(async () => attempts, n => n > 0, 'navigation attempts save');
      const retainedText = fault === 'new-edit' ? `${text} edited during save` : text;
      if (fault === 'new-edit') { await editor.fill(retainedText); releaseSave?.(); }
      await until(() => page.getByLabel('save', { exact: true }).isEnabled(), x => x, 'failed navigation preserves dirty state');
      assert.equal(await page.getByLabel('board-name', { exact: true }).inputValue(), 'welcome', `${entry}/${fault}: active board preserved`);
      assert.equal(await page.getByLabel('back-home').isVisible(), true, `${entry}/${fault}: canvas remains visible`);
      assert.equal(await editor.inputValue(), retainedText, `${entry}/${fault}: draft preserved`);
      assert.equal(await page.locator('.react-flow__node').count(), 4);
      assert.equal(await page.locator('.react-flow__edge').count(), edgeCount);
    } finally {
      releaseSave?.();
      await page.unroute(savePattern);
    }
    // Autosave can finish between removing the fault and this click. The server
    // read-back below must still prove that the exact retained draft was saved.
    try { await page.getByLabel('save', { exact: true }).click({ timeout: 1000 }); }
    catch (error) { if (!(error instanceof Error) || !error.message.includes('Timeout') || await page.getByLabel('save', { exact: true }).isEnabled()) throw error; }
    await until(() => api<AppState>('/api/state'), s => s.boards.find(b => b.id === 'welcome')?.nodes.find(n => n.id === 'brief')?.data.prompt === (fault === 'new-edit' ? `${text} edited during save` : text), 'draft saves after recovery');
    await until(async () => ({ disabled: await page.getByLabel('save', { exact: true }).isDisabled(), text: await page.getByLabel('save', { exact: true }).innerText() }), x => x.disabled && !x.text.includes('保存中'), 'recovered save settled');
    expectedNetworkFailure = false;
  }
  await page.getByLabel('back-home').click();
  await page.getByLabel('project-card-welcome', { exact: true }).waitFor();
  await page.getByLabel('project-search').fill('no-such-project');
  assert.equal(await page.locator('.project-card').count(), 0);
  await page.getByLabel('project-search').fill('Imported smoke board');
  assert.equal(await page.locator('.project-card').count(), 1);
  await page.getByLabel('project-search').fill('');
  await page.screenshot({ path: path.join(artifacts, 'home-smoke.png'), fullPage: true });
  await page.getByLabel('assets-nav').click();
  await page.getByLabel('gallery-filter-image').click();
  await until(() => page.locator('.asset-card').count(), n => n === 2, 'successful image assets');
  assert.equal(await page.locator('.asset-card video').count(), 0);
  await page.getByLabel('gallery-filter-video').click();
  assert.equal(await page.locator('.asset-card').count(), 2);
  assert.equal(await page.locator('.asset-card img').count(), 0);
  await until(() => page.locator('.asset-card video').evaluateAll(els => els.every(el => (el as HTMLVideoElement).readyState >= 2)), x => x, 'gallery video thumbnails ready');
  await page.getByLabel('asset-search').fill('no-such-asset');
  assert.equal(await page.locator('.asset-card').count(), 0);
  await page.getByLabel('asset-search').fill('');
  await until(() => page.locator('.asset-card video').evaluateAll(els => els.every(el => (el as HTMLVideoElement).readyState >= 2)), x => x, 'filtered video thumbnails ready');
  assert.match(await page.locator('.asset-filters').innerText(), /全部\s+4/);
  assert.equal(await page.locator('.asset-card video').evaluateAll(els => els.every(el => (el as HTMLVideoElement).paused)), true, 'thumbnails do not autoplay');
  await until(() => page.locator('.asset-card video').evaluateAll(async els => {
    return Promise.all(els.map(async el => {
      const poster = (el as HTMLVideoElement).poster;
      if (!poster) return false;
      const image = new Image(); image.src = poster;
      await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 9;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0, 16, 9);
      const pixels = ctx.getImageData(0, 0, 16, 9).data;
      return pixels.some((value, i) => i % 4 !== 3 && value > 10);
    })).then(values => values.every(Boolean));
  }), x => x, 'Demo thumbnail posters contain the decoded frame');
  await page.screenshot({ path: path.join(artifacts, 'assets-smoke.png'), fullPage: true });
  const savedArtifacts: Array<{ runId: string; nodeId: string; index: number; localUrl: string; sha256: string }> = [];
  const generationsBeforeSave = generationRequests;
  for (const kind of ['video', 'image'] as const) {
    await page.getByLabel(`gallery-filter-${kind}`).click();
    const key = (await page.locator('.asset-preview-button').first().getAttribute('aria-label'))!.replace('gallery-item-', '');
    const [runId, nodeId, rawIndex] = key.split(':'); const index = Number(rawIndex);
    const original = (await api<Run>(`/api/runs/${runId}`)).results[nodeId].artifacts[index];
    const pattern = `**/api/runs/${runId}/artifacts/${nodeId}/${index}/save`;
    if (kind === 'video') {
      expectedNetworkFailure = true;
      await page.route(pattern, route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Controlled local save failure', code: 'SAVE_FAILED' }) }));
      const failedSaveResponse = page.waitForResponse(response => response.url().endsWith(`/artifacts/${nodeId}/${index}/save`) && response.status() === 500);
      await page.getByLabel(`save-asset-${key}`, { exact: true }).click();
      await (await failedSaveResponse).finished();
      await until(() => page.getByLabel(`save-asset-${key}`, { exact: true }).isEnabled(), enabled => enabled, 'local save failure can retry');
      assert.equal((await api<Run>(`/api/runs/${runId}`)).status, 'succeeded');
      await page.unroute(pattern); expectedNetworkFailure = false;
    }
    await page.getByLabel(`save-asset-${key}`, { exact: true }).click();
    const savedRun = await until(() => api<Run>(`/api/runs/${runId}`), r => Boolean(r.results[nodeId].artifacts[index].localUrl), `${kind} saved locally`);
    const saved = savedRun.results[nodeId].artifacts[index];
    assert.equal(saved.url, original.url, 'original upstream reference remains unchanged');
    assert.match(saved.localUrl!, /^\/api\/media\/[a-f0-9]{64}$/);
    assert.equal((await fetch(`${origin}${saved.localUrl}`)).status, 403, 'local media is private');
    const response = await fetch(`${origin}${saved.localUrl}`, { headers: { Origin: origin, 'X-Canvas-Token': session.token } });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, saved.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), saved.sha256);
    const downloadEvent = page.waitForEvent('download');
    await page.getByLabel(`download-asset-${key}`, { exact: true }).click();
    const mediaDownload = await downloadEvent; const output = path.join(dataDir, `${kind}-download`); await mediaDownload.saveAs(output);
    assert.equal(createHash('sha256').update(readFileSync(output)).digest('hex'), saved.sha256);
    savedArtifacts.push({ runId, nodeId, index, localUrl: saved.localUrl!, sha256: saved.sha256! });
    await page.locator('.asset-preview-button').first().click();
    const media = page.getByLabel('asset-preview', { exact: true }).locator(kind === 'video' ? 'video' : 'img');
    await until(() => media.getAttribute('src'), src => src === saved.localUrl, 'preview prefers private local media');
    await page.getByLabel('close-asset-preview').click();
  }
  assert.equal(generationRequests, generationsBeforeSave, 'save and save retry never generate again');
  await page.getByLabel('gallery-filter-video').click();
  await page.locator('.asset-preview-button').first().click();
  await page.getByLabel('asset-preview', { exact: true }).waitFor();
  await until(() => page.getByLabel('asset-preview', { exact: true }).locator('video').evaluate(el => (el as HTMLVideoElement).currentTime), n => n > 0.05, 'gallery preview playback');
  await page.getByLabel('close-asset-preview').click();
  await page.getByLabel('open-board-welcome').first().click();
  await page.getByLabel('board-name', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('board-name', { exact: true }).inputValue(), 'welcome');
  assert.equal(await page.getByLabel('prompt-editor').inputValue(), (await api<AppState>('/api/state')).boards.find(b => b.id === 'welcome')!.nodes.find(n => n.id === 'motion')!.data.prompt);
  await page.getByLabel('back-home').click();
  // Quick entry creates one real persisted node; it does not submit generation.
  for (const kind of ['image', 'video'] as const) {
    page.once('dialog', dialog => void dialog.accept(`Quick ${kind}`));
    await page.getByLabel(`create-${kind}`, { exact: true }).first().click();
    await page.getByLabel('board-name', { exact: true }).waitFor();
    await until(() => api<AppState>('/api/state'), s => s.boards.some(b => b.name === `Quick ${kind}` && b.nodes.length === 1 && b.nodes[0].data.kind === kind), `quick ${kind} project persisted`);
    assert.equal(await page.locator('.react-flow__node').count(), 1);
    await page.getByLabel('back-home').click();
  }
  await page.getByLabel('assets-nav').click();
  await page.getByLabel('open-board-welcome').first().click();
  await until(() => page.getByLabel('prompt-editor').inputValue(), value => value === complete.boards[0].nodes.find(n => n.id === 'motion')!.data.prompt, 'asset source selected across projects');
  await page.getByLabel('back-home').click();
  // Capture useful desktop and narrow layouts with no horizontal page overflow.
  for (const width of [1280, 900]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: path.join(artifacts, `home-${width}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `home fits ${width}`);
    await page.getByLabel('project-card-welcome', { exact: true }).click();
    await page.getByLabel('board-name', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(artifacts, `canvas-${width}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `canvas fits ${width}`);
    await page.getByLabel('back-home').click();
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByLabel('project-card-welcome', { exact: true }).click();
  await page.locator('.react-flow__node[data-id="brief"]').click();
  assert.match(await page.getByLabel('prompt-editor').inputValue(), /edited during save/);
  assert.equal(sessionRequests, sessionsBeforeNavigation, 'view switches never rehydrate and reset the editor');
  // A real isolated runtime restart rotates auth while keeping local content.
  expectedNetworkFailure = true; // State polling may observe the intentional downtime.
  await client.close(); client = undefined;
  const stopped = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM'); await stopped;
  child = launchServer(); child.stdout.on('data', b => logs.push(String(b))); child.stderr.on('data', b => logs.push(String(b)));
  await until(() => fetch(`${origin}/healthz`).then(r => r.ok), ok => ok, 'server restarts');
  const previousToken = session.token;
  session = JSON.parse(readFileSync(path.join(dataDir, 'session.json'), 'utf8')) as { token: string };
  assert.notEqual(session.token, previousToken);
  await page.reload();
  await page.getByLabel('assets-nav').click();
  await page.getByLabel('gallery-filter-video').waitFor();
  expectedNetworkFailure = false;
  for (const [index, saved] of savedArtifacts.entries()) {
    await page.getByLabel(`gallery-filter-${index === 0 ? 'video' : 'image'}`).click();
    assert.equal((await fetch(`${origin}${saved.localUrl}`, { headers: { Origin: origin, 'X-Canvas-Token': previousToken } })).status, 403);
    await page.getByLabel(`gallery-item-${saved.runId}:${saved.nodeId}:${saved.index}`, { exact: true }).click();
    const preview = page.getByLabel('asset-preview', { exact: true });
    if (index === 0) await until(() => preview.locator('video').evaluate(el => (el as HTMLVideoElement).currentTime), value => value > 0.05, 'local video plays after restart');
    else await until(() => preview.locator('img').evaluate(el => (el as HTMLImageElement).naturalWidth), value => value > 0, 'local image decodes after restart');
    await page.getByLabel('close-asset-preview').click();
  }
  await page.screenshot({ path: path.join(artifacts, 'local-assets-v03.png'), fullPage: true });
  expectedNetworkFailure = false;
  assert.deepEqual(failures, [], `Browser console errors: ${failures.join('\n')}`);
  writeFileSync(path.join(artifacts, 'smoke-report.json'), JSON.stringify({ status: 'PASS', browser: await browser.version(), checks: ['creator home and project search', 'edit/save', 'drag', 'connect handles and persist', 'Demo image to video exact reference', 'video playback advances', 'JSON export/import', 'reload', 'MCP list and patch', 'MCP run and idempotent replay', 'Agent UI sync', 'add/delete node', 'provider settings/templates/diagnostics/models', 'private local image/video save and exact download', 'save failure retries without generation', 'local playback after runtime restart and auth rotation', '12 navigation failure and concurrent-edit scenarios', 'asset filters/search/preview/source', 'quick image/video project persistence', 'desktop and narrow viewport layouts', 'no browser errors'], paidRequests: 0 }, null, 2));
  console.log('PASS: creator home, gallery, guarded navigation, canvas, persistence, Demo image/video, MCP tools, Agent UI sync; zero paid requests.');
} catch (error) {
  console.error((error as Error).stack ?? (error as Error).message);
  console.error(logs.join('').slice(-2000));
  if (browser) { const page = browser.contexts()[0]?.pages()[0]; if (page) { await page.screenshot({ path: path.join(artifacts, 'smoke-failure.png') }); writeFileSync(path.join(artifacts, 'smoke-failure.txt'), await page.locator('body').innerText()); } }
  process.exitCode = 1;
} finally {
  await client?.close(); await browser?.close();
  child.kill('SIGTERM');
  await Promise.race([new Promise<void>(r => child.once('exit', () => r())), delay(3000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  rmSync(dataDir, { recursive: true, force: true });
}
