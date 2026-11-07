import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WorldSceneStore } from '../server/world-store.js';
import { Store } from '../server/store.js';
import { CanvasService } from '../server/service.js';
import { createApp } from '../server/app.js';
import type { WorldIR } from '../src/shared/world-ir.js';

const transform = () => ({
  positionM: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
});

function scene(worldId = 'world_demo', sceneId = 'scene_demo'): WorldIR {
  return {
    schemaVersion: 1, worldId, sceneId, revision: 0,
    coordinateFrame: 'RH_Y_UP_METERS',
    timebase: { fpsNumerator: 24, fpsDenominator: 1 },
    durationSeconds: 6,
    entities: [{ id: 'lead', label: 'Lead', kind: 'character', transform: transform(), authority: 'approved' }],
    cameras: [{ id: 'cam', label: 'Camera', transform: transform(), authority: 'approved',
      lens: { focalLengthMm: 50, sensorWidthMm: 36, focusDistanceM: 3, fStop: 2.8 } }],
    shots: [{ id: 'shot', label: 'Medium shot', cameraId: 'cam',
      startSeconds: 0, endSeconds: 6, authority: 'approved' }],
    events: [], relations: [], constraints: [],
  };
}
function writeInput(value: WorldIR, expectedRevision: number, operationId: string = randomUUID()) {
  return { expectedRevision, operationId, confirmApproved: true, scene: value };
}
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'reachflow-world-scenes-'));
  return {
    directory,
    worlds: new WorldSceneStore(directory),
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}
function errorCode(fn: () => unknown, code: string) {
  assert.throws(fn, e => e !== null && typeof e === 'object' && 'code' in e && e.code === code);
}

test('scene sidecar round-trips across restarts with stable immutable history', () => {
  const f = fixture();
  try {
    const initial = scene();
    const input = writeInput(initial, 0);
    const saved = f.worlds.save('world_demo', 'scene_demo', input);
    assert.equal(saved.committedRevision, 1);
    assert.equal(saved.currentRevision, 1);
    assert.equal(saved.replayed, false);
    assert.equal(saved.scene.revision, 1);
    const edited: WorldIR = { ...saved.scene, shots: [{ ...saved.scene.shots[0], label: 'Close up' }] };
    const second = f.worlds.save('world_demo', 'scene_demo', writeInput(edited, 1));
    assert.equal(second.scene.revision, 2);
    const restarted = new WorldSceneStore(f.directory);
    assert.equal(restarted.read('world_demo', 'scene_demo').shots[0].label, 'Close up');
    assert.equal(restarted.read('world_demo', 'scene_demo', 1).shots[0].label, 'Medium shot');
    assert.deepEqual(restarted.listRevisions('world_demo', 'scene_demo').revisions.map(r => r.revision), [1, 2]);
  } finally { f.close(); }
});

test('stale revision produces 409 without modifying persisted world journal', () => {
  const f = fixture();
  try {
    f.worlds.save('world_demo', 'scene_demo', writeInput(scene(), 0));
    const bytes = readFileSync(f.worlds.file);
    errorCode(() => f.worlds.save('world_demo', 'scene_demo', writeInput(scene(), 0)), 'WORLD_REVISION_CONFLICT');
    assert.deepEqual(readFileSync(f.worlds.file), bytes);
  } finally { f.close(); }
});

test('stable operationId is replay-safe after later updates and process restart', () => {
  const f = fixture();
  try {
    const input = writeInput(scene(), 0, 'operation_original');
    const first = f.worlds.save('world_demo', 'scene_demo', input);
    const updated = scene();
    updated.revision = 1;
    updated.entities[0].label = 'Changed';
    f.worlds.save('world_demo', 'scene_demo', writeInput(updated, 1, 'operation_second'));
    const before = readFileSync(f.worlds.file);
    const replay = new WorldSceneStore(f.directory).save('world_demo', 'scene_demo', input);
    assert.equal(replay.replayed, true);
    assert.equal(replay.committedRevision, 1);
    assert.equal(replay.currentRevision, 2);
    assert.deepEqual(replay.scene, first.scene);
    assert.deepEqual(readFileSync(f.worlds.file), before);
  } finally { f.close(); }
});

test('reuse of operationId with different request is refused and causes no write', () => {
  const f = fixture();
  try {
    f.worlds.save('world_demo', 'scene_demo', writeInput(scene(), 0, 'same_op'));
    const bytes = readFileSync(f.worlds.file);
    const changed = scene();
    changed.entities[0].label = 'Different';
    errorCode(() => f.worlds.save('world_demo', 'scene_demo', writeInput(changed, 0, 'same_op')), 'WORLD_OPERATION_CONFLICT');
    assert.deepEqual(readFileSync(f.worlds.file), bytes);
  } finally { f.close(); }
});

test('proposed objects cannot enter approved world state, even with a write token', () => {
  const f = fixture();
  try {
    const proposed = scene();
    proposed.shots[0].authority = 'proposed';
    errorCode(() => f.worlds.save('world_demo', 'scene_demo', writeInput(proposed, 0)), 'WORLD_REVIEW_REQUIRED');
    assert.equal(existsSync(f.worlds.file), false);
  } finally { f.close(); }
});

test('invalid identity, malformed fields and unsafe input are rejected before persistence', () => {
  const f = fixture();
  try {
    errorCode(() => f.worlds.save('../foo', 'scene_demo', writeInput(scene(), 0)), 'INVALID_WORLD_ID');
    errorCode(() => f.worlds.save('world_demo', 'wrong_scene', writeInput(scene(), 0)), 'WORLD_IDENTITY_CONFLICT');
    errorCode(() => f.worlds.save('world_demo', 'scene_demo',
      { ...writeInput(scene(), 0), confirmApproved: false }), 'INVALID_WORLD_WRITE');
    const invalid = scene();
    invalid.shots[0].cameraId = 'missing';
    errorCode(() => f.worlds.save('world_demo', 'scene_demo', writeInput(invalid, 0)), 'INVALID_WORLD_WRITE');
    assert.equal(existsSync(f.worlds.file), false);
  } finally { f.close(); }
});

test('independent world scenes have independent revisions and revision histories', () => {
  const f = fixture();
  try {
    f.worlds.save('world_demo', 'scene_demo', writeInput(scene(), 0, 'op_scene_a'));
    f.worlds.save('world_demo', 'scene_second', writeInput(scene('world_demo', 'scene_second'), 0, 'op_scene_b'));
    assert.equal(f.worlds.read('world_demo', 'scene_demo').revision, 1);
    assert.equal(f.worlds.read('world_demo', 'scene_second').revision, 1);
    errorCode(() => f.worlds.read('world_demo', 'missing'), 'WORLD_NOT_FOUND');
    errorCode(() => f.worlds.read('world_demo', 'scene_second', 2), 'WORLD_NOT_FOUND');
  } finally { f.close(); }
});

test('tampered and unsafe sidecar files fail closed without replacing data', () => {
  const f = fixture();
  try {
    writeFileSync(f.worlds.file, 'invalid-json', { mode: 0o600 });
    errorCode(() => f.worlds.read('world_demo', 'scene_demo'), 'WORLD_STORE_INVALID');
    rmSync(f.worlds.file);
    writeFileSync(f.worlds.file, '{}', { mode: 0o600 });
    chmodSync(f.worlds.file, 0o644);
    errorCode(() => f.worlds.read('world_demo', 'scene_demo'), 'WORLD_STORE_INVALID');
    rmSync(f.worlds.file);
    const target = path.join(f.directory, 'unrelated.txt');
    writeFileSync(target, 'must survive', { mode: 0o600 });
    symlinkSync(target, f.worlds.file);
    errorCode(() => f.worlds.save('world_demo', 'scene_demo', writeInput(scene(), 0)), 'WORLD_STORE_INVALID');
    assert.equal(readFileSync(target, 'utf8'), 'must survive');
  } finally { f.close(); }
});

async function freePort() {
  const socket = net.createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return port;
}

test('authenticated HTTP API supports 201/create, 200/retry, 409/CAS, historical reads, without changing Board', async () => {
  const f = fixture();
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const currentStore = new Store(f.directory);
  const workspaceBefore = readFileSync(currentStore.file);
  const { app, token } = createApp(new CanvasService(currentStore), origin, '7'.repeat(64));
  assert.equal(typeof token, 'string');
  const server = app.listen(port, '127.0.0.1') as http.Server;
  await new Promise<void>(resolve => server.on('listening', resolve));
  const url = `${origin}/api/worlds/world_demo/scenes/scene_demo`;
  const headers = { Origin: origin, 'X-Canvas-Token': token, 'Content-Type': 'application/json' };
  try {
    const unauth = await fetch(url);
    assert.ok(unauth.status >= 400);
    const create = await fetch(url, { method: 'PUT', headers,
      body: JSON.stringify(writeInput(scene(), 0, 'api_creation')) });
    assert.equal(create.status, 201);
    const created = await create.json() as { committedRevision: number; currentRevision: number; replayed: boolean };
    assert.equal(created.committedRevision, 1);
    assert.equal(created.replayed, false);
    const replay = await fetch(url, { method: 'PUT', headers,
      body: JSON.stringify(writeInput(scene(), 0, 'api_creation')) });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { replayed: boolean }).replayed, true);
    const stale = await fetch(url, { method: 'PUT', headers,
      body: JSON.stringify(writeInput(scene(), 0, 'api_stale')) });
    assert.equal(stale.status, 409);
    const read = await fetch(url, { headers });
    assert.equal(read.status, 200);
    assert.equal((await read.json() as WorldIR).revision, 1);
    const history = await fetch(`${url}/revisions`, { headers });
    assert.equal(history.status, 200);
    assert.deepEqual((await history.json() as { revisions: { revision: number }[] }).revisions.map(x => x.revision), [1]);
    assert.equal((await fetch(`${url}?revision=1`, { headers })).status, 200);
    assert.equal((await fetch(`${url}?revision=invalid`, { headers })).status, 400);
    assert.deepEqual(readFileSync(currentStore.file), workspaceBefore);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    f.close();
  }
});
