import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const archive = `${pkg.name}-${pkg.version}.tar.gz`;
mkdirSync(path.join(root, 'work'), { recursive: true });
const directory = mkdtempSync(path.join(root, 'work', 'clean-release-'));
const unpack = spawnSync('tar', ['-xzf', path.join(root, 'release', archive), '-C', directory], { stdio: 'inherit', timeout: 30000 });
assert.equal(unpack.status, 0, 'release archive extracts');
const install = spawnSync('npm', ['ci', '--omit=dev', '--no-fund'], { cwd: directory, stdio: 'inherit', timeout: 180000 });
assert.equal(install.status, 0, 'production dependencies install without source checkout');
const portProbe = net.createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const dataDir = path.join(directory, '.relay-canvas');
const child = spawn(process.execPath, ['build/server/main.js'], { cwd: directory, env: { ...process.env, RELAY_PORT: String(port), RELAY_ENABLE_REMOTE: 'false', RELAY_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
// Drain output without retaining session data or surfacing physical paths.
child.stdout.resume(); child.stderr.resume();
async function until(probe, predicate, label, timeout = 30000) {
  const end = Date.now() + timeout;
  do { try { const value = await probe(); if (predicate(value)) return value; } catch { /* bounded startup/poll */ } await delay(100); } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
}
try {
  await until(() => fetch(`${origin}/healthz`).then(r => r.json()), value => value.version === pkg.version, 'packaged startup/version');
  assert.match(await (await fetch(origin)).text(), /Relay Canvas/);
  const { token } = JSON.parse(readFileSync(path.join(dataDir, 'session.json'), 'utf8'));
  const headers = { Origin: origin, 'X-Canvas-Token': token, 'Content-Type': 'application/json' };
  async function api(endpoint, method = 'GET', body) {
    const response = await fetch(`${origin}${endpoint}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(response.ok, `${method} ${endpoint}: ${response.status}`);
    return response.json();
  }
  const run = await api('/api/runs', 'POST', { boardId: 'welcome', expectedRevision: 0, operationId: 'package-smoke' });
  const result = await until(() => api(`/api/runs/${run.id}`), value => value.status === 'succeeded', 'packaged Demo workflow');
  assert.equal(result.results.motion.referenceUrl, result.results.frame.artifacts[0].url);
  for (const nodeId of ['frame', 'motion']) {
    const saved = await api(`/api/runs/${run.id}/artifacts/${nodeId}/0/save`, 'POST', {});
    assert.equal(saved.url, result.results[nodeId].artifacts[0].url);
    const response = await fetch(`${origin}${saved.localUrl}`, { headers });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, saved.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), saved.sha256);
  }
  const info = await api(`/api/runs/${run.id}/artifacts/motion/0/info`);
  assert.ok(info.media.duration >= 2.9 && info.media.duration <= 3.1, 'packaged ffprobe reads bundled saved video');
  const importedBytes = readFileSync(path.join(directory, 'dist', 'demo-motion.mp4'));
  const importedSha256 = createHash('sha256').update(importedBytes).digest('hex');
  const importQuery = new URLSearchParams({ expectedRevision: '0', operationId: 'package-import', kind: 'video', name: 'package-source.mp4' });
  const importEndpoint = `${origin}/api/boards/welcome/imports?${importQuery}`;
  const importHeaders = { Origin: origin, 'X-Canvas-Token': token, 'Content-Type': 'video/mp4', 'Content-Length': String(importedBytes.length) };
  async function importPackageSource() {
    const response = await fetch(importEndpoint, { method: 'POST', headers: importHeaders, body: importedBytes });
    assert.equal(response.status, 201, `POST ${importEndpoint}: ${response.status}`);
    return response.json();
  }
  const imported = await importPackageSource();
  assert.equal(imported.asset.id, 'package-import');
  assert.equal(imported.asset.name, 'package-source.mp4');
  assert.equal(imported.asset.artifact.kind, 'video');
  assert.equal(imported.asset.artifact.mimeType, 'video/mp4');
  assert.equal(imported.asset.artifact.bytes, importedBytes.length);
  assert.equal(imported.asset.artifact.sha256, importedSha256);
  assert.equal(imported.asset.artifact.localId, importedSha256);
  assert.equal(imported.asset.artifact.localUrl, `/api/media/${importedSha256}`);
  assert.equal(imported.nodePresent, true);
  assert.equal(imported.board.revision, 1);
  const replayedImport = await importPackageSource();
  assert.deepEqual(replayedImport.asset, imported.asset, 'identical import replay returns the same asset');
  assert.equal(replayedImport.board.revision, imported.board.revision, 'identical import replay does not increase board revision');
  assert.equal(replayedImport.nodePresent, true);
  const importedRun = await api('/api/runs', 'POST', { boardId: 'welcome', expectedRevision: imported.board.revision, operationId: 'package-local-source', nodeId: imported.asset.nodeId, confirmExternal: false });
  const importedResult = await until(() => api(`/api/runs/${importedRun.id}`), value => value.status === 'succeeded', 'packaged imported passthrough workflow');
  assert.deepEqual(importedResult.order, [imported.asset.nodeId]);
  assert.equal(importedResult.results[imported.asset.nodeId].status, 'succeeded');
  const importedArtifact = importedResult.results[imported.asset.nodeId].artifacts[0];
  assert.equal(importedArtifact.localId, importedSha256);
  assert.equal(importedArtifact.localUrl, `/api/media/${importedSha256}`);
  assert.equal(importedArtifact.bytes, importedBytes.length);
  assert.equal(importedArtifact.sha256, importedSha256);
  assert.equal(importedArtifact.mimeType, 'video/mp4');
  assert.equal(importedArtifact.demo, undefined);
  assert.equal(importedResult.results[imported.asset.nodeId].remoteId, undefined);
  const importedPrivate = await fetch(`${origin}${importedArtifact.localUrl}`);
  assert.equal(importedPrivate.status, 403);
  const importedReadBack = await fetch(`${origin}${importedArtifact.localUrl}`, { headers });
  assert.equal(importedReadBack.status, 200);
  const importedReadBackBytes = Buffer.from(await importedReadBack.arrayBuffer());
  assert.equal(importedReadBackBytes.length, importedBytes.length);
  assert.equal(createHash('sha256').update(importedReadBackBytes).digest('hex'), importedSha256);
  let timeline = await api('/api/boards/welcome/timeline');
  const clips = [
    { id: 'package-clip-a', source: { runId: run.id, nodeId: 'motion', artifactIndex: 0 }, inSeconds: 0.25, outSeconds: 1.25 },
    { id: 'package-clip-b', source: { runId: importedRun.id, nodeId: imported.asset.nodeId, artifactIndex: 0 }, inSeconds: 1.5, outSeconds: 2.5 },
  ];
  const formats = [];
  for (const format of ['landscape', 'portrait']) {
    timeline = await api('/api/boards/welcome/timeline', 'PUT', { expectedRevision: timeline.revision, format, clips });
    const request = { expectedRevision: timeline.revision, operationId: `package-${format}` };
    const job = await api('/api/boards/welcome/exports', 'POST', request);
    assert.equal((await api('/api/boards/welcome/exports', 'POST', request)).id, job.id);
    const finished = await until(() => api(`/api/exports/${job.id}`), value => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.status), `packaged ${format} export`, 180000);
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.snapshot.revision, timeline.revision);
    const output = finished.artifact;
    assert.match(output.localUrl, /^\/api\/media\/[a-f0-9]{64}$/);
    assert.equal((await fetch(`${origin}${output.localUrl}`)).status, 403);
    const response = await fetch(`${origin}${output.localUrl}`, { headers });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), output.sha256);
    assert.equal(bytes.length, output.bytes);
    const file = path.join(directory, `${format}-verified.mp4`);
    writeFileSync(file, bytes);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height,codec_type', '-of', 'json', file], { encoding: 'utf8', timeout: 10000 });
    assert.equal(probe.status, 0);
    const metadata = JSON.parse(probe.stdout);
    const video = metadata.streams.find(stream => stream.codec_type === 'video');
    const audio = metadata.streams.find(stream => stream.codec_type === 'audio');
    assert.equal(video.codec_name, 'h264'); assert.equal(audio.codec_name, 'aac');
    assert.equal(video.width, format === 'landscape' ? 1280 : 720);
    assert.equal(video.height, format === 'landscape' ? 720 : 1280);
    assert.ok(Math.abs(Number(metadata.format.duration) - 2) < 0.25);
    const range = await fetch(`${origin}${output.localUrl}`, { headers: { ...headers, Range: 'bytes=0-31' } });
    assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32);
    formats.push({ format, width: video.width, height: video.height, sha256: output.sha256 });
  }
  writeFileSync(path.join(root, 'work', 'package-smoke.json'), JSON.stringify({ status: 'PASS', platform: process.platform, version: pkg.version, archive, checks: ['clean extraction', 'production dependency install', 'packaged startup/UI/Demo', 'private local save and hash read-back', 'real ffprobe', 'raw MP4 import with saved artifact hash/bytes and node identity', 'identical import replay preserves asset/node and board revision', 'private local passthrough run with no remote generation', 'real trimmed two-clip mixed Demo/imported landscape and portrait MP4 exports', 'idempotency', 'H264/AAC/duration/dimensions', 'export auth/Range/hash'], formats, paidRequests: 0 }, null, 2));
  console.log('PASS: clean release install, actual packaged landscape/portrait MP4 export and private media read-back.');
} finally {
  const stopped = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([stopped, delay(3000)]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await stopped; }
}
