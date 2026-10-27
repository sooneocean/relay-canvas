import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { Store } from '../server/store.js';
import { sourceBrowserFixtures, verifySourceBrowser } from './source-browser-smoke.js';

const root = process.cwd(), work = path.join(root, 'work');
mkdirSync(work, { recursive: true });
const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-source-browser-smoke-'));
const store = new Store(directory);
const sources = sourceBrowserFixtures();
store.transaction(data => { data.boards.push(sources.board); data.runs.push(...sources.runs); });

const probe = net.createServer();
await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
const address = probe.address();
assert.ok(address && typeof address !== 'string');
const port = address.port;
await new Promise<void>(resolve => probe.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['build/server/main.js'], {
  cwd: root,
  env: { ...process.env, RELAY_DATA_DIR: directory, RELAY_PORT: String(port), RELAY_ENABLE_REMOTE: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.resume(); child.stderr.resume();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const end = Date.now() + 15000;
  let healthy = false;
  while (Date.now() < end) {
    try { healthy = (await fetch(`${origin}/healthz`)).ok; } catch { healthy = false; }
    if (healthy) break;
    await delay(100);
  }
  assert.equal(healthy, true, 'source browser server must start');
  const { token } = JSON.parse(readFileSync(path.join(directory, 'session.json'), 'utf8')) as { token: string };
  async function api<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${origin}${endpoint}`, {
      method, headers: { Origin: origin, 'X-Canvas-Token': token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.ok(response.ok, `Source API ${method} ${endpoint}: ${response.status}`);
    return response.json() as Promise<T>;
  }
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
    (existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  browser = await chromium.launch({ headless: true, executablePath });
  await verifySourceBrowser(browser, root, origin, api);
  console.log('PASS: standalone historical Timeline source browsing, preview and persistence checks.');
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, delay(3000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
  }
  rmSync(directory, { recursive: true, force: true });
}
