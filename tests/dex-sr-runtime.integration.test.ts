/**
 * Real integration test for optional DE-X SR worker. Run ONLY in CI workflow
 * with Python3+cv2/numpy+FFmpeg installed. No generative model or paid API.
 */
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
import type { DexSrBundle } from '../src/shared/types.js';

const policy = { remoteEnabled: false, providerOrigins: [], mediaOrigins: [] };
function fixtureClip(directory: string, name: string, brightness: number) {
  const file = path.join(directory, name + '.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=4:duration=1',
    '-vf', 'eq=brightness=' + brightness,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
    '-pix_fmt', 'yuv420p', '-y', file,
  ], { timeout: 20_000, maxBuffer: 120_000 });
  return readFileSync(file);
}
function fixtureReference(directory: string) {
  const file = path.join(directory, 'person-original.png');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'color=c=0x927c69:s=256x256:r=1:d=1',
    '-frames:v', '1', '-y', file,
  ], { timeout: 20_000, maxBuffer: 120_000 });
  return readFileSync(file);
}
async function imported(service: CanvasService, kind: 'video' | 'image', bytes: Buffer, operationId: string) {
  return service.importAsset('welcome', {
    expectedRevision: service.board('welcome').revision,
    operationId, kind, name: operationId,
  }, kind === 'video' ? 'video/mp4' : 'image/png', bytes.length,
  Readable.from([bytes]) as unknown as IncomingMessage);
}
function countFrames(file: string) {
  const data = execFileSync('ffprobe', [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ], { encoding: 'utf8', timeout: 15_000 });
  return Number(data.trim());
}

test('authenticated local job path uses real Python temporal SR and publishes independent 1080p MP4', { timeout: 200_000, skip: process.env.DEX_SR_RUNTIME_E2E !== '1' }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-dex-sr-full-'));
  try {
    const service = new CanvasService(new Store(directory), policy);
    assert.equal(await service.editor.dexSrAvailable(), true, 'Python cv2 worker must be present');
    const current = await imported(service, 'video', fixtureClip(directory, 'current', 0.02), 'clip-current');
    const previous = await imported(service, 'video', fixtureClip(directory, 'previous', 0.00), 'clip-previous');
    const reference = await imported(service, 'image', fixtureReference(directory), 'reference-person');
    const currentArtifact = current.asset.artifact;
    const before = service.media.verifyArtifact(currentArtifact);
    const bundle: DexSrBundle = {
      schemaVersion: 1, currentVideo: { artifactSha256: currentArtifact.sha256! },
      previousSegment: { artifactSha256: previous.asset.artifact.sha256! },
      originals: [{ artifactSha256: reference.asset.artifact.sha256!, role: 'identity' }],
      prompt: '保真，保持五官，不要生成新細節。',
      temporalRadius: 1, targetHeight: 1080,
    };
    const job = await service.startDexSr('welcome', { operationId: 'dex-sr-real-worker', bundle });
    assert.equal(job.status, 'pending');
    const finished = await service.settledExport(job.id);
    assert.equal(finished.status, 'succeeded', finished.error);
    const result = finished.artifact!;
    assert.notEqual(result.sha256, currentArtifact.sha256);
    assert.equal(result.mimeType, 'video/mp4');
    assert.equal(service.mediaArtifact(result.sha256!).sha256, result.sha256);
    const resultInfo = await service.editor.probe(result);
    assert.equal(resultInfo.width, 1920);
    assert.equal(resultInfo.height, 1080);
    const src = service.media.fileFor(currentArtifact);
    const output = service.media.fileFor(result);
    try { assert.equal(countFrames(src.file), countFrames(output.file)); }
    finally { service.media.releaseFile(src.fd); service.media.releaseFile(output.fd); }
    assert.equal(service.media.verifyArtifact(currentArtifact).sha256, before.sha256);
    assert.equal(service.media.openFileCount(), 0);
    assert.equal((await service.startDexSr('welcome', { operationId: 'dex-sr-real-worker', bundle })).id, job.id);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
