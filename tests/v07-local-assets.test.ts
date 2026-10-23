import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createApp } from '../server/app.js';
import { MediaStore, MAX_MEDIA_BYTES } from '../server/media.js';
import { CanvasService } from '../server/service.js';
import { atomicWrite, Store } from '../server/store.js';
import type { Board, GenerationRequest, Provider, StoreData } from '../src/shared/types.js';

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(12),
]);
const otherPng = Buffer.concat([png, Buffer.from([1])]);

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function apiFixture(generator?: (provider: Provider, request: GenerationRequest) => Promise<{ artifacts: Array<{ kind: 'image' | 'video'; url: string }> }>) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v07-assets-'));
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const policy = { remoteEnabled: true, providerOrigins: ['https://api.openai.com'], mediaOrigins: ['https://media.example.com'] };
  const service = new CanvasService(new Store(directory), policy, generator);
  const { app, token } = createApp(service, origin, '7'.repeat(64));
  const server = app.listen(port, '127.0.0.1');
  await new Promise<void>(resolve => server.on('listening', resolve));
  const headers = { Origin: origin, 'X-Canvas-Token': token };
  return { directory, headers, origin, server, service, async close() {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  } };
}

function importUrl(origin: string, operationId: string, expectedRevision = 0, name = 'Local image') {
  return `${origin}/api/boards/welcome/imports?expectedRevision=${expectedRevision}&operationId=${operationId}&kind=image&name=${encodeURIComponent(name)}`;
}

test('authenticated raw import is atomic, durable, replay-safe, executable, and privately served', async () => {
  const context = await apiFixture();
  const operationId = randomUUID();
  try {
    const imported = await fetch(importUrl(context.origin, operationId), { method: 'POST', headers: { ...context.headers, 'Content-Type': 'image/png', 'Content-Length': String(png.length) }, body: png });
    assert.equal(imported.status, 201);
    assert.equal(imported.headers.get('connection'), 'close');
    const result = await imported.json() as { board: Board; asset: NonNullable<StoreData['localAssets']>[number]; nodePresent: boolean };
    assert.equal(result.nodePresent, true);
    assert.equal(result.asset.id, operationId);
    assert.equal(result.asset.artifact.url, `/api/media/${result.asset.artifact.sha256}`);
    assert.equal(result.asset.artifact.demo, undefined);
    assert.equal(context.service.store.read().localAssets?.length, 1);
    const run = context.service.start({ boardId: 'welcome', expectedRevision: 1, operationId: randomUUID(), nodeId: result.asset.nodeId });
    const completed = await context.service.settled(run.id);
    assert.equal(completed.status, 'succeeded');
    assert.deepEqual(completed.results[result.asset.nodeId].artifacts[0], result.asset.artifact);
    const media = await fetch(`${context.origin}${result.asset.artifact.localUrl}`, { headers: context.headers });
    assert.equal(media.status, 200);
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), png);

    const removed = context.service.patch('welcome', 1, [{ type: 'remove_node', id: result.asset.nodeId }]);
    assert.equal(removed.revision, 2);
    const replay = await fetch(importUrl(context.origin, operationId, 0), { method: 'POST', headers: { ...context.headers, 'Content-Type': 'image/png', 'Content-Length': String(png.length) }, body: png });
    assert.equal(replay.status, 201);
    const replayed = await replay.json() as { board: Board; asset: typeof result.asset; nodePresent: boolean };
    assert.equal(replayed.board.revision, 2);
    assert.equal(replayed.nodePresent, false);
    assert.deepEqual(replayed.asset, result.asset);
    const conflict = await fetch(importUrl(context.origin, operationId, 0), { method: 'POST', headers: { ...context.headers, 'Content-Type': 'image/png', 'Content-Length': String(otherPng.length) }, body: otherPng });
    assert.equal(conflict.status, 409);
    assert.equal(context.service.store.read().localAssets?.length, 1);
  } finally { await context.close(); }
});

test('multiple imports choose deterministic non-overlapping positions without moving existing or replayed nodes', async () => {
  const context = await apiFixture();
  try {
    const original = context.service.board('welcome');
    const originalPositions = new Map(original.nodes.map(node => [node.id, structuredClone(node.position)]));
    const operationIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    let revision = original.revision;
    const importedNodes: Board['nodes'] = [];
    for (const [index, operationId] of operationIds.entries()) {
      const response = await fetch(importUrl(context.origin, operationId, revision, `Import ${index + 1}`), { method: 'POST', headers: { ...context.headers, 'Content-Type': 'image/png', 'Content-Length': String(png.length) }, body: png });
      assert.equal(response.status, 201);
      const result = await response.json() as { board: Board; asset: NonNullable<StoreData['localAssets']>[number] };
      revision = result.board.revision;
      importedNodes.push(result.board.nodes.find(node => node.id === result.asset.nodeId)!);
    }
    const board = context.service.board('welcome');
    for (const [id, position] of originalPositions) assert.deepEqual(board.nodes.find(node => node.id === id)?.position, position);
    for (const imported of importedNodes) for (const originalNode of original.nodes) {
      const a = imported.position, b = originalNode.position;
      assert.ok(a.x + 340 <= b.x || b.x + 340 <= a.x || a.y + 240 <= b.y || b.y + 240 <= a.y);
    }
    for (let left = 0; left < importedNodes.length; left += 1) for (let right = left + 1; right < importedNodes.length; right += 1) {
      const a = importedNodes[left].position, b = importedNodes[right].position;
      assert.ok(a.x + 340 <= b.x || b.x + 340 <= a.x || a.y + 240 <= b.y || b.y + 240 <= a.y);
    }
    const beforeReplay = board.nodes.map(node => ({ id: node.id, position: structuredClone(node.position) }));
    const replay = await fetch(importUrl(context.origin, operationIds[0], 0, 'Import 1'), { method: 'POST', headers: { ...context.headers, 'Content-Type': 'image/png', 'Content-Length': String(png.length) }, body: png });
    assert.equal(replay.status, 201);
    assert.deepEqual((await replay.json() as { board: Board }).board.nodes.map(node => ({ id: node.id, position: node.position })), beforeReplay);
  } finally { await context.close(); }
});

test('registry authority rejects unknown and cross-board asset IDs while remote use gets only verified ephemeral bytes', async () => {
  const requests: GenerationRequest[] = [];
  const priorKey = process.env.RELAY_KEY_REMOTE;
  process.env.RELAY_KEY_REMOTE = 'fixture-credential';
  const context = await apiFixture(async (_provider, request) => {
    requests.push(request);
    return { artifacts: [{ kind: request.kind, url: 'https://media.example.com/output.mp4' }] };
  });
  try {
    const operationId = randomUUID();
    const response = await fetch(importUrl(context.origin, operationId), { method: 'POST', headers: { ...context.headers, 'Content-Type': 'image/png', 'Content-Length': String(png.length) }, body: png });
    const imported = await response.json() as { board: Board; asset: NonNullable<StoreData['localAssets']>[number] };
    const openai: Provider = { id: 'remote', name: 'Remote', protocol: 'relay', baseUrl: 'https://api.openai.com/v1', keyEnv: 'RELAY_KEY_REMOTE', imageModel: 'gpt-image-1', videoModel: 'video-model' };
    context.service.providers([openai]);
    const videoId = randomUUID();
    const updated = context.service.patch('welcome', 1, [
      { type: 'add_node', node: { id: videoId, type: 'canvas', position: { x: 100, y: 0 }, data: { kind: 'video', label: 'Video', providerId: 'remote', model: 'video-model', prompt: 'Animate' } } },
      { type: 'connect', edge: { id: randomUUID(), source: imported.asset.nodeId, target: videoId } },
    ]);
    const run = context.service.start({ boardId: 'welcome', expectedRevision: updated.revision, operationId: randomUUID(), nodeId: videoId, confirmExternal: true });
    const completed = await context.service.settled(run.id);
    assert.equal(completed.status, 'succeeded');
    assert.equal(requests.length, 1);
    assert.match(requests[0].referenceUrl!, /^data:image\/png;base64,/);
    assert.equal(completed.results[videoId].referenceUrl, imported.asset.artifact.url);
    assert.doesNotMatch(readFileSync(context.service.store.file, 'utf8'), /data:image\/png;base64/);

    const large = Buffer.alloc(4 * 1024 * 1024 + 1); png.copy(large);
    const largeId = randomUUID();
    const largeResponse = await fetch(importUrl(context.origin, largeId, updated.revision, 'Large image'), { method: 'POST', headers: { ...context.headers, 'Content-Type': 'image/png', 'Content-Length': String(large.length) }, body: large });
    assert.equal(largeResponse.status, 201);
    const largeImport = await largeResponse.json() as { board: Board; asset: NonNullable<StoreData['localAssets']>[number] };
    const blockedVideoId = randomUUID();
    const blockedBoard = context.service.patch('welcome', largeImport.board.revision, [
      { type: 'add_node', node: { id: blockedVideoId, type: 'canvas', position: { x: 200, y: 0 }, data: { kind: 'video', label: 'Blocked video', providerId: 'remote', model: 'video-model', prompt: 'Animate' } } },
      { type: 'connect', edge: { id: randomUUID(), source: largeImport.asset.nodeId, target: blockedVideoId } },
    ]);
    const blockedRun = context.service.start({ boardId: 'welcome', expectedRevision: blockedBoard.revision, operationId: randomUUID(), nodeId: blockedVideoId, confirmExternal: true });
    assert.equal((await context.service.settled(blockedRun.id)).status, 'failed');
    assert.equal(requests.length, 1);

    const second = context.service.create('Second');
    const crossBoard: Board = { ...second, nodes: [{ id: randomUUID(), type: 'canvas', position: { x: 0, y: 0 }, data: { kind: 'asset', label: 'Stolen', assetId: operationId, assetKind: 'image' } }] };
    assert.throws(() => context.service.save(second.id, 0, crossBoard), /不屬於此畫布/);
    const unknown = context.service.board('welcome');
    unknown.nodes.push({ id: randomUUID(), type: 'canvas', position: { x: 0, y: 0 }, data: { kind: 'asset', label: 'Unknown', assetId: 'unknown', assetKind: 'image' } });
    assert.throws(() => context.service.save('welcome', updated.revision, unknown), /素材不屬於此畫布/);
  } finally {
    if (priorKey === undefined) delete process.env.RELAY_KEY_REMOTE; else process.env.RELAY_KEY_REMOTE = priorKey;
    await context.close();
  }
});

test('two slow imports hold admission through settlement and a third is rejected before body read', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v07-admission-'));
  try {
    const service = new CanvasService(new Store(directory));
    const operationId = randomUUID();
    const one = new PassThrough(), two = new PassThrough(), three = new PassThrough();
    const input = { expectedRevision: 0, operationId, kind: 'image' as const, name: 'Concurrent' };
    const first = service.importAsset('welcome', input, 'image/png', png.length, one as unknown as IncomingMessage);
    const second = service.importAsset('welcome', input, 'image/png', png.length, two as unknown as IncomingMessage);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(service.importAsset('welcome', { ...input, operationId: randomUUID() }, 'image/png', png.length, three as unknown as IncomingMessage), (error: unknown) => (error as { code?: string }).code === 'BUSY');
    assert.equal(three.readableEnded, false);
    one.end(png); two.end(png);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.asset.id, b.asset.id);
    assert.equal(service.store.read().localAssets?.length, 1);
    assert.equal(service.board('welcome').revision, 1);
    assert.equal(service.media.openFileCount(), 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('streaming import accepts exactly 64 MiB without whole-body assembly and releases reservation/temp on failures', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v07-max-'));
  try {
    const media = new MediaStore(directory, { remoteEnabled: false, providerOrigins: [], mediaOrigins: [] });
    const reservation = await media.reserveImport(MAX_MEDIA_BYTES);
    async function* chunks() {
      yield png;
      let remaining = MAX_MEDIA_BYTES - png.length;
      const zeroes = Buffer.alloc(64 * 1024);
      while (remaining > 0) { const size = Math.min(remaining, zeroes.length); yield zeroes.subarray(0, size); remaining -= size; }
    }
    const streamed = await media.receiveImport(Readable.from(chunks()) as unknown as IncomingMessage, 'image/png', 'image', MAX_MEDIA_BYTES, { reservation });
    let artifact;
    artifact = await media.commitImport(streamed, () => undefined);
    assert.equal(artifact.bytes, MAX_MEDIA_BYTES);
    assert.equal(media.verifyArtifact(artifact).sha256, artifact.sha256);
    const shortReservation = await media.reserveImport(png.length + 1);
    await assert.rejects(media.receiveImport(Readable.from([png]) as unknown as IncomingMessage, 'image/png', 'image', png.length + 1, { reservation: shortReservation }), /length mismatch/);
    const overReservation = await media.reserveImport(png.length);
    await assert.rejects(media.receiveImport(Readable.from([otherPng]) as unknown as IncomingMessage, 'image/png', 'image', png.length, { reservation: overReservation }), /length mismatch/);
    const timeoutReservation = await media.reserveImport(png.length);
    const stalled = new PassThrough();
    await assert.rejects(media.receiveImport(stalled as unknown as IncomingMessage, 'image/png', 'image', png.length, { reservation: timeoutReservation, deadlineMs: 10 }), /timed out/);
    assert.equal(readdirSync(media.directory).some(name => name.endsWith('.import')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('pre-stream directory failure releases reserved quota, descriptors, temps, and service admission', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v07-prestream-'));
  try {
    const service = new CanvasService(new Store(directory));
    const media = service.media, displaced = `${media.directory}.away`;
    const reserveImport = media.reserveImport.bind(media);
    media.reserveImport = async bytes => {
      const reservation = await reserveImport(bytes);
      renameSync(media.directory, displaced);
      return reservation;
    };
    const stream = new PassThrough(); stream.end(png);
    await assert.rejects(service.importAsset('welcome', { expectedRevision: 0, operationId: randomUUID(), kind: 'image', name: 'Directory race' }, 'image/png', png.length, stream as unknown as IncomingMessage), /匯入失敗/);
    renameSync(displaced, media.directory);
    media.reserveImport = reserveImport;
    assert.equal((service as unknown as { activeImports: number }).activeImports, 0);
    assert.equal(media.openFileCount(), 0);
    assert.equal(readdirSync(media.directory).some(name => name.endsWith('.import')), false);
    const reservations = [];
    for (let index = 0; index < 8; index += 1) reservations.push(await media.reserveImport(MAX_MEDIA_BYTES));
    await assert.rejects(media.reserveImport(1), /quota exceeded/);
    for (const reservation of reservations) await media.releaseReservation(reservation);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('rename-success writer failure retains the committed registry file for exact replay', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v07-reconcile-'));
  try {
    new Store(directory);
    let writes = 0;
    const writer: typeof atomicWrite = (file, value) => { atomicWrite(file, value); writes += 1; if (writes >= 2) throw new Error('late durability signal'); };
    const store = new Store(directory, { write: writer });
    const service = new CanvasService(store);
    const operationId = randomUUID(), first = new PassThrough();
    const pending = service.importAsset('welcome', { expectedRevision: 0, operationId, kind: 'image', name: 'Recovered' }, 'image/png', png.length, first as unknown as IncomingMessage);
    first.end(png);
    await assert.rejects(pending, /無法保存/);
    const reopened = new Store(directory), asset = reopened.read().localAssets?.find(candidate => candidate.id === operationId);
    assert.ok(asset);
    const replayService = new CanvasService(reopened);
    assert.equal(replayService.media.verifyArtifact(asset.artifact).sha256, asset.artifact.sha256);
    const replay = new PassThrough();
    const replayed = replayService.importAsset('welcome', { expectedRevision: 0, operationId, kind: 'image', name: 'Recovered' }, 'image/png', png.length, replay as unknown as IncomingMessage);
    replay.end(png);
    assert.equal((await replayed).asset.id, operationId);
    assert.equal(reopened.read().localAssets?.length, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('v0.7 backup marker is byte-exact and strict, and every transaction validates before custom writer invocation', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v07-upgrade-'));
  try {
    const seed = mkdtempSync(path.join(os.tmpdir(), 'relay-v07-seed-'));
    const initial = new Store(seed).read();
    rmSync(seed, { recursive: true, force: true });
    const original = Buffer.from(JSON.stringify(initial));
    writeFileSync(path.join(directory, 'workspace.json'), original, { mode: 0o600 });
    const store = new Store(directory);
    const backup = path.join(directory, 'workspace.pre-v0.7.json'), marker = path.join(directory, '.workspace-v0.7');
    assert.deepEqual(readFileSync(backup), original);
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.equal(statSync(marker).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { version: '0.7', sourceSha256: createHash('sha256').update(original).digest('hex') });
    store.transaction(data => { data.boards[0].name = 'Later'; });
    assert.deepEqual(readFileSync(backup), original);
    chmodSync(marker, 0o644);
    assert.throws(() => new Store(directory), /Unsafe workspace upgrade artifact/);
  } finally { rmSync(directory, { recursive: true, force: true }); }

  const guarded = mkdtempSync(path.join(os.tmpdir(), 'relay-v07-prewriter-'));
  try {
    let writes = 0;
    const writer: typeof atomicWrite = (file, value) => { writes += 1; atomicWrite(file, value); };
    const store = new Store(guarded, { write: writer });
    const before = writes;
    assert.throws(() => store.transaction(data => { data.localAssets = [{ id: 'broken', boardId: 'welcome', nodeId: 'node', name: 'Broken', createdAt: new Date().toISOString(), artifact: { kind: 'image', url: '/tmp/file' } }]; }), /Invalid request/);
    assert.equal(writes, before);
  } finally { rmSync(guarded, { recursive: true, force: true }); }
});

test('import endpoint rejects auth, encoding, MIME, oversize, and extra query keys before mutation', async () => {
  const context = await apiFixture();
  try {
    const url = importUrl(context.origin, randomUUID());
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).status, 403);
    assert.equal((await fetch(`${url}&extra=x`, { method: 'POST', headers: { ...context.headers, 'Content-Type': 'image/png' }, body: png })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...context.headers, 'Content-Type': 'application/octet-stream' }, body: png })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...context.headers, 'Content-Type': 'image/jpeg' }, body: png })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...context.headers, 'Content-Type': 'image/png', 'Content-Encoding': 'gzip' }, body: png })).status, 400);
    const oversized = await new Promise<number>((resolve, reject) => {
      const request = http.request(url, { method: 'POST', headers: { ...context.headers, 'Content-Type': 'image/png', 'Content-Length': String(MAX_MEDIA_BYTES + 1) } }, response => { response.resume(); resolve(response.statusCode!); });
      request.on('error', reject); request.end();
    });
    assert.equal(oversized, 400);
    assert.equal(context.service.store.read().localAssets?.length ?? 0, 0);
  } finally { await context.close(); }
});
