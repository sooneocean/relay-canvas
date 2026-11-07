import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { CanvasService } from '../server/service.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { DexSrPlanner } from '../server/dex-sr-planner.js';

const policy = { remoteEnabled: false, providerOrigins: [], mediaOrigins: [] };
function video(dir: string, brightness: string): Buffer {
  const file = path.join(dir, 'clip-' + brightness.replace(/[^0-9]/g, '') + '.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=6:duration=2',
    '-vf', 'eq=brightness=' + brightness,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', file,
  ], { timeout: 15_000 });
  return readFileSync(file);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(12),
]);
async function importAsset(service: CanvasService, kind: 'image' | 'video',
  bytes: Buffer, operationId: string, boardId = 'welcome') {
  return service.importAsset(boardId, {
    expectedRevision: service.board(boardId).revision, operationId, kind, name: operationId,
  }, kind === 'image' ? 'image/png' : 'video/mp4', bytes.length,
  Readable.from([bytes]) as unknown as IncomingMessage);
}
async function prepared() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-dex-sr-'));
  const service = new CanvasService(new Store(directory), policy);
  const first = await importAsset(service, 'video', video(directory, '0.00'), 'clip-prev');
  const second = await importAsset(service, 'video', video(directory, '0.10'), 'clip-current');
  const identity = await importAsset(service, 'image', png, 'person-original');
  const scene = await importAsset(service, 'image', Buffer.concat([png, Buffer.from([1])]), 'scene-original');
  return {
    service, directory, first: first.asset.artifact, second: second.asset.artifact,
    identity: identity.asset.artifact, scene: scene.asset.artifact,
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}
const payload = (source: {
  first: { sha256?: string }; second: { sha256?: string };
  identity: { sha256?: string }; scene: { sha256?: string };
}) => ({
  schemaVersion: 1, currentVideo: { artifactSha256: source.second.sha256 },
  previousSegment: { artifactSha256: source.first.sha256 },
  originals: [
    { artifactSha256: source.identity.sha256, role: 'identity' },
    { artifactSha256: source.scene.sha256, role: 'detail' },
  ], prompt: '請保真，保持五官，保留顆粒，不要生成新細節',
  temporalRadius: 2, targetHeight: 1080,
});
async function port() {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const current = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return current;
}

test('plan references a whole prior video, original images and bounded prompt without calling a model', async () => {
  const f = await prepared();
  try {
    const workspace = readFileSync(f.service.store.file);
    const planner = new DexSrPlanner(f.service);
    const p = await planner.plan('welcome', payload(f));
    assert.equal(p.status, 'plan_only');
    assert.equal(p.runnable, false);
    assert.equal(p.current.sha256, f.second.sha256);
    assert.equal(p.previousSegment?.sha256, f.first.sha256);
    assert.equal(p.originals.length, 2);
    assert.equal(p.originals[0].pixelTransfer, 'disabled');
    assert.equal(p.originals[1].pixelTransfer, 'same_view_match_only');
    assert.equal(p.promptPolicy.allowGeneration, false);
    assert.equal(p.promptPolicy.identityLock, true);
    assert.equal(p.promptPolicy.temporalStrength, 0.15);
    assert.equal(p.colorAndCfrValidation, 'deferred_to_worker');
    assert.deepEqual(readFileSync(f.service.store.file), workspace);
    assert.equal(f.service.media.openFileCount(), 0);
  } finally { f.close(); }
});

test('plan fails closed on unknown, cross-board, mismatched kind and duplicate reference', async () => {
  const f = await prepared();
  try {
    const other = f.service.create('Other board');
    await assert.rejects(new DexSrPlanner(f.service).plan(other.id, payload(f)),
      /No verified local source/);
    const bad = [
      { ...payload(f), originals: [payload(f).originals[0], payload(f).originals[0]] },
      { ...payload(f), originals: [{ artifactSha256: f.second.sha256, role: 'identity' }] },
      { ...payload(f), previousSegment: { artifactSha256: f.second.sha256 } },
      { ...payload(f), forbidden: 'file:///etc/passwd' },
      { ...payload(f), temporalRadius: 0 },
    ];
    for (const b of bad) await assert.rejects(new DexSrPlanner(f.service).plan('welcome', b));
  } finally { f.close(); }
});

test('source tampering is rejected even when metadata registry still exists', async () => {
  const f = await prepared();
  try {
    const located = f.service.media.fileFor(f.second as Parameters<typeof f.service.media.fileFor>[0]);
    try { writeFileSync(located.file, Buffer.alloc(f.second.bytes ?? 0)); }
    finally { f.service.media.releaseFile(located.fd); }
    await assert.rejects(new DexSrPlanner(f.service).plan('welcome', payload(f)),
      /Saved asset no longer matches/);
  } finally { f.close(); }
});

test('plan API follows local auth/origin boundary and returns no execution capability', async () => {
  const f = await prepared();
  const listenPort = await port(), origin = 'http://127.0.0.1:' + listenPort;
  const { app, token } = createApp(f.service, origin, '8'.repeat(64));
  const server = app.listen(listenPort, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.on('listening', resolve));
    const url = origin + '/api/boards/welcome/dex-sr/plan';
    const denied = await fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload(f)) });
    assert.equal(denied.status, 403);
    const headers = { Origin: origin, 'X-Canvas-Token': token, 'Content-Type': 'application/json' };
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload(f)) });
    assert.equal(res.status, 200);
    const returned = await res.json() as { status: string; runnable: boolean; previousSegment?: unknown };
    assert.equal(returned.status, 'plan_only');
    assert.equal(returned.runnable, false);
    assert.ok(returned.previousSegment);
    const blocked = await fetch(url, { method: 'POST', headers: { ...headers,
      Origin: 'http://evil.example' }, body: JSON.stringify(payload(f)) });
    assert.equal(blocked.status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    f.close();
  }
});
