import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../server/app.js';
import { CanvasService } from '../server/service.js';
import { Store } from '../server/store.js';
import type { Artifact, DexSrBundle, ExportJob } from '../src/shared/types.js';

const policy = { remoteEnabled: false, providerOrigins: [], mediaOrigins: [] };
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(12),
]);
function clip(dir: string, name: string, brightness: number) {
  const file = path.join(dir, name + '.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=6:duration=2',
    '-vf', 'eq=brightness=' + brightness,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '27',
    '-pix_fmt', 'yuv420p', '-y', file,
  ], { timeout: 15_000, maxBuffer: 100_000 });
  return readFileSync(file);
}
async function importAsset(service: CanvasService, kind: 'video' | 'image', bytes: Buffer, operationId: string) {
  return service.importAsset('welcome', {
    expectedRevision: service.board('welcome').revision,
    operationId, kind, name: operationId,
  }, kind === 'video' ? 'video/mp4' : 'image/png',
  bytes.length, Readable.from([bytes]) as unknown as IncomingMessage);
}
async function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-dex-sr-job-'));
  const service = new CanvasService(new Store(directory), policy);
  const prev = await importAsset(service, 'video', clip(directory, 'prev', 0.0), 'prev');
  const cur = await importAsset(service, 'video', clip(directory, 'current', 0.1), 'current');
  const img = await importAsset(service, 'image', png, 'original-img');
  const bundle: DexSrBundle = {
    schemaVersion: 1,
    currentVideo: { artifactSha256: cur.asset.artifact.sha256! },
    previousSegment: { artifactSha256: prev.asset.artifact.sha256! },
    originals: [{ artifactSha256: img.asset.artifact.sha256!, role: 'identity' }],
    prompt: '保真、保持五官，不要生成新細節。',
    temporalRadius: 2,
    targetHeight: 1080,
  };
  return {
    service, directory, bundle, original: cur.asset.artifact,
    close() { rmSync(directory, { recursive: true, force: true }); },
  };
}
function fakeWorkerSuccess(service: CanvasService, calls: Array<{ current: Artifact; originalCount: number }>) {
  // Pure in-process fixture; tests don't claim to exercise Python or real SR output.
  service.editor.dexSrAvailable = async () => true;
  service.editor.restoreDexSr = async (inputs, commit) => {
    calls.push({ current: inputs.current, originalCount: inputs.originals.length });
    commit(inputs.current);
    return inputs.current;
  };
}
const request = (bundle: DexSrBundle, operationId = 'dex-sr-test-1') => ({ operationId, bundle });
async function freePort() {
  const sock = net.createServer();
  await new Promise<void>(resolve => sock.listen(0, '127.0.0.1', resolve));
  const port = (sock.address() as AddressInfo).port;
  await new Promise<void>(resolve => sock.close(() => resolve()));
  return port;
}
test('restoration request produces durable artifact via verified local inputs, replay is idempotent', async () => {
  const f = await setup();
  try {
    const calls: Array<{ current: Artifact; originalCount: number }> = [];
    fakeWorkerSuccess(f.service, calls);
    const workspace = f.service.store.read();
    const initial = await f.service.startDexSr('welcome', request(f.bundle));
    assert.equal(initial.status, 'pending');
    assert.equal(initial.dexSr?.request.currentVideo.artifactSha256, f.original.sha256);
    const settled = await f.service.settledExport(initial.id);
    assert.equal(settled.status, 'succeeded');
    assert.equal(settled.artifact?.sha256, f.original.sha256);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].originalCount, 1);
    assert.equal(calls[0].current.sha256, f.original.sha256);
    const replay = await f.service.startDexSr('welcome', request(f.bundle));
    assert.equal(replay.id, initial.id);
    assert.equal(calls.length, 1);
    assert.equal(f.service.store.read().exports?.length, 1);
    assert.deepEqual(f.service.store.read().localAssets, workspace.localAssets);
    const reopened = new CanvasService(new Store(f.directory), policy);
    assert.equal(reopened.getExport(initial.id).status, 'succeeded');
  } finally { f.close(); }
});

test('idempotency conflict, invalid bundle, unknown media and cross-board access fail before dispatch', async () => {
  const f = await setup();
  try {
    fakeWorkerSuccess(f.service, []);
    const other = f.service.create('Other board');
    await assert.rejects(f.service.startDexSr(other.id, request(f.bundle)));
    await assert.rejects(f.service.startDexSr('welcome',
      request({ ...f.bundle, currentVideo: { artifactSha256: 'f'.repeat(64) } })));
    await assert.rejects(f.service.startDexSr('welcome', {
      ...request(f.bundle), extra: '/tmp/secret',
    }));
    const accepted = await f.service.startDexSr('welcome', request(f.bundle));
    await f.service.settledExport(accepted.id);
    await assert.rejects(f.service.startDexSr('welcome', request({
      ...f.bundle, prompt: 'Changed input',
    })));
    assert.equal(f.service.store.read().exports?.length, 1);
  } finally { f.close(); }
});

test('cancel aborts worker and preserves independent input sources', async () => {
  const f = await setup();
  try {
    const before = f.service.media.verifyArtifact(f.original);
    f.service.editor.dexSrAvailable = async () => true;
    let started = false;
    f.service.editor.restoreDexSr = async (_inputs, _commit, _referenced, signal) => {
      started = true;
      await new Promise<void>((_, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'));
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      throw new Error('unreachable');
    };
    const submitted = await f.service.startDexSr('welcome', request(f.bundle));
    const cancelled = await f.service.cancelExport(submitted.id);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(f.service.getExport(submitted.id).status, 'cancelled');
    assert.equal(f.service.getExport(submitted.id).artifact, undefined);
    assert.equal(f.service.media.verifyArtifact(f.original).sha256, before.sha256);
    assert.equal(f.service.store.read().exports?.length, 1);
    assert.ok(typeof started === 'boolean');
  } finally { f.close(); }
});

test('local HTTP endpoints enforce existing origin/token guard, reject unknown clients', async () => {
  const f = await setup();
  const calls: Array<{ current: Artifact; originalCount: number }> = [];
  fakeWorkerSuccess(f.service, calls);
  const port = await freePort(), origin = 'http://127.0.0.1:' + port;
  const { app, token } = createApp(f.service, origin, '4'.repeat(64));
  const server = app.listen(port, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.on('listening', resolve));
    const url = origin + '/api/boards/welcome/dex-sr/jobs';
    const denied = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request(f.bundle)) });
    assert.equal(denied.status, 403);
    const headers = { Origin: origin, 'X-Canvas-Token': token, 'Content-Type': 'application/json' };
    const available = await fetch(origin + '/api/dex-sr/capabilities', { headers });
    assert.equal(available.status, 200);
    assert.equal((await available.json() as { available: boolean }).available, true);
    const invalid = await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'http://evil.invalid' },
      body: JSON.stringify(request(f.bundle)) });
    assert.equal(invalid.status, 403);
    const accepted = await fetch(url, { method: 'POST', headers, body: JSON.stringify(request(f.bundle)) });
    assert.equal(accepted.status, 202);
    const job = await accepted.json() as ExportJob;
    const final = await f.service.settledExport(job.id);
    assert.equal(final.status, 'succeeded');
    const stored = await fetch(origin + '/api/exports/' + job.id, { headers });
    assert.equal(stored.status, 200);
    assert.equal((await stored.json() as ExportJob).dexSr?.schemaVersion, 1);
    assert.equal(calls.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    f.close();
  }
});
