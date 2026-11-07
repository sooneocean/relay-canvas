import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createApp } from '../server/app.js';
import { CanvasService } from '../server/service.js';
import { Store } from '../server/store.js';
import { VideoIntegrityLedger } from '../server/video-integrity-ledger.js';
import type { SegmentCandidate } from '../src/shared/video-integrity.js';

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(12),
]);
function mp4(fill: number): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp'), Buffer.from('isom'), Buffer.alloc(12, fill)]);
}
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const policy = { remoteEnabled: false, mediaOrigins: [], providerOrigins: [] };
const invalid = (code: string) => (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-video-ledger-'));
  const service = new CanvasService(new Store(directory), policy);
  const ledger = new VideoIntegrityLedger(service);
  const close = () => rmSync(directory, { recursive: true, force: true });
  return { directory, service, ledger, close };
}
async function importMedia(service: CanvasService, boardId: string, kind: 'image' | 'video', input: Buffer, name: string) {
  const mimeType = kind === 'image' ? 'image/png' : 'video/mp4';
  const expectedRevision = service.board(boardId).revision;
  return await service.importAsset(boardId, {
    expectedRevision, operationId: name, kind, name,
  }, mimeType, input.length, Readable.from([input]) as unknown as IncomingMessage);
}
function candidate(anchorId: string, videoSha: string, options: Partial<SegmentCandidate> = {}): SegmentCandidate {
  return {
    schemaVersion: 1, id: 'segment-1', boardId: 'welcome', artifactSha256: videoSha,
    promptSha256: 'c'.repeat(64), modelId: 'fixture-video-v1', anchorIds: [anchorId],
    startMs: 0, endMs: 5000, assessments: [], events: [], ...options,
  };
}
async function prepared() {
  const f = fixture();
  const image = await importMedia(f.service, 'welcome', 'image', png, 'image-v1');
  const video = await importMedia(f.service, 'welcome', 'video', mp4(7), 'video-v1');
  return { ...f, image: image.asset.artifact, video: video.asset.artifact };
}
function anchorRequest(sha: string, expectedRevision = 0, operationId = 'anchor-1') {
  return { operationId, expectedRevision, artifactSha256: sha };
}
function review(expectedRevision: number, operationId = 'approve-1') {
  return { operationId, expectedRevision, confirmReviewed: true, reason: 'Checked full local segment against original references.' };
}
async function freePort(): Promise<number> {
  const sock = net.createServer();
  await new Promise<void>(resolve => sock.listen(0, '127.0.0.1', resolve));
  const port = (sock.address() as AddressInfo).port;
  await new Promise<void>(resolve => sock.close(() => resolve()));
  return port;
}

test('immutable anchor is byte-verified, CAS-protected and replay-safe after restart', async () => {
  const f = await prepared();
  try {
    const originalWorkspace = readFileSync(f.service.store.file);
    assert.equal(f.ledger.view('welcome').revision, 0);
    assert.equal(existsSync(f.ledger.file), false);
    const first = f.ledger.registerAnchor('welcome', anchorRequest(f.image.sha256!));
    assert.equal(first.revision, 1);
    assert.equal(first.replayed, false);
    assert.equal(first.action.type, 'anchor');
    const replay = new VideoIntegrityLedger(f.service).registerAnchor('welcome', anchorRequest(f.image.sha256!));
    assert.equal(replay.replayed, true);
    assert.equal(replay.revision, 1);
    assert.equal(replay.currentRevision, 1);
    assert.deepEqual(readFileSync(f.service.store.file), originalWorkspace);
    assert.equal(f.ledger.view('welcome').anchors.length, 1);
    assert.equal(f.service.media.openFileCount(), 0);
    assert.throws(() => f.ledger.registerAnchor('welcome', anchorRequest(f.video.sha256!, 0, 'new-anchor')),
      invalid('VIDEO_REVISION_CONFLICT'));
    assert.throws(() => f.ledger.registerAnchor('welcome', anchorRequest(f.video.sha256!, 0)),
      invalid('VIDEO_OPERATION_CONFLICT'));
    assert.equal(new VideoIntegrityLedger(f.service).view('welcome').revision, 1);
  } finally { f.close(); }
});

test('register candidate is unscored and cannot refer to missing, foreign, or proposed parent', async () => {
  const f = await prepared();
  try {
    assert.throws(() => f.ledger.registerCandidate('welcome', {
      expectedRevision: 0, operationId: 'add-segment-1', candidate: candidate('anchor-1', f.video.sha256!),
    }), invalid('VIDEO_ANCHOR_NOT_FOUND'));
    f.ledger.registerAnchor('welcome', anchorRequest(f.image.sha256!));
    assert.throws(() => f.ledger.registerCandidate('welcome', {
      expectedRevision: 1, operationId: 'scored-segment', candidate: candidate('anchor-1', f.video.sha256!,
        { assessments: [{ metric: 'subject', score: 1, confidence: 1, scorerId: 'user' }] }),
    }), invalid('INVALID_VIDEO_INPUT'));
    assert.throws(() => f.ledger.registerCandidate('welcome', {
      expectedRevision: 1, operationId: 'unknown-parent', candidate: candidate('anchor-1', f.video.sha256!,
        { parentCheckpointId: 'ghost' }),
    }), invalid('VIDEO_PARENT_NOT_VERIFIED'));
    const first = f.ledger.registerCandidate('welcome', {
      expectedRevision: 1, operationId: 'add-segment-1', candidate: candidate('anchor-1', f.video.sha256!),
    });
    assert.equal(first.revision, 2);
    assert.equal(f.ledger.view('welcome').candidates[0].status, 'proposed');
    assert.equal(f.ledger.view('welcome').checkpoints.length, 0);
  } finally { f.close(); }
});

test('explicit local review creates immutable checkpoint, parent chain and valid replay', async () => {
  const f = await prepared();
  try {
    f.ledger.registerAnchor('welcome', anchorRequest(f.image.sha256!));
    f.ledger.registerCandidate('welcome', {
      expectedRevision: 1, operationId: 'submit-1', candidate: candidate('anchor-1', f.video.sha256!),
    });
    assert.throws(() => f.ledger.approveCandidate('welcome', 'segment-1', {
      expectedRevision: 2, operationId: 'approve-1', confirmReviewed: false, reason: 'Not reviewed',
    }), invalid('VIDEO_REVIEW_REQUIRED'));
    const approved = f.ledger.approveCandidate('welcome', 'segment-1', review(2));
    assert.equal(approved.revision, 3);
    assert.equal(approved.action.type, 'approve');
    assert.equal(f.ledger.view('welcome').checkpoints[0].id, 'approve-1');
    assert.equal(f.ledger.view('welcome').candidates[0].status, 'operator_approved');
    const replay = new VideoIntegrityLedger(f.service).approveCandidate('welcome', 'segment-1', review(2));
    assert.equal(replay.replayed, true);
    assert.equal(replay.revision, 3);
    assert.throws(() => f.ledger.approveCandidate('welcome', 'segment-1', review(3, 'approve-again')),
      invalid('VIDEO_CANDIDATE_NOT_PENDING'));
    const nextVideo = await importMedia(f.service, 'welcome', 'video', mp4(9), 'video-v2');
    assert.throws(() => f.ledger.registerCandidate('welcome', {
      expectedRevision: 3, operationId: 'bad-segment', candidate: candidate('anchor-1', nextVideo.asset.artifact.sha256!, {
        id: 'segment-too-early', parentCheckpointId: 'approve-1', startMs: 3000, endMs: 8000,
      }),
    }), invalid('INVALID_VIDEO_LINEAGE'));
    const second = f.ledger.registerCandidate('welcome', {
      expectedRevision: 3, operationId: 'submit-2', candidate: candidate('anchor-1', nextVideo.asset.artifact.sha256!, {
        id: 'segment-2', parentCheckpointId: 'approve-1', startMs: 5000, endMs: 10000,
      }),
    });
    assert.equal(second.revision, 4);
    assert.equal(f.ledger.view('welcome').checkpoints.length, 1);
    assert.equal(f.ledger.view('welcome').candidates.length, 2);
  } finally { f.close(); }
});

test('rejected segment stays rejected and cannot become a parent checkpoint', async () => {
  const f = await prepared();
  try {
    f.ledger.registerAnchor('welcome', anchorRequest(f.image.sha256!));
    f.ledger.registerCandidate('welcome', {
      expectedRevision: 1, operationId: 'submit-rejected', candidate: candidate('anchor-1', f.video.sha256!),
    });
    const rejected = f.ledger.rejectCandidate('welcome', 'segment-1', {
      expectedRevision: 2, operationId: 'reject-1', reason: 'Identity mismatch during a turn.',
    });
    assert.equal(rejected.revision, 3);
    assert.equal(f.ledger.view('welcome').candidates[0].status, 'rejected');
    assert.equal(f.ledger.view('welcome').checkpoints.length, 0);
    assert.throws(() => f.ledger.approveCandidate('welcome', 'segment-1', review(3)),
      invalid('VIDEO_CANDIDATE_NOT_PENDING'));
    const replay = f.ledger.rejectCandidate('welcome', 'segment-1', {
      expectedRevision: 2, operationId: 'reject-1', reason: 'Identity mismatch during a turn.',
    });
    assert.equal(replay.replayed, true);
  } finally { f.close(); }
});

test('foreign-board media cannot be registered even when files are globally content-addressed', async () => {
  const f = await prepared();
  try {
    const otherBoard = f.service.create('Other');
    assert.throws(() => f.ledger.registerAnchor(otherBoard.id, anchorRequest(f.image.sha256!)),
      invalid('VIDEO_MEDIA_NOT_OWNED'));
    const otherAsset = await importMedia(f.service, otherBoard.id, 'image', png, 'other-image');
    f.ledger.registerAnchor(otherBoard.id, anchorRequest(otherAsset.asset.artifact.sha256!, 0, 'anchor-other'));
    const bogus = candidate('anchor-other', f.video.sha256!, { boardId: otherBoard.id });
    assert.throws(() => f.ledger.registerCandidate(otherBoard.id, {
      expectedRevision: 1, operationId: 'other-candidate', candidate: bogus,
    }), invalid('VIDEO_MEDIA_NOT_OWNED'));
    assert.equal(f.ledger.view('welcome').anchors.length, 0);
    assert.equal(f.ledger.view(otherBoard.id).anchors.length, 1);
  } finally { f.close(); }
});

test('real media bytes are rehashed; tampering rejects an otherwise registered original', async () => {
  const f = await prepared();
  try {
    const located = f.service.media.fileFor(f.image);
    const file = located.file;
    f.service.media.releaseFile(located.fd);
    writeFileSync(file, Buffer.alloc(png.length, 0));
    assert.throws(() => f.ledger.registerAnchor('welcome', anchorRequest(f.image.sha256!)),
      invalid('VIDEO_MEDIA_UNVERIFIED'));
    assert.equal(f.ledger.view('welcome').revision, 0);
    writeFileSync(file, png);
    assert.equal(digest(png), f.image.sha256);
    f.ledger.registerAnchor('welcome', anchorRequest(f.image.sha256!));
    assert.equal(f.ledger.view('welcome').revision, 1);
  } finally { f.close(); }
});

test('sidecar corruption and unsafe file modes fail closed without overwriting data', async () => {
  const f = await prepared();
  try {
    f.ledger.registerAnchor('welcome', anchorRequest(f.image.sha256!));
    const validBytes = readFileSync(f.ledger.file);
    chmodSync(f.ledger.file, 0o644);
    assert.throws(() => f.ledger.view('welcome'), invalid('VIDEO_LEDGER_UNSAFE'));
    assert.deepEqual(readFileSync(f.ledger.file), validBytes);
    chmodSync(f.ledger.file, 0o600);
    const tampered = JSON.parse(validBytes.toString('utf8')) as { commits: Array<{ entrySha256: string }> };
    tampered.commits[0].entrySha256 = 'f'.repeat(64);
    writeFileSync(f.ledger.file, JSON.stringify(tampered));
    assert.throws(() => f.ledger.registerAnchor('welcome', anchorRequest(f.image.sha256!, 1, 'anchor-2')),
      invalid('VIDEO_LEDGER_CORRUPT'));
    assert.equal(JSON.parse(readFileSync(f.ledger.file, 'utf8')).commits[0].entrySha256, 'f'.repeat(64));
  } finally { f.close(); }
});

test('HTTP routes enforce existing local session token and origin, support CAS and idempotency', async () => {
  const f = await prepared();
  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const { app, token } = createApp(f.service, origin, '6'.repeat(64));
  const server = app.listen(port, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.on('listening', resolve));
    const api = origin + '/api/boards/welcome/video-integrity';
    const denied = await fetch(api);
    assert.equal(denied.status, 403);
    const headers = { Origin: origin, 'X-Canvas-Token': token, 'Content-Type': 'application/json' };
    const get = await fetch(api, { headers });
    assert.equal(get.status, 200);
    assert.equal((await get.json() as { revision: number }).revision, 0);
    const wrongOrigin = await fetch(api + '/anchors', {
      method: 'POST', headers: { ...headers, Origin: 'http://attacker.invalid' },
      body: JSON.stringify(anchorRequest(f.image.sha256!)),
    });
    assert.equal(wrongOrigin.status, 403);
    const written = await fetch(api + '/anchors', {
      method: 'POST', headers, body: JSON.stringify(anchorRequest(f.image.sha256!)),
    });
    assert.equal(written.status, 201);
    const replay = await fetch(api + '/anchors', {
      method: 'POST', headers, body: JSON.stringify(anchorRequest(f.image.sha256!)),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { replayed: boolean }).replayed, true);
    const final = await fetch(api, { headers });
    assert.equal((await final.json() as { revision: number }).revision, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    f.close();
  }
});
