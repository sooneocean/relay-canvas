import { chromium } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
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
const child = spawn(process.execPath, ['build/server/main.js'], { cwd: root, env: { ...process.env, RELAY_DATA_DIR: dataDir, RELAY_PORT: String(port), RELAY_ENABLE_REMOTE: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const session = JSON.parse(readFileSync(path.join(dataDir, 'session.json'), 'utf8')) as { token: string };
  async function api<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${origin}${endpoint}`, { method, headers: { Origin: origin, 'X-Canvas-Token': session.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!response.ok) throw new Error(`API ${endpoint}: ${response.status}`);
    return response.json() as Promise<T>;
  }
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', e => failures.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error') failures.push(msg.text()); });
  await page.goto(origin);
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
  assert.deepEqual(failures, [], `Browser console errors: ${failures.join('\n')}`);
  writeFileSync(path.join(artifacts, 'smoke-report.json'), JSON.stringify({ status: 'PASS', browser: await browser.version(), checks: ['UI load', 'edit/save', 'drag', 'connect handles and persist', 'Demo image to video exact reference', 'video playback advances', 'JSON export/import', 'reload', 'MCP list and patch', 'MCP run and idempotent replay', 'Agent UI sync', 'add/delete node', 'provider settings', 'no browser errors'], paidRequests: 0 }, null, 2));
  console.log('PASS: browser canvas, persistence, Demo image/video, MCP tools, Agent UI sync; zero paid requests.');
} catch (error) {
  console.error((error as Error).message);
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
