import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { CanvasService } from '../server/service.js';
import { Store } from '../server/store.js';

const policy = { remoteEnabled: false, providerOrigins: [], mediaOrigins: [] };
function movFixture(dir: string): Buffer {
  const file = path.join(dir, 'seedance-color-master.mov');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264',
    '-pix_fmt', 'yuv444p', '-preset', 'ultrafast', '-crf', '20',
    '-c:a', 'pcm_s16le', '-f', 'mov', '-y', file,
  ], { timeout: 20_000, maxBuffer: 100_000 });
  return readFileSync(file);
}
function mp4Fixture(dir: string): Buffer {
  const file = path.join(dir, 'legacy.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-crf', '25',
    '-f', 'mp4', '-y', file,
  ], { timeout: 20_000, maxBuffer: 100_000 });
  return readFileSync(file);
}
function parseProbe(file: string): { streams: Array<{ codec_name?: string; codec_type?: string; pix_fmt?: string }> } {
  return JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_name,codec_type,pix_fmt',
    '-of', 'json', file,
  ], { encoding: 'utf8', timeout: 15_000 })) as { streams: Array<{ codec_name?: string; codec_type?: string; pix_fmt?: string }> };
}

test('MOV yuv444p/PCM master is imported and reloaded byte-identically, never silently transcoded', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-mov-master-'));
  try {
    const service = new CanvasService(new Store(dir), policy);
    const original = movFixture(dir);
    assert.equal(original.toString('ascii', 4, 8), 'ftyp');
    assert.equal(original.toString('ascii', 8, 12), 'qt  ');
    const imported = await service.importAsset('welcome', {
      expectedRevision: 0, operationId: 'mov-master', kind: 'video', name: 'Original Seedance master',
    }, 'video/quicktime', original.length, Readable.from([original]) as unknown as IncomingMessage);
    const artifact = imported.asset.artifact;
    assert.equal(artifact.mimeType, 'video/quicktime');
    assert.ok(artifact.sha256);
    assert.equal(artifact.url, '/api/media/' + artifact.sha256);
    const located = service.media.fileFor(artifact);
    let stored: Buffer;
    let streams: ReturnType<typeof parseProbe>;
    try {
      stored = readFileSync(located.file);
      streams = parseProbe(located.file);
    } finally { service.media.releaseFile(located.fd); }
    assert.deepEqual(stored, original);
    const v = streams.streams.find(x => x.codec_type === 'video');
    assert.equal(v?.codec_name, 'h264');
    assert.equal(v?.pix_fmt, 'yuv444p');
    assert.equal(streams.streams.find(x => x.codec_type === 'audio')?.codec_name, 'pcm_s16le');
    const media = await service.editor.probe(artifact);
    assert.equal(media.width, 320);
    assert.equal(media.height, 240);
    assert.equal(media.hasAudio, true);
    const reloaded = new CanvasService(new Store(dir), policy);
    const persisted = reloaded.store.read().localAssets?.find(a => a.id === 'mov-master');
    assert.equal(persisted?.artifact.mimeType, 'video/quicktime');
    assert.equal(reloaded.media.verifyArtifact(persisted!.artifact).sha256, artifact.sha256);
    assert.equal(service.media.openFileCount(), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('content sniffing prevents MOV/MP4 container spoofing and leaves registry untouched', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-mov-spoof-'));
  try {
    const service = new CanvasService(new Store(dir), policy);
    const mov = movFixture(dir), mp4 = mp4Fixture(dir);
    await assert.rejects(service.importAsset('welcome', {
      expectedRevision: 0, operationId: 'spoof-mov', kind: 'video', name: 'spoof',
    }, 'video/mp4', mov.length, Readable.from([mov]) as unknown as IncomingMessage));
    await assert.rejects(service.importAsset('welcome', {
      expectedRevision: 0, operationId: 'spoof-mp4', kind: 'video', name: 'spoof',
    }, 'video/quicktime', mp4.length, Readable.from([mp4]) as unknown as IncomingMessage));
    assert.equal(service.store.read().localAssets?.length ?? 0, 0);
    assert.equal(service.media.openFileCount(), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('modified MOV after import fails byte-verified media read, source remains registered', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-mov-tamper-'));
  try {
    const service = new CanvasService(new Store(dir), policy);
    const bytes = movFixture(dir);
    const imported = await service.importAsset('welcome', {
      expectedRevision: 0, operationId: 'mov-master', kind: 'video', name: 'Original',
    }, 'video/quicktime', bytes.length, Readable.from([bytes]) as unknown as IncomingMessage);
    const artifact = imported.asset.artifact;
    const located = service.media.fileFor(artifact);
    try { writeFileSync(located.file, Buffer.alloc(bytes.length)); }
    finally { service.media.releaseFile(located.fd); }
    assert.throws(() => service.media.verifyArtifact(artifact));
    assert.equal(service.store.read().localAssets?.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
