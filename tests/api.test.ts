import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { CanvasService } from '../server/service.js';

async function portNumber() { const s = net.createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const port = (s.address() as net.AddressInfo).port; await new Promise<void>(r => s.close(() => r())); return port; }
test('HTTP boundary, valid session, revision conflict and remote gate work end-to-end', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-api-')), port = await portNumber(), origin = `http://127.0.0.1:${port}`;
  const service = new CanvasService(new Store(dir));
  const { app, token } = createApp(service, origin);
  const server = app.listen(port, '127.0.0.1');
  await new Promise<void>(r => server.on('listening', r));
  const headers = { Origin: origin, 'X-Canvas-Token': token, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(`${origin}/api/state`)).status, 403);
    assert.equal((await fetch(`${origin}/api/state`, { headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
    const spoofedHost = await new Promise<number>(resolve => { const req = httpRequest(`${origin}/api/state`, { headers: { ...headers, Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end(); });
    assert.equal(spoofedHost, 403);
    assert.equal((await fetch(`${origin}/api/state`, { headers: { ...headers, 'X-Canvas-Token': 'wrong' } })).status, 403);
    assert.equal((await fetch(`${origin}/api/session`, { headers: { Origin: origin, 'X-Canvas-Client': 'ui' } })).status, 200);
    const response = await fetch(`${origin}/api/state`, { headers });
    assert.match(response.headers.get('Content-Security-Policy')!, /frame-ancestors 'none'/);
    const state = await response.json() as ReturnType<typeof service.state>;
    assert.equal(state.boards[0].id, 'welcome');
    const body = { board: { ...state.boards[0], name: 'Saved via HTTP' }, expectedRevision: 0 };
    assert.equal((await fetch(`${origin}/api/boards/welcome`, { method: 'PUT', headers, body: JSON.stringify(body) })).status, 200);
    assert.equal((await fetch(`${origin}/api/boards/welcome`, { method: 'PUT', headers, body: JSON.stringify(body) })).status, 409);
    assert.equal((await fetch(`${origin}/api/boards/welcome/patch`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1, operations: [{ type: 'update_node', id: 'brief', data: { assetUrl: 'http://127.0.0.1/private' } }] }) })).status, 400);
    const changed = service.board('welcome'); changed.nodes.find(n => n.id === 'frame')!.data.providerId = 'openai'; service.save(changed.id, 1, changed);
    assert.equal((await fetch(`${origin}/api/runs`, { method: 'POST', headers, body: JSON.stringify({ boardId: 'welcome', expectedRevision: 2, operationId: 'no-remote' }) })).status, 403);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); }
});
