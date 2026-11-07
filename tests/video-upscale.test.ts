import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { CanvasService } from '../server/service.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { upscaleBounds } from '../src/shared/upscale.js';
import type { Run } from '../src/shared/types.js';
import net, { type AddressInfo } from 'node:net';

const policy = { remoteEnabled: false, mediaOrigins: [], providerOrigins: [] };
function videoFile(directory: string): Buffer {
  const filename = path.join(directory, 'fixture.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', filename,
  ], { timeout: 20_000, maxBuffer: 100_000 });
  return readFileSync(filename);
}
async function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-upscale-'));
  const service = new CanvasService(new Store(directory), policy);
  const video = videoFile(directory);
  const imported = await service.importAsset('welcome', {
    expectedRevision: 0, operationId: 'source-asset', kind: 'video', name: 'Source clip',
  }, 'video/mp4', video.length, Readable.from([video]) as unknown as IncomingMessage);
  const artifact = imported.asset.artifact;
  const board = service.board('welcome');
  const run: Run = {
    id: 'fixture-run', boardId: 'welcome', revision: board.revision,
    operationId: 'fixture-run-operation', status: 'succeeded',
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    snapshot: board, providers: service.store.read().providers,
    order: ['fixture-node'],
    results: { 'fixture-node': { nodeId: 'fixture-node', status: 'succeeded', artifacts: [artifact] } },
  };
  service.store.transaction(data => { data.runs.push(run); });
  return { directory, service, source: artifact, close: () => rmSync(directory, { recursive: true, force: true }) };
}
const request = (operationId = 'upscale-1') => ({
  operationId, source: { runId: 'fixture-run', nodeId: 'fixture-node', artifactIndex: 0 },
  preset: 'lanczos_1080p',
});
async function freePort(): Promise<number> {
  const sock = net.createServer();
  await new Promise<void>(resolve => sock.listen(0, '127.0.0.1', resolve));
  const port = (sock.address() as AddressInfo).port;
  await new Promise<void>(resolve => sock.close(() => resolve()));
  return port;
}

test('upscale size guard preserves aspect-ratio footprint and refuses no-op/huge enlargement', () => {
  assert.deepEqual(upscaleBounds({ width: 854, height: 480 }), { width: 1920, height: 1080, factor: Math.min(1920/854,1080/480) });
  assert.deepEqual(upscaleBounds({ width: 480, height: 854 }), { width: 1080, height: 1920, factor: Math.min(1080/480,1920/854) });
  assert.throws(() => upscaleBounds({ width: 1920, height: 1080 }), /above target/);
  assert.throws(() => upscaleBounds({ width: 60, height: 100 }), /Unsupported upscale/);
  assert.throws(() => upscaleBounds({ width: 64, height: 64 }), /too large/);
});

test('real saved 320p H264 12fps clip upscales to 1080p while preserving frame count and original source', async () => {
  const f = await fixture();
  try {
    const readSavedSource = () => {
      const opened = f.service.media.fileFor(f.source);
      try { return readFileSync(opened.file); }
      finally { f.service.media.releaseFile(opened.fd); }
    };
    const sourceBefore = readSavedSource();
    const infoBefore = await f.service.editor.probe(f.source);
    assert.equal(infoBefore.width, 320);
    assert.equal(infoBefore.height, 180);
    const initiated = await f.service.startUpscale('welcome', request());
    assert.equal(initiated.upscale?.preset, 'lanczos_1080p');
    assert.equal(initiated.status, 'pending');
    const saved = await f.service.settledExport(initiated.id);
    assert.equal(saved.status, 'succeeded', saved.error);
    assert.equal(saved.artifact?.kind, 'video');
    assert.ok(saved.artifact?.sha256);
    const result = await f.service.editor.probe(saved.artifact!);
    assert.equal(result.width, 1920);
    assert.equal(result.height, 1080);
    assert.ok(Math.abs(result.duration - infoBefore.duration) < 0.15);
    const sourceAfter = f.service.media.verifyArtifact(f.source);
    assert.equal(sourceAfter.sha256, f.source.sha256);
    assert.deepEqual(readSavedSource(), sourceBefore);
    assert.equal(f.service.mediaArtifact(saved.artifact!.sha256!).sha256, saved.artifact!.sha256);
    const count = (artifact: typeof f.source) => {
      const fpath = f.service.media.fileFor(artifact);
      f.service.media.releaseFile(fpath.fd);
      const data = execFileSync('ffprobe', [
        '-v', 'error', '-count_frames', '-select_streams', 'v:0',
        '-show_entries', 'stream=nb_read_frames',
        '-of', 'default=nokey=1:noprint_wrappers=1', fpath.file,
      ], { encoding: 'utf8', timeout: 20_000 });
      return Number(data.trim());
    };
    assert.equal(count(saved.artifact!), count(f.source), 'upsampling must not invent or drop temporal frames');
    const replay = await f.service.startUpscale('welcome', request());
    assert.equal(replay.id, saved.id);
    assert.equal(f.service.store.read().exports?.length, 1);
  } finally { f.close(); }
});

test('upscale rejects foreign source, invalid preset, conflicting operation and unauthenticated API', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.startUpscale('welcome', { ...request(), preset: 'ai_hallucination' }));
    await assert.rejects(f.service.startUpscale('welcome', { ...request(), injectedUrl: 'file:///etc/passwd' }));
    const other = f.service.create('Another board');
    await assert.rejects(f.service.startUpscale(other.id, request()));
    const originPort = await freePort(), origin = 'http://127.0.0.1:' + originPort;
    const { app, token } = createApp(f.service, origin, '1'.repeat(64));
    const server = app.listen(originPort, '127.0.0.1');
    try {
      await new Promise<void>(resolve => server.on('listening', resolve));
      const url = origin + '/api/boards/welcome/upscale';
      const denied = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request()) });
      assert.equal(denied.status, 403);
      const ok = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Canvas-Token': token }, body: JSON.stringify(request()) });
      assert.equal(ok.status, 202);
      const body = await ok.json() as { id: string };
      assert.ok(body.id);
      assert.equal((await f.service.settledExport(body.id)).status, 'succeeded');
      const replay = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Canvas-Token': token }, body: JSON.stringify(request()) });
      assert.equal(replay.status, 202);
      assert.equal((await replay.json() as { id: string }).id, body.id);
      assert.equal(f.service.store.read().exports?.length, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  } finally { f.close(); }
});
