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
import { VideoIntegrityLedger } from '../server/video-integrity-ledger.js';
import type { SegmentCandidate } from '../src/shared/video-integrity.js';

const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from([0,0,0,13]),Buffer.from('IHDR'),Buffer.alloc(12)]);
const policy = { remoteEnabled: false, mediaOrigins: [], providerOrigins: [] };
async function freePort() {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
function syntheticVideo(folder: string) {
  const file = path.join(folder, 'fixture.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'color=c=black:s=128x72:r=8:d=2',
    '-f', 'lavfi', '-i', 'color=c=white:s=128x72:r=8:d=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-y', file,
  ], { timeout: 15_000, maxBuffer: 100_000 });
  return readFileSync(file);
}
async function setup(declaredEndMs = 4000) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-signal-e2e-'));
  const service = new CanvasService(new Store(directory), policy);
  const ledger = new VideoIntegrityLedger(service);
  const reference = await service.importAsset('welcome', {
    expectedRevision: 0, operationId: 'image-input', kind: 'image', name: 'Reference',
  }, 'image/png', png.length, Readable.from([png]) as unknown as IncomingMessage);
  const videoBytes = syntheticVideo(directory);
  const video = await service.importAsset('welcome', {
    expectedRevision: 1, operationId: 'video-input', kind: 'video', name: 'Video',
  }, 'video/mp4', videoBytes.length, Readable.from([videoBytes]) as unknown as IncomingMessage);
  ledger.registerAnchor('welcome', {
    expectedRevision: 0, operationId: 'anchor-1', artifactSha256: reference.asset.artifact.sha256,
  });
  const manifest: SegmentCandidate = {
    schemaVersion: 1, id: 'candidate-1', boardId: 'welcome',
    artifactSha256: video.asset.artifact.sha256!, promptSha256: 'a'.repeat(64),
    modelId: 'fixture-only', anchorIds: ['anchor-1'],
    startMs: 0, endMs: declaredEndMs, assessments: [], events: [],
  };
  ledger.registerCandidate('welcome', { expectedRevision: 1, operationId: 'candidate-op', candidate: manifest });
  const port = await freePort(), origin = 'http://127.0.0.1:' + port;
  const { app, token } = createApp(service, origin, '4'.repeat(64));
  const server = app.listen(port, '127.0.0.1');
  await new Promise<void>(resolve => server.on('listening', resolve));
  return {
    origin, token, ledger, service,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test('real FFmpeg decode reports temporal luminance change through authenticated read-only API', async () => {
  const f = await setup();
  try {
    const api = f.origin + '/api/boards/welcome/video-integrity/candidates/candidate-1/signal-evidence';
    const denied = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 403);
    const headers = { Origin: f.origin, 'X-Canvas-Token': f.token, 'Content-Type': 'application/json' };
    const before = f.ledger.view('welcome');
    assert.equal(before.candidates[0].status, 'proposed');
    const response = await fetch(api, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 200);
    const report = await response.json() as {
      boardId: string; candidateId: string; artifactSha256: string;
      evidence: { scorerVersion: string; coverageFraction: number; totalFrames: number;
        observations: Array<{ kind: string }>; autoApprovalEligible: boolean };
    };
    assert.equal(report.boardId, 'welcome');
    assert.equal(report.candidateId, 'candidate-1');
    assert.equal(report.evidence.scorerVersion, 'ffmpeg-signalstats-v1');
    assert.ok(report.evidence.totalFrames >= 7);
    assert.ok(report.evidence.coverageFraction >= 0.9);
    assert.ok(report.evidence.observations.some(e => e.kind === 'brightness_jump'));
    assert.equal(report.evidence.autoApprovalEligible, false);
    assert.equal(f.ledger.view('welcome').revision, before.revision);
    assert.equal(f.ledger.view('welcome').checkpoints.length, 0);
    assert.equal(f.service.media.openFileCount(), 0);
    const otherBoard = f.service.create('Other board');
    const crossBoard = await fetch(
      f.origin + '/api/boards/' + otherBoard.id + '/video-integrity/candidates/candidate-1/signal-evidence',
      { method: 'POST', headers, body: '{}' },
    );
    assert.equal(crossBoard.status, 404);
  } finally { await f.close(); }
});

test('candidate media duration mismatch fails closed without changing approval lineage', async () => {
  const f = await setup(6000);
  try {
    const response = await fetch(
      f.origin + '/api/boards/welcome/video-integrity/candidates/candidate-1/signal-evidence',
      { method: 'POST', headers: { Origin: f.origin, 'X-Canvas-Token': f.token, 'Content-Type': 'application/json' }, body: '{}' },
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, 'VIDEO_DURATION_MISMATCH');
    assert.equal(f.ledger.view('welcome').revision, 2);
    assert.equal(f.ledger.view('welcome').checkpoints.length, 0);
  } finally { await f.close(); }
});
