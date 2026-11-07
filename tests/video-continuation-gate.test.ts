import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../server/app.js';
import { CanvasService } from '../server/service.js';
import { Store } from '../server/store.js';
import { VideoIntegrityLedger } from '../server/video-integrity-ledger.js';
import { VerifiedContinuationGate } from '../server/video-continuation-gate.js';
import type { SegmentCandidate } from '../src/shared/video-integrity.js';

const policy = { remoteEnabled: false, mediaOrigins: [], providerOrigins: [] };
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(12),
]);
function mp4(marker: number) {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp'),
    Buffer.from('isom'), Buffer.alloc(12, marker),
  ]);
}
function throwsCode(code: string) {
  return (error: unknown) =>
    !!error && typeof error === 'object' && 'code' in error && error.code === code;
}
async function importMedia(service: CanvasService, kind: 'image' | 'video', bytes: Buffer, operationId: string) {
  const expectedRevision = service.board('welcome').revision;
  return service.importAsset('welcome', {
    expectedRevision, operationId, name: operationId, kind,
  }, kind === 'image' ? 'image/png' : 'video/mp4', bytes.length,
  Readable.from([bytes]) as unknown as IncomingMessage);
}
async function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-video-preflight-'));
  const service = new CanvasService(new Store(directory), policy);
  const ledger = new VideoIntegrityLedger(service);
  const gate = new VerifiedContinuationGate(ledger);
  const reference = await importMedia(service, 'image', png, 'reference');
  const first = await importMedia(service, 'video', mp4(3), 'clip-one');
  const firstSha = first.asset.artifact.sha256!;
  ledger.registerAnchor('welcome', {
    expectedRevision: 0, operationId: 'anchor-1', artifactSha256: reference.asset.artifact.sha256,
  });
  const candidate: SegmentCandidate = {
    schemaVersion: 1, id: 'segment-1', boardId: 'welcome', artifactSha256: firstSha,
    promptSha256: 'c'.repeat(64), modelId: 'fixture',
    anchorIds: ['anchor-1'], startMs: 0, endMs: 5000, assessments: [], events: [],
  };
  ledger.registerCandidate('welcome', { expectedRevision: 1, operationId: 'submit-1', candidate });
  ledger.approveCandidate('welcome', 'segment-1', {
    expectedRevision: 2, operationId: 'checkpoint-1',
    confirmReviewed: true, reason: 'Local operator inspected the source video manually.',
  });
  const close = () => rmSync(directory, { recursive: true, force: true });
  return { directory, service, ledger, gate, reference: reference.asset.artifact, first: first.asset.artifact, close };
}
function request(overrides: Record<string, unknown> = {}) {
  return {
    expectedLedgerRevision: 3, parentCheckpointId: 'checkpoint-1',
    anchorIds: ['anchor-1'], mode: 'continue',
    startMs: 5000, endMs: 10000, ...overrides,
  };
}
async function freePort() {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

test('preflight verifies approved checkpoint and immutable original anchors without writing or executing', async () => {
  const f = await setup();
  try {
    const beforeLedger = readFileSync(f.ledger.file);
    const beforeWorkspace = readFileSync(f.service.store.file);
    const result = f.gate.preflight('welcome', request());
    assert.equal(result.status, 'preflight_only');
    assert.equal(result.parent.checkpointId, 'checkpoint-1');
    assert.equal(result.parent.artifactSha256, f.first.sha256);
    assert.equal(result.parent.reviewSource, 'explicit_local_operator');
    assert.deepEqual(result.anchors.map(a => a.id), ['anchor-1']);
    assert.equal(result.recheckRequiredAtDispatch, true);
    assert.equal(result.generationStarted, false);
    assert.equal(result.visualQualityVerified, false);
    assert.equal(result.approvalIsNamedHuman, false);
    assert.deepEqual(readFileSync(f.ledger.file), beforeLedger);
    assert.deepEqual(readFileSync(f.service.store.file), beforeWorkspace);
    assert.equal(f.service.media.openFileCount(), 0);
  } finally { f.close(); }
});

test('preflight rejects unknown, unapproved or cross-board checkpoint references', async () => {
  const f = await setup();
  try {
    assert.throws(() => f.gate.preflight('welcome', request({ parentCheckpointId: 'submit-1' })),
      throwsCode('CONTINUATION_PARENT_NOT_VERIFIED'));
    assert.throws(() => f.gate.preflight('welcome', request({ parentCheckpointId: 'unknown' })),
      throwsCode('CONTINUATION_PARENT_NOT_VERIFIED'));
    const other = f.service.create('Different board');
    assert.throws(() => f.gate.preflight(other.id, request()),
      throwsCode('CONTINUATION_PARENT_NOT_VERIFIED'));
    // Merely submitting a new candidate never grants a checkpoint.
    const next = await importMedia(f.service, 'video', mp4(5), 'unapproved');
    f.ledger.registerCandidate('welcome', {
      expectedRevision: 3, operationId: 'submit-2',
      candidate: {
        schemaVersion: 1, id: 'segment-2', boardId: 'welcome',
        artifactSha256: next.asset.artifact.sha256!, promptSha256: 'd'.repeat(64),
        modelId: 'fixture', anchorIds: ['anchor-1'], parentCheckpointId: 'checkpoint-1',
        startMs: 5000, endMs: 10000, assessments: [], events: [],
      },
    });
    assert.throws(() => f.gate.preflight('welcome', request({
      expectedLedgerRevision: 4, parentCheckpointId: 'submit-2',
      startMs: 10000, endMs: 15000,
    })), throwsCode('CONTINUATION_PARENT_NOT_VERIFIED'));
  } finally { f.close(); }
});

test('stale ledger, swapped anchors, off-by-one timing and malformed input fail closed', async () => {
  const f = await setup();
  try {
    assert.throws(() => f.gate.preflight('welcome', request({ expectedLedgerRevision: 2 })),
      throwsCode('CONTINUATION_STALE_LEDGER'));
    assert.throws(() => f.gate.preflight('welcome', request({ anchorIds: ['wrong-anchor'] })),
      throwsCode('CONTINUATION_ANCHOR_SET_CHANGED'));
    assert.throws(() => f.gate.preflight('welcome', request({ startMs: 4000 })),
      throwsCode('CONTINUATION_TIME_DISCONTINUITY'));
    for (const override of [
      { anchorIds: ['anchor-1', 'anchor-1'] },
      { endMs: 5000 },
      { endMs: 70_000 },
      { mode: 'auto' },
      { attackerPath: '/etc/passwd' },
      { parentCheckpointId: '../escape' },
    ]) {
      assert.throws(() => f.gate.preflight('welcome', request(override)),
        throwsCode('INVALID_CONTINUATION_INPUT'));
    }
  } finally { f.close(); }
});

test('ordinary continuation requires latest approved state; explicit rollback can branch older', async () => {
  const f = await setup();
  try {
    const clip = await importMedia(f.service, 'video', mp4(9), 'clip-two');
    f.ledger.registerCandidate('welcome', {
      expectedRevision: 3, operationId: 'submit-2',
      candidate: {
        schemaVersion: 1, id: 'segment-2', boardId: 'welcome',
        artifactSha256: clip.asset.artifact.sha256!, promptSha256: 'd'.repeat(64),
        modelId: 'fixture', anchorIds: ['anchor-1'], parentCheckpointId: 'checkpoint-1',
        startMs: 5000, endMs: 10000, assessments: [], events: [],
      },
    });
    f.ledger.approveCandidate('welcome', 'segment-2', {
      expectedRevision: 4, operationId: 'checkpoint-2',
      confirmReviewed: true, reason: 'Second clip inspected by local operator.',
    });
    assert.throws(() => f.gate.preflight('welcome', request({ expectedLedgerRevision: 5 })),
      throwsCode('CONTINUATION_REQUIRES_LATEST'));
    const branch = f.gate.preflight('welcome', request({
      expectedLedgerRevision: 5, mode: 'rollback_branch',
    }));
    assert.equal(branch.mode, 'rollback_branch');
    assert.equal(branch.parent.checkpointId, 'checkpoint-1');
    const latest = f.gate.preflight('welcome', request({
      expectedLedgerRevision: 5, parentCheckpointId: 'checkpoint-2',
      startMs: 10000, endMs: 15000,
    }));
    assert.equal(latest.parent.endMs, 10000);
  } finally { f.close(); }
});

test('tampered on-disk source media invalidates an otherwise approved checkpoint', async () => {
  const f = await setup();
  try {
    const located = f.service.media.fileFor(f.first);
    f.service.media.releaseFile(located.fd);
    writeFileSync(located.file, Buffer.alloc(f.first.bytes!, 0));
    assert.throws(() => f.gate.preflight('welcome', request()),
      throwsCode('VIDEO_MEDIA_UNVERIFIED'));
    assert.equal(f.ledger.view('welcome').checkpoints.length, 1);
    assert.equal(f.service.media.openFileCount(), 0);
  } finally { f.close(); }
});

test('HTTP preflight uses existing token and origin boundary and returns no generation authorization', async () => {
  const f = await setup();
  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const { app, token } = createApp(f.service, origin, '1'.repeat(64));
  const server = app.listen(port, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.on('listening', resolve));
    const url = origin + '/api/boards/welcome/video-integrity/continuations/preflight';
    const rejected = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request()),
    });
    assert.equal(rejected.status, 403);
    const headers = { Origin: origin, 'X-Canvas-Token': token, 'Content-Type': 'application/json' };
    const ok = await fetch(url, { method: 'POST', headers, body: JSON.stringify(request()) });
    assert.equal(ok.status, 200);
    const output = await ok.json() as { status: string; generationStarted: boolean; recheckRequiredAtDispatch: boolean };
    assert.equal(output.status, 'preflight_only');
    assert.equal(output.generationStarted, false);
    assert.equal(output.recheckRequiredAtDispatch, true);
    const invalid = await fetch(url, {
      method: 'POST', headers: { ...headers, Origin: 'http://attacker.invalid' },
      body: JSON.stringify(request()),
    });
    assert.equal(invalid.status, 403);
    assert.equal(f.ledger.view('welcome').revision, 3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    f.close();
  }
});
