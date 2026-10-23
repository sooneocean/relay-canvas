import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { atomicWrite, Store } from '../server/store.js';
import { CanvasService } from '../server/service.js';
import { EditorRuntime, resolveExecutable } from '../server/editor.js';
import { MAX_MEDIA_QUOTA, MediaStore } from '../server/media.js';
import { readPolicy } from '../server/security.js';
import { createApp } from '../server/app.js';
import type { Artifact, Run } from '../src/shared/types.js';
import { parseStoreData, parseTimelineInput } from '../src/shared/schema.js';

function command(executable: string, args: string[], cwd: string, encoding: BufferEncoding | 'buffer' = 'utf8'): string | Buffer {
  const result = spawnSync(executable, args, { cwd, encoding: encoding === 'buffer' ? null : encoding, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}

function makeFixtures(directory: string): { audible: string; silent: string } {
  const audible = path.join(directory, 'audible.mp4'), silent = path.join(directory, 'silent.mp4');
  command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=red:s=640x360:d=2:r=24', '-f', 'lavfi', '-i', 'color=green:s=640x360:d=2:r=24', '-f', 'lavfi', '-i', 'sine=frequency=700:sample_rate=48000:duration=4', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', audible], directory);
  command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=blue:s=360x640:d=2:r=24', '-f', 'lavfi', '-i', 'color=yellow:s=360x640:d=2:r=24', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-y', silent], directory);
  return { audible, silent };
}

async function saveVideo(service: CanvasService, file: string): Promise<Artifact> {
  const bytes = readFileSync(file);
  let saved: Artifact | undefined;
  await service.media.save({ kind: 'video', url: `data:video/mp4;base64,${bytes.toString('base64')}` }, artifact => { saved = artifact; });
  return saved!;
}

function frame(file: string, seconds: number, width: number, height: number, cwd: string): Buffer {
  return command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], cwd, 'buffer') as Buffer;
}

function pixel(data: Buffer, width: number, x: number, y: number): [number, number, number] {
  const offset = (y * width + x) * 3; return [data[offset], data[offset + 1], data[offset + 2]];
}

function dominant(actual: [number, number, number], expected: 'red' | 'green' | 'blue' | 'yellow' | 'black'): void {
  const [r, g, b] = actual;
  if (expected === 'black') assert.ok(r < 25 && g < 25 && b < 25, `${actual}`);
  if (expected === 'red') assert.ok(r > 150 && g < 80 && b < 80, `${actual}`);
  if (expected === 'green') assert.ok(g > 70 && r < 80 && b < 80, `${actual}`);
  if (expected === 'blue') assert.ok(b > 150 && r < 80 && g < 80, `${actual}`);
  if (expected === 'yellow') assert.ok(r > 150 && g > 150 && b < 80, `${actual}`);
}

function rms(samples: Buffer, startSeconds: number, endSeconds: number, rate = 8000): number {
  let squares = 0, count = 0;
  for (let index = Math.floor(startSeconds * rate); index < Math.floor(endSeconds * rate); index++) {
    const value = samples.readInt16LE(index * 2); squares += value * value; count++;
  }
  return Math.sqrt(squares / count);
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('timed out waiting for test state');
}

async function freePort(): Promise<number> {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

function minimalMp4(extra = ''): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]), Buffer.from(extra)]);
}

test('v0.4 strict additive schemas reject duplicate clips, oversized trims, and corrupt export state', () => {
  assert.throws(() => parseTimelineInput({ expectedRevision: 0, format: 'landscape', clips: [{ id: 'a', source: { runId: 'r', nodeId: 'n', artifactIndex: 0 }, inSeconds: 0, outSeconds: 1 }, { id: 'a', source: { runId: 'r', nodeId: 'n', artifactIndex: 0 }, inSeconds: 0, outSeconds: 1 }] }));
  assert.throws(() => parseTimelineInput({ expectedRevision: 0, format: 'portrait', clips: [{ id: 'a', source: { runId: 'r', nodeId: 'n', artifactIndex: 0 }, inSeconds: 0, outSeconds: 61 }] }));
  assert.throws(() => parseTimelineInput({ expectedRevision: 0, format: 'landscape', clips: [], extra: true }));
  assert.throws(() => parseStoreData({ schemaVersion: 1, boards: [], providers: [], runs: [], exports: [{ id: 'e' }] }));
});

test('terminal comparison is canonical, cache-independent, immutable, and active runs fail closed', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v04-compare-'));
  try {
    const store = new Store(directory), service = new CanvasService(store), board = service.board('welcome');
    const base = (id: string, status: Run['status'], prompt: string): Run => ({ id, boardId: board.id, revision: board.revision, operationId: `op-${id}`, status, startedAt: '2026-10-23T00:00:00.000Z', finishedAt: status === 'running' ? undefined : '2026-10-23T00:00:01.000Z', snapshot: { ...board, nodes: board.nodes.map(node => node.id === 'brief' ? { ...node, data: { ...node.data, prompt } } : node) }, providers: store.read().providers, order: board.nodes.map(node => node.id), results: Object.fromEntries(board.nodes.map(node => [node.id, { nodeId: node.id, status: status === 'running' ? 'running' : 'succeeded', artifacts: node.id === 'frame' ? [{ kind: 'video', url: `https://example.test/${id}.mp4` }] : [] }])) });
    store.transaction(data => { data.runs.push(base('left', 'succeeded', 'left prompt'), base('right', 'failed', 'right prompt'), base('active', 'running', 'moving')); });
    const before = readFileSync(store.file);
    const first = JSON.stringify(service.compare(board.id, 'left', 'right'));
    assert.deepEqual(readFileSync(store.file), before);
    store.transaction(data => { const artifact = data.runs.find(run => run.id === 'left')!.results.frame.artifacts[0]; artifact.localId = 'a'.repeat(64); artifact.sha256 = artifact.localId; artifact.localUrl = `/api/media/${artifact.localId}`; artifact.bytes = 123; artifact.mimeType = 'video/mp4'; });
    const second = JSON.stringify(service.compare(board.id, 'left', 'right'));
    assert.equal(first, second);
    assert.ok(!first.includes('localId') && !first.includes('mimeType'));
    assert.throws(() => service.compare(board.id, 'active', 'right'), (error: unknown) => (error as { code?: string }).code === 'RUN_NOT_TERMINAL');
    assert.notDeepEqual(readFileSync(store.file), before); // only the explicit local-cache mutation changed bytes
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('editor rejects workspace PATH executables and same-length source tampering before probe', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v04-tamper-'));
  try {
    const fake = path.join(directory, 'ffmpeg'); writeFileSync(fake, '#!/bin/sh\nexit 0\n'); chmodSync(fake, 0o755);
    assert.equal(resolveExecutable('ffmpeg', directory, `${directory}${path.delimiter}relative`), undefined);
    const fixture = makeFixtures(directory), store = new Store(directory), service = new CanvasService(store);
    const artifact = await saveVideo(service, fixture.audible), board = service.board('welcome');
    store.transaction(data => { data.runs.push({ id: 'tamper-run', boardId: board.id, revision: board.revision, operationId: 'tamper-op', status: 'succeeded', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), snapshot: board, providers: data.providers, order: ['video'], results: { video: { nodeId: 'video', status: 'succeeded', artifacts: [artifact] } } }); });
    const located = service.media.fileFor(artifact), bytes = readFileSync(located.fd); service.media.releaseFile(located.fd);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff; writeFileSync(located.file, bytes, { mode: 0o600 });
    await assert.rejects(service.artifactInfo('tamper-run', 'video', 0), (error: unknown) => (error as { code?: string }).code === 'PROBE_FAILED');
    assert.deepEqual(readdirSync(path.join(directory, 'editor-jobs')), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('editor fails closed when a resolved executable inode is replaced', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v04-inode-')), tools = mkdtempSync(path.join(os.tmpdir(), 'relay-v04-inode-tools-'));
  try {
    const executable = path.join(tools, 'ffmpeg');
    writeFileSync(executable, '#!/bin/sh\necho "ffmpeg version 9.0.1"\n', { mode: 0o755 });
    const probe = path.join(tools, 'ffprobe'); writeFileSync(probe, '#!/bin/sh\necho "ffprobe version 9.0.1"\n', { mode: 0o755 });
    const canonical = realpathSync(directory);
    const editor = new EditorRuntime(canonical, new MediaStore(canonical, readPolicy({})), canonical, tools);
    unlinkSync(executable);
    writeFileSync(executable, '#!/bin/sh\necho "ffmpeg version 99.0.0"\n', { mode: 0o755 });
    const capabilities = await editor.capabilities();
    assert.equal(capabilities.ffmpeg, false);
    assert.equal(capabilities.available, false);
  } finally { rmSync(directory, { recursive: true, force: true }); rmSync(tools, { recursive: true, force: true }); }
});

test('editor fake process proves fixed local-only argv, thread placement, manifest and sanitized environment', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v04-argv-')), tools = mkdtempSync(path.join(os.tmpdir(), 'relay-v04-argv-tools-'));
  const trace = path.join(tools, 'trace.jsonl'), sentinel = path.join(directory, 'must-not-read');
  const previousSecret = process.env.RELAY_TEST_SECRET;
  try {
    writeFileSync(sentinel, 'outside sentinel');
    const output = minimalMp4().toString('base64');
    const executable = path.join(tools, 'ffmpeg');
    writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
const entry = { argv, env: process.env };
const input = argv[argv.indexOf('-i') + 1];
if (input && input.startsWith('source-')) entry.source = fs.readFileSync(input, 'utf8');
if (input === 'segments.txt') entry.manifest = fs.readFileSync(input, 'utf8');
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(entry) + '\\n');
if (argv.includes('-version')) { console.log('ffmpeg version 9.0.1'); process.exit(0); }
if (argv.includes('-encoders')) { console.log(' V..... libx264 H264\\n A..... aac AAC'); process.exit(0); }
if (argv.includes('demuxer=mov')) { console.log('enable_drefs use_absolute_path'); process.exit(0); }
process.stderr.write('private diagnostic ${sentinel}');
fs.writeFileSync(argv.at(-1), Buffer.from(${JSON.stringify(output)}, 'base64'));
`, { mode: 0o755 });
    const probe = path.join(tools, 'ffprobe');
    writeFileSync(probe, `#!${process.execPath}\nconsole.log('ffprobe version 9.0.1');\n`, { mode: 0o755 });
    process.env.RELAY_TEST_SECRET = 'must-not-reach-editor';
    const canonical = realpathSync(directory), media = new MediaStore(canonical, readPolicy({}));
    const hostile = `http://evil.invalid/a file '${sentinel}' dref protocol concat`;
    let source: Artifact | undefined, webm: Artifact | undefined;
    const bytes = minimalMp4(hostile);
    await media.save({ kind: 'video', url: `data:video/mp4;base64,${bytes.toString('base64')}` }, artifact => { source = artifact; });
    const webmBytes = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(hostile)]);
    await media.save({ kind: 'video', url: `data:video/webm;base64,${webmBytes.toString('base64')}` }, artifact => { webm = artifact; });
    const editor = new EditorRuntime(canonical, media, canonical, tools);
    const timeline = { boardId: 'welcome', revision: 1, format: 'landscape' as const, clips: [{
      id: 'clip', source: { runId: 'run', nodeId: 'node', artifactIndex: 0 }, inSeconds: 0, outSeconds: 1,
      artifact: source!, media: { duration: 1, width: 640, height: 360, hasAudio: false },
    }, {
      id: 'clip-webm', source: { runId: 'run', nodeId: 'node', artifactIndex: 1 }, inSeconds: 0, outSeconds: 1,
      artifact: webm!, media: { duration: 1, width: 360, height: 640, hasAudio: false },
    }] };
    let result: Artifact | undefined;
    await editor.export(timeline, artifact => { result = artifact; }, () => false);
    assert.equal(result?.mimeType, 'video/mp4');
    const entries = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { argv: string[]; env: Record<string, string>; source?: string; manifest?: string });
    const normalize = entries.find(entry => entry.argv.at(-1) === 'segment-000.mp4')!;
    const normalizeWebm = entries.find(entry => entry.argv.at(-1) === 'segment-001.mp4')!;
    const concat = entries.find(entry => entry.argv.at(-1) === 'output.mp4')!;
    assert.ok(normalize.source?.includes(hostile));
    assert.equal(normalize.source?.includes('outside sentinel'), false);
    assert.deepEqual({ PATH: normalize.env.PATH, LANG: normalize.env.LANG, LC_ALL: normalize.env.LC_ALL, HOME: normalize.env.HOME }, { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/nonexistent' });
    assert.equal(normalize.env.RELAY_TEST_SECRET, undefined);
    assert.deepEqual(normalize.argv.slice(normalize.argv.indexOf('-f'), normalize.argv.indexOf('-i') + 2), ['-f', 'mov', '-protocol_whitelist', 'file', '-enable_drefs', '0', '-use_absolute_path', '0', '-threads', '2', '-i', 'source-000.mp4']);
    assert.ok(normalize.argv.indexOf('-filter_threads') < normalize.argv.indexOf('-i'));
    assert.deepEqual(normalize.argv.slice(normalize.argv.indexOf('-filter_threads'), normalize.argv.indexOf('-filter_threads') + 2), ['-filter_threads', '2']);
    const secondInput = normalize.argv.lastIndexOf('-i');
    assert.deepEqual(normalize.argv.slice(secondInput - 2, secondInput + 2), ['-threads', '2', '-i', 'anullsrc=r=48000:cl=stereo']);
    assert.deepEqual(normalize.argv.slice(normalize.argv.indexOf('-map'), normalize.argv.indexOf('-vf')), ['-map', '0:v:0', '-map', '1:a:0']);
    assert.ok(normalize.argv.some((value, index) => value === '-threads' && normalize.argv[index + 1] === '2' && index > normalize.argv.indexOf('-c:a')));
    assert.deepEqual(normalizeWebm.argv.slice(normalizeWebm.argv.indexOf('-f'), normalizeWebm.argv.indexOf('-i') + 2), ['-f', 'matroska', '-protocol_whitelist', 'file', '-threads', '2', '-i', 'source-001.webm']);
    assert.deepEqual(concat.argv.slice(concat.argv.indexOf('-f'), concat.argv.indexOf('-i') + 2), ['-f', 'concat', '-safe', '1', '-protocol_whitelist', 'file', '-threads', '2', '-i', 'segments.txt']);
    assert.deepEqual(concat.argv.slice(concat.argv.indexOf('-map'), concat.argv.indexOf('-c')), ['-map', '0:v:0', '-map', '0:a:0']);
    assert.equal(concat.manifest, "file 'segment-000.mp4'\nfile 'segment-001.mp4'\n");
    assert.equal(JSON.stringify(normalize.argv).includes(sentinel), false);
    assert.equal(concat.manifest.includes(sentinel) || concat.manifest.includes('http:') || concat.manifest.includes('protocol'), false);
    // This proves the application argv/read boundary; it does not claim absence of native codec vulnerabilities.
  } finally {
    if (previousSecret === undefined) delete process.env.RELAY_TEST_SECRET; else process.env.RELAY_TEST_SECRET = previousSecret;
    rmSync(directory, { recursive: true, force: true }); rmSync(tools, { recursive: true, force: true });
  }
});

test('persistent reservation blocks concurrent saves, enforces output plus one, and releases quota on failure', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v04-reserve-'));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(8)]);
  try {
    const media = new MediaStore(directory, readPolicy({}), async () => ({ bytes: png, contentType: 'image/png' }));
    const filler = path.join(media.directory, 'quota-fixture.bin'); writeFileSync(filler, ''); truncateSync(filler, MAX_MEDIA_QUOTA - 1000);
    const reservation = await media.reserveDerived(); assert.equal(reservation.bytes, 1000);
    await assert.rejects(media.save({ kind: 'image', url: 'https://example.test/a.png' }, () => undefined), /quota/);
    const oversized = path.join(directory, 'output-plus-one.mp4'); writeFileSync(oversized, Buffer.alloc(1001));
    const fd = openSync(oversized, 'r');
    try { await assert.rejects(media.commitDerived(reservation, fd, 1001, () => undefined), /size mismatch/); }
    finally { closeSync(fd); }
    assert.equal((media as unknown as { reservations: Map<string, number> }).reservations.size, 0);
    await media.save({ kind: 'image', url: 'https://example.test/b.png' }, () => undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('real MediaStore removes an unfenced derived late commit but retains a referenced artifact', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v04-derived-fence-'));
  try {
    const store = new Store(directory), media = new MediaStore(directory, readPolicy({}));
    const bytes = minimalMp4('derived-fence'), hash = createHash('sha256').update(bytes).digest('hex');
    const source = path.join(directory, 'derived.mp4'); writeFileSync(source, bytes);
    const destination = path.join(media.directory, `${hash}.mp4`);
    const first = await media.reserveDerived(bytes.length), firstFd = openSync(source, 'r');
    try {
      await assert.rejects(media.commitDerived(first, firstFd, bytes.length, () => { throw new Error('late commit fenced'); }, () => false), /late commit fenced/);
    } finally { closeSync(firstFd); }
    assert.equal(existsSync(destination), false);
    const board = store.read().boards[0];
    const artifact: Artifact = { kind: 'video', url: `/api/media/${hash}`, localId: hash, localUrl: `/api/media/${hash}`, bytes: bytes.length, sha256: hash, mimeType: 'video/mp4' };
    store.transaction(data => { data.runs.push({ id: 'retained-run', boardId: board.id, revision: board.revision, operationId: 'retained-operation', status: 'succeeded', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), snapshot: board, providers: data.providers, order: ['video'], results: { video: { nodeId: 'video', status: 'succeeded', artifacts: [artifact] } } }); });
    const second = await media.reserveDerived(bytes.length), secondFd = openSync(source, 'r');
    try {
      await assert.rejects(media.commitDerived(second, secondFd, bytes.length, () => { throw new Error('late commit fenced'); }, localId => store.artifactReferenced(localId)), /late commit fenced/);
    } finally { closeSync(secondFd); }
    assert.equal(existsSync(destination), true);
    assert.deepEqual(readFileSync(destination), bytes);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('export HTTP hides attempt fences and diagnostics while token, cookie and Range protect the artifact', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v04-export-http-')), port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const store = new Store(directory), media = new MediaStore(directory, readPolicy({}));
  const bytes = minimalMp4('http-export'); let artifact: Artifact | undefined;
  await media.save({ kind: 'video', url: `data:video/mp4;base64,${bytes.toString('base64')}` }, saved => { artifact = saved; });
  const board = store.read().boards[0];
  store.transaction(data => {
    data.timelines = [{ boardId: board.id, revision: 1, format: 'landscape', clips: [{ id: 'clip', source: { runId: 'run', nodeId: 'node', artifactIndex: 0 }, inSeconds: 0, outSeconds: 1, artifact: artifact!, media: { duration: 1, width: 640, height: 360, hasAudio: false } }] }];
    data.exports = [{ id: 'export-http', boardId: board.id, timelineRevision: 1, operationId: 'export-http-operation', status: 'succeeded', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), snapshot: data.timelines[0], artifact: artifact!, attemptNonce: 'private-attempt' }];
  });
  const sensitive = `${directory}/private-source.mp4 SECRET_DIAGNOSTIC`;
  const failingEditor = { capabilities: async () => ({ available: true }), export: async () => { throw new Error(sensitive); } } as unknown as EditorRuntime;
  const service = new CanvasService(store, readPolicy({}), undefined, media, failingEditor);
  const { app, token } = createApp(service, origin, 'd'.repeat(64));
  const server = app.listen(port, '127.0.0.1'); await new Promise<void>(resolve => server.on('listening', resolve));
  const headers = { Origin: origin, 'X-Canvas-Token': token, 'Content-Type': 'application/json' };
  try {
    const publicJobResponse = await fetch(`${origin}/api/exports/export-http`, { headers });
    assert.equal(publicJobResponse.status, 200);
    const publicJobText = await publicJobResponse.text();
    assert.equal(publicJobText.includes('attemptNonce') || publicJobText.includes('private-attempt'), false);
    const stateText = await (await fetch(`${origin}/api/state`, { headers })).text();
    assert.equal(stateText.includes('attemptNonce') || stateText.includes('private-attempt'), false);
    assert.equal((await fetch(`${origin}${artifact!.localUrl}`)).status, 403);
    const tokenRange = await fetch(`${origin}${artifact!.localUrl}`, { headers: { Origin: origin, 'X-Canvas-Token': token, Range: 'bytes=0-3' } });
    assert.equal(tokenRange.status, 206); assert.deepEqual(Buffer.from(await tokenRange.arrayBuffer()), bytes.subarray(0, 4));
    const session = await fetch(`${origin}/api/session`, { headers: { Origin: origin, 'X-Canvas-Client': 'ui' } });
    const cookie = session.headers.get('set-cookie')!.split(';', 1)[0];
    const cookieRange = await fetch(`${origin}${artifact!.localUrl}`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', Range: 'bytes=4-7' } });
    assert.equal(cookieRange.status, 206); assert.deepEqual(Buffer.from(await cookieRange.arrayBuffer()), bytes.subarray(4, 8));
    const failed = service.startExport(board.id, { expectedRevision: 1, operationId: 'diagnostic-failure' });
    await service.settledExport(failed.id);
    const failedText = await (await fetch(`${origin}/api/exports/${failed.id}`, { headers })).text();
    assert.equal(failedText.includes(sensitive) || failedText.includes(directory) || failedText.includes('SECRET_DIAGNOSTIC') || failedText.includes('attemptNonce'), false);
    assert.match(failedText, /匯出失敗/);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('unknown crash remnants are retained, counted, and block ephemeral overbooking', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v04-remnant-'));
  try {
    const media = new MediaStore(directory, readPolicy({})), editorRoot = path.join(directory, 'editor-jobs'), crash = path.join(editorRoot, 'crash-remnant');
    mkdirSync(crash, { recursive: true, mode: 0o700 });
    const unknown = path.join(crash, 'unknown.partial'); writeFileSync(unknown, ''); truncateSync(unknown, 192 * 1024 * 1024);
    const editor = new EditorRuntime(realpathSync(directory), media);
    await assert.rejects(editor.probe({ kind: 'video', url: '/api/media/' + 'c'.repeat(64), localId: 'c'.repeat(64), localUrl: '/api/media/' + 'c'.repeat(64), bytes: 1, sha256: 'c'.repeat(64), mimeType: 'video/mp4' }), /temporary storage limit/);
    assert.equal(existsSync(unknown), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('export operation is durable before work, globally idempotent, busy-rejecting, and cancellation fences 100 late commits', { timeout: 60_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v04-race-'));
  try {
    const store = new Store(directory), mediaService = new CanvasService(store), board = mediaService.board('welcome');
    const artifact: Artifact = { kind: 'video', url: '/api/media/' + 'a'.repeat(64), localId: 'a'.repeat(64), localUrl: '/api/media/' + 'a'.repeat(64), bytes: 100, sha256: 'a'.repeat(64), mimeType: 'video/mp4' };
    store.transaction(data => { data.timelines = [{ boardId: board.id, revision: 1, format: 'landscape', clips: [{ id: 'clip', source: { runId: 'run', nodeId: 'node', artifactIndex: 0 }, inSeconds: 0, outSeconds: 1, artifact, media: { duration: 1, width: 640, height: 360, hasAudio: false } }] }]; });
    let calls = 0, entered: (() => void) | undefined;
    const fakeEditor = {
      capabilities: async () => ({ available: true }),
      probe: async () => ({ duration: 1, width: 640, height: 360, hasAudio: false }),
      export: async (_timeline: unknown, commit: (artifact: Artifact) => void, _referenced: unknown, signal?: AbortSignal) => {
        calls++; entered?.();
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }));
        commit(artifact); // must lose to the durable terminal cancellation fence
        return artifact;
      },
    } as unknown as EditorRuntime;
    const service = new CanvasService(store, undefined, undefined, mediaService.media, fakeEditor);
    for (let index = 0; index < 100; index++) {
      const startedWork = new Promise<void>(resolve => { entered = resolve; });
      const first = service.startExport(board.id, { expectedRevision: 1, operationId: `race-${index}` });
      assert.equal(service.startExport(board.id, { expectedRevision: 1, operationId: `race-${index}` }).id, first.id);
      assert.throws(() => service.startExport(board.id, { expectedRevision: 1, operationId: `busy-${index}` }), (error: unknown) => (error as { code?: string }).code === 'BUSY');
      await startedWork;
      const cancelled = await service.cancelExport(first.id);
      assert.equal(cancelled.status, 'cancelled'); assert.equal(service.getExport(first.id).artifact, undefined);
    }
    assert.equal(calls, 100);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('failed durable export creation causes zero editor starts and v0.4 backup preserves exact v0.3 bytes', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v04-durable-'));
  try {
    let fail = false;
    const store = new Store(directory, { write: (file, value) => { if (fail) throw new Error('disk full'); atomicWrite(file, value); } });
    const board = store.read().boards[0], artifact: Artifact = { kind: 'video', url: '/api/media/' + 'b'.repeat(64), localId: 'b'.repeat(64), localUrl: '/api/media/' + 'b'.repeat(64), bytes: 100, sha256: 'b'.repeat(64), mimeType: 'video/mp4' };
    store.transaction(data => { data.timelines = [{ boardId: board.id, revision: 1, format: 'landscape', clips: [{ id: 'clip', source: { runId: 'run', nodeId: 'node', artifactIndex: 0 }, inSeconds: 0, outSeconds: 1, artifact, media: { duration: 1, width: 640, height: 360, hasAudio: false } }] }]; });
    const preV04 = readFileSync(store.file); let starts = 0;
    unlinkSync(path.join(directory, '.workspace-v0.4')); // simulate a workspace last written by v0.3
    const fakeEditor = { export: async () => { starts++; return artifact; }, capabilities: async () => ({ available: true }) } as unknown as EditorRuntime;
    const service = new CanvasService(store, undefined, undefined, undefined, fakeEditor);
    fail = true;
    assert.throws(() => service.startExport(board.id, { expectedRevision: 1, operationId: 'must-not-start' }), /disk full/);
    assert.equal(starts, 0);
    fail = false;
    const reopened = new Store(directory);
    assert.deepEqual(readFileSync(path.join(directory, 'workspace.pre-v0.4.json')), preV04);
    assert.equal(reopened.read().exports?.length ?? 0, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('real server SIGKILL disconnects supervisor, stops its process group, and restart fences the job as interrupted', { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v04-crash-')), tools = mkdtempSync(path.join(os.tmpdir(), 'relay-v04-tools-'));
  let server: ChildProcess | undefined;
  try {
    const fixture = makeFixtures(directory), store = new Store(directory), initial = new CanvasService(store), artifact = await saveVideo(initial, fixture.audible), board = initial.board('welcome');
    store.transaction(data => { data.timelines = [{ boardId: board.id, revision: 1, format: 'landscape', clips: [{ id: 'crash-clip', source: { runId: 'unused', nodeId: 'unused', artifactIndex: 0 }, inSeconds: 0, outSeconds: 2, artifact, media: { duration: 4, width: 640, height: 360, hasAudio: true } }] }]; });
    const ffmpeg = path.join(tools, 'ffmpeg'), ffprobe = path.join(tools, 'ffprobe');
    writeFileSync(ffmpeg, `#!/bin/sh
case " $* " in
  *" -version "*) echo "ffmpeg version 9.0.1"; exit 0 ;;
  *" -encoders "*) echo " V..... libx264 H264"; echo " A..... aac AAC"; exit 0 ;;
  *" demuxer=mov "*) echo "enable_drefs use_absolute_path"; exit 0 ;;
esac
for output in "$@"; do :; done
trap 'exit 143' TERM INT
: > "$output"
while :; do dd if=/dev/zero bs=1024 count=1 >> "$output" 2>/dev/null; sleep 0.02; done
`); chmodSync(ffmpeg, 0o755);
    writeFileSync(ffprobe, '#!/bin/sh\necho "ffprobe version 9.0.1"\nexit 0\n'); chmodSync(ffprobe, 0o755);
    const port = await freePort();
    server = spawn(process.execPath, ['--import', 'tsx', 'server/main.ts'], { cwd: path.resolve('.'), env: { ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH ?? ''}`, RELAY_DATA_DIR: directory, RELAY_PORT: String(port) }, stdio: 'ignore' });
    const sessionFile = path.join(directory, 'session.json');
    const session = await waitFor(() => {
      if (!existsSync(sessionFile)) return undefined;
      try { return JSON.parse(readFileSync(sessionFile, 'utf8')) as { origin: string; token: string }; } catch { return undefined; }
    });
    const headers = { Origin: session.origin, 'X-Canvas-Token': session.token, 'Content-Type': 'application/json' };
    const response = await fetch(`${session.origin}/api/boards/welcome/exports`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: 1, operationId: 'crash-export' }) });
    assert.equal(response.status, 202, await response.text());
    const segment = await waitFor(() => {
      const root = path.join(directory, 'editor-jobs');
      for (const job of readdirSync(root)) { const file = path.join(root, job, 'segment-000.mp4'); if (existsSync(file) && readFileSync(file).length > 2048) return file; }
      return undefined;
    });
    server.kill('SIGKILL'); await new Promise<void>(resolve => server!.once('exit', () => resolve())); server = undefined;
    await new Promise(resolve => setTimeout(resolve, 1_500)); const stoppedAt = readFileSync(segment).length;
    await new Promise(resolve => setTimeout(resolve, 500)); assert.equal(readFileSync(segment).length, stoppedAt);
    const recovered = new Store(directory), job = recovered.read().exports?.find(candidate => candidate.operationId === 'crash-export');
    assert.equal(job?.status, 'interrupted'); assert.equal(job?.artifact, undefined);
  } finally {
    if (server?.pid) { try { server.kill('SIGKILL'); } catch { /* already stopped */ } }
    rmSync(directory, { recursive: true, force: true }); rmSync(tools, { recursive: true, force: true });
  }
});

test('real FFmpeg export preserves trim, order, aspect padding, AAC and mixed audible/silent intervals in both formats', { timeout: 120_000 }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v04-real-'));
  try {
    const fixture = makeFixtures(directory), store = new Store(directory), service = new CanvasService(store);
    assert.equal((await service.editor.capabilities()).available, true);
    const audible = await saveVideo(service, fixture.audible), silent = await saveVideo(service, fixture.silent), board = service.board('welcome');
    const run: Run = { id: 'video-run', boardId: board.id, revision: board.revision, operationId: 'video-operation', status: 'succeeded', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), snapshot: board, providers: store.read().providers, order: ['audible', 'silent'], results: { audible: { nodeId: 'audible', status: 'succeeded', artifacts: [audible] }, silent: { nodeId: 'silent', status: 'succeeded', artifacts: [silent] } } };
    store.transaction(data => { data.runs.push(run); });
    let revision = 0;
    for (const format of ['landscape', 'portrait'] as const) {
      const timeline = await service.saveTimeline(board.id, { expectedRevision: revision, format, clips: [
        { id: 'silent-clip', source: { runId: run.id, nodeId: 'silent', artifactIndex: 0 }, inSeconds: 1, outSeconds: 3 },
        { id: 'audible-clip', source: { runId: run.id, nodeId: 'audible', artifactIndex: 0 }, inSeconds: 1, outSeconds: 3 },
      ] });
      revision = timeline.revision;
      const started = service.startExport(board.id, { expectedRevision: revision, operationId: `export-${format}` });
      const finished = await service.settledExport(started.id);
      assert.equal(finished.status, 'succeeded', finished.error);
      const located = service.media.fileFor(finished.artifact!);
      const copy = path.join(directory, `${format}.mp4`); writeFileSync(copy, readFileSync(located.fd)); service.media.releaseFile(located.fd);
      const dimensions = format === 'landscape' ? [1280, 720] as const : [720, 1280] as const;
      const metadata = JSON.parse(command('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type,width,height', '-of', 'json', copy], directory) as string) as { format: { duration: string }; streams: Array<{ codec_name: string; codec_type: string; width?: number; height?: number }> };
      assert.ok(Math.abs(Number(metadata.format.duration) - 4) < 0.15);
      assert.deepEqual(metadata.streams.find(stream => stream.codec_type === 'video') && { width: metadata.streams[0].width, height: metadata.streams[0].height }, { width: dimensions[0], height: dimensions[1] });
      assert.equal(metadata.streams.find(stream => stream.codec_type === 'audio')?.codec_name, 'aac');
      const early = frame(copy, 0.25, dimensions[0], dimensions[1], directory), silentLate = frame(copy, 1.25, dimensions[0], dimensions[1], directory), audibleEarly = frame(copy, 2.25, dimensions[0], dimensions[1], directory), audibleLate = frame(copy, 3.25, dimensions[0], dimensions[1], directory);
      dominant(pixel(early, dimensions[0], Math.floor(dimensions[0] / 2), Math.floor(dimensions[1] / 2)), 'blue');
      dominant(pixel(silentLate, dimensions[0], Math.floor(dimensions[0] / 2), Math.floor(dimensions[1] / 2)), 'yellow');
      dominant(pixel(audibleEarly, dimensions[0], Math.floor(dimensions[0] / 2), Math.floor(dimensions[1] / 2)), 'red');
      dominant(pixel(audibleLate, dimensions[0], Math.floor(dimensions[0] / 2), Math.floor(dimensions[1] / 2)), 'green');
      if (format === 'landscape') dominant(pixel(early, dimensions[0], 10, Math.floor(dimensions[1] / 2)), 'black');
      else dominant(pixel(audibleEarly, dimensions[0], Math.floor(dimensions[0] / 2), 10), 'black');
      const pcm = command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', copy, '-f', 's16le', '-ac', '1', '-ar', '8000', 'pipe:1'], directory, 'buffer') as Buffer;
      assert.ok(rms(pcm, 0.25, 1.75) < 20);
      assert.ok(rms(pcm, 2.25, 3.75) > 300);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
