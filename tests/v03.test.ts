import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { downloadMedia, MAX_MEDIA_BYTES, MediaStore, type MediaDownloadOptions } from '../server/media.js';
import { generate, providerDiagnostics, providerModels, type ProviderTransport } from '../server/providers.js';
import { CanvasService } from '../server/service.js';
import { Store, atomicWrite } from '../server/store.js';
import type { Artifact, GenerationRequest, Provider, StoreData } from '../src/shared/types.js';

const policy = { remoteEnabled: true, providerOrigins: ['https://api.example.com'], mediaOrigins: ['https://media.example.com'] };
const env = { RELAY_KEY_TEST: 'fixture-secret' };
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(8)]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 12]), Buffer.from('ftyp'), Buffer.from('isom')]);

function provider(protocol: Provider['protocol'], overrides: Partial<Provider> = {}): Provider {
  return { id: `p-${protocol}`, name: protocol, protocol, baseUrl: 'https://api.example.com/v1', keyEnv: protocol === 'demo' ? '' : 'RELAY_KEY_TEST', imageModel: 'image', videoModel: 'video', ...overrides };
}
function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return { kind: 'video', model: 'video-model', prompt: 'move', params: {}, referenceField: 'image_url', signal: new AbortController().signal, onSubmitted: () => undefined, ...overrides };
}
async function freePort() { const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port; }

function mediaRequestFixture(configure: (response: PassThrough, request: EventEmitter, options: Record<string, unknown>) => void): NonNullable<MediaDownloadOptions['requestImpl']> {
  return ((_url: URL, options: Record<string, unknown>, callback: (response: PassThrough) => void) => {
    const request = new EventEmitter() as EventEmitter & { destroyed?: boolean; destroy(): void; end(): void };
    request.destroy = () => { request.destroyed = true; request.emit('close'); };
    request.end = () => {
      const lookup = options.lookup as (hostname: string, options: { family: number }, callback: (error: Error | null, address: string, family: number) => void) => void;
      lookup('media.example.com', { family: 0 }, error => {
        if (error) { request.emit('error', error); return; }
        const response = new PassThrough() as PassThrough & { statusCode?: number; headers?: Record<string, string> };
        response.statusCode = 200; response.headers = { 'content-type': 'image/png' };
        configure(response, request, options); callback(response);
      });
    };
    return request;
  }) as unknown as NonNullable<MediaDownloadOptions['requestImpl']>;
}

test('VIDEOS_CONTRACT uses fixed paths, strict params, persisted IDs, both URL fields, and never retries POST', async () => {
  for (const field of ['url', 'video_url'] as const) {
    const events: string[] = [];
    const responses: unknown[] = [{ id: 'video_1', status: 'queued' }, { id: 'video_1', status: 'in_progress' }, { id: 'video_1', status: 'completed', [field]: 'https://media.example.com/out.mp4' }];
    const output = await generate(provider('videos'), request({
      params: { seconds: '8', size: '1280x720' }, referenceUrl: 'https://media.example.com/input.png',
      onSubmitted: id => { events.push(`saved:${id}`); },
    }), { policy, env, pollIntervalMs: 0, transport: async (url, options) => { events.push(`${options.method}:${url}:${JSON.stringify(options.body)}`); return responses.shift(); } });
    assert.equal(output.remoteId, 'video_1');
    assert.equal(output.artifacts[0].url, 'https://media.example.com/out.mp4');
    assert.deepEqual(events.slice(0, 2), [
      'POST:https://api.example.com/v1/videos:{"model":"video-model","prompt":"move","seconds":"8","size":"1280x720","input_reference":{"image_url":"https://media.example.com/input.png"}}',
      'saved:video_1',
    ]);
    assert.equal(events.filter(value => value.startsWith('POST:')).length, 1);
    assert.match(events.at(-1)!, /GET:https:\/\/api\.example\.com\/v1\/videos\/video_1/);
  }
  const immediate: string[] = [];
  await generate(provider('videos'), request({ onSubmitted: id => { immediate.push(id); } }), {
    policy, env, transport: async () => ({ id: 'now', status: 'completed', url: 'https://media.example.com/now.mp4' }),
  });
  assert.deepEqual(immediate, ['now']);
  for (const params of [
    { seconds: 4 }, { seconds: '5' }, { size: '1920x1080' }, { extra: true }, { seconds: '4', nested: {} },
  ]) {
    let calls = 0;
    await assert.rejects(generate(provider('videos'), request({ params }), { policy, env, transport: async () => { calls++; return {}; } }));
    assert.equal(calls, 0);
  }
  for (const created of [
    { id: '../bad', status: 'queued' }, { id: 'ok', status: 'unknown' }, { id: 'ok', status: 'failed' }, { id: 'ok', status: 'completed' },
  ]) {
    let calls = 0;
    await assert.rejects(generate(provider('videos'), request(), { policy, env, transport: async () => { calls++; return created; } }));
    assert.equal(calls, 1);
  }
  let referenceCalls = 0;
  await assert.rejects(generate(provider('videos'), request({ referenceUrl: 'https://evil.example/x.png' }), { policy, env, transport: async () => { referenceCalls++; return {}; } }));
  assert.equal(referenceCalls, 0);
});

test('OpenAI base64 MIME follows validated output_format while fixture text remains generation-compatible', async () => {
  for (const [format, mime] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']] as const) {
    const output = await generate(provider('openai'), request({ kind: 'image', model: 'gpt-image-1', params: { output_format: format } }), {
      policy, env, transport: async () => ({ data: [{ b64_json: 'aGVsbG8=' }] }),
    });
    assert.match(output.artifacts[0].url, new RegExp(`^data:${mime};base64,`));
  }
  let calls = 0;
  await assert.rejects(generate(provider('openai'), request({ kind: 'image', model: 'gpt-image-1', params: { output_format: 'gif' } }), { policy, env, transport: async () => { calls++; return {}; } }));
  assert.equal(calls, 0);
});

test('DIAG_SECRETS exposes only booleans and fixed codes; model discovery accepts only safe data[].id', async () => {
  const profiles = [provider('demo'), provider('openai'), provider('videos'), provider('fal')];
  const diagnostics = providerDiagnostics(profiles, { ...policy, remoteEnabled: false }, {});
  assert.equal(diagnostics.find(value => value.providerId === 'p-openai')?.credentialConfigured, false);
  assert.deepEqual(diagnostics.find(value => value.providerId === 'p-videos')?.capabilities, ['video']);
  assert.doesNotMatch(JSON.stringify(diagnostics), /fixture-secret/);
  let calls: Array<{ url: string; authorization?: string }> = [];
  const result = await providerModels(provider('openai'), { policy, env, transport: async (url, options) => {
    calls.push({ url, authorization: options.headers.authorization });
    return { data: [{ id: 'model-1', secret: 'ignored' }, { id: 'model-1' }, { id: 'org/model_2' }] };
  } });
  assert.deepEqual(result.models, ['model-1', 'org/model_2']);
  assert.deepEqual(calls, [{ url: 'https://api.example.com/v1/models', authorization: 'Bearer fixture-secret' }]);
  calls = [];
  await assert.rejects(providerModels(provider('openai'), { policy, env: {}, transport: async () => { calls.push({ url: '' }); return {}; } }));
  assert.equal(calls.length, 0);
  for (const response of [{ models: [] }, { data: [{ id: 'fixture-secret-model' }] }, { data: [{ id: '' }] }, { data: ['model'] }]) {
    await assert.rejects(providerModels(provider('openai'), { policy, env, transport: async () => response }));
  }
  await assert.rejects(providerModels(provider('replicate'), { policy, env, transport: async () => ({ data: [] }) }), /not supported/);
  assert.deepEqual(await providerModels(provider('demo'), { policy, env: {} }), { models: ['demo-image', 'demo-video'] });
});

test('MEDIA_DOWNLOAD rejects private or mixed DNS before any socket and MEDIA_STORE validates signatures, MIME, dedup, quota, and atomic failure', async () => {
  await assert.rejects(downloadMedia('https://media.example.com/a.png', policy, { resolve: async () => [{ address: '127.0.0.1', family: 4 }] }), /not allowed/);
  await assert.rejects(downloadMedia('https://media.example.com/a.png', policy, { resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] }), /not allowed/);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-media-'));
  try {
    let fetches = 0;
    const store = new MediaStore(dir, policy, async () => { fetches++; return { bytes: png, contentType: 'image/png' }; });
    const source: Artifact = { kind: 'image', url: 'https://media.example.com/a.png' };
    let first!: Artifact;
    await Promise.all([
      store.save(source, artifact => { first = artifact; }),
      store.save(source, () => undefined),
    ]);
    assert.equal(fetches, 2); assert.equal(first.localId, first.sha256); assert.equal(first.bytes, png.length);
    const located = store.fileFor(first); assert.equal(located.size, png.length); store.releaseFile(located.fd);
    const before = new Set((await import('node:fs')).readdirSync(store.directory));
    await assert.rejects(store.save({ kind: 'image', url: 'https://media.example.com/b.png' }, () => { throw new Error('metadata'); }));
    assert.deepEqual(new Set((await import('node:fs')).readdirSync(store.directory)), before);
    const mismatch = new MediaStore(mkdtempSync(path.join(os.tmpdir(), 'relay-mismatch-')), policy, async () => ({ bytes: png, contentType: 'image/jpeg' }));
    await assert.rejects(mismatch.save(source, () => undefined), /type mismatch/);
    const invalid = new MediaStore(mkdtempSync(path.join(os.tmpdir(), 'relay-invalid-')), policy, async () => ({ bytes: Buffer.from('<html>'), contentType: 'text/html' }));
    await assert.rejects(invalid.save(source, () => undefined), /signature/);
    const quotaDir = mkdtempSync(path.join(os.tmpdir(), 'relay-quota-')); const quota = new MediaStore(quotaDir, policy, async () => ({ bytes: png, contentType: 'image/png' }));
    const orphan = path.join(quota.directory, 'orphan.bin'); writeFileSync(orphan, ''); truncateSync(orphan, 512 * 1024 * 1024);
    await assert.rejects(quota.save(source, () => undefined), /quota/);
    rmSync(path.dirname(mismatch.directory), { recursive: true, force: true }); rmSync(path.dirname(invalid.directory), { recursive: true, force: true }); rmSync(quotaDir, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MEDIA_DOWNLOAD fixture covers pinned TLS, redirects, declared/stream bounds, mismatch, abort, and total deadline', async () => {
  const publicResolve = async () => [{ address: '8.8.8.8', family: 4 }];
  let pinned = '', servername = '';
  const success = await downloadMedia('https://media.example.com/a.png', policy, {
    resolve: publicResolve,
    requestImpl: mediaRequestFixture((response, _request, options) => {
      servername = String(options.servername);
      const lookup = options.lookup as (hostname: string, options: { family: number }, callback: (error: Error | null, address: string) => void) => void;
      lookup('media.example.com', { family: 0 }, (_error, address) => { pinned = address; queueMicrotask(() => response.end(png)); });
    }),
  });
  assert.equal(success.bytes.equals(png), true); assert.equal(pinned, '8.8.8.8'); assert.equal(servername, 'media.example.com');

  await assert.rejects(downloadMedia('https://media.example.com/a.png', policy, {
    resolve: publicResolve,
    requestImpl: mediaRequestFixture(response => { Object.assign(response, { statusCode: 302, headers: { location: 'https://media.example.com/b.png' } }); queueMicrotask(() => response.end()); }),
  }), /redirect/);
  await assert.rejects(downloadMedia('https://media.example.com/a.png', policy, {
    resolve: publicResolve,
    requestImpl: mediaRequestFixture(response => { Object.assign(response, { headers: { 'content-type': 'image/png', 'content-length': String(MAX_MEDIA_BYTES + 1) } }); queueMicrotask(() => response.end()); }),
  }), /download failed/);
  const exact = await downloadMedia('https://media.example.com/a.png', policy, {
    resolve: publicResolve,
    requestImpl: mediaRequestFixture(response => { Object.assign(response, { headers: { 'content-type': 'image/png', 'content-length': String(MAX_MEDIA_BYTES) } }); queueMicrotask(() => response.end(Buffer.alloc(MAX_MEDIA_BYTES))); }),
  });
  assert.equal(exact.bytes.length, MAX_MEDIA_BYTES);
  await assert.rejects(downloadMedia('https://media.example.com/a.png', policy, {
    resolve: publicResolve,
    requestImpl: mediaRequestFixture(response => { queueMicrotask(() => { response.write(Buffer.alloc(MAX_MEDIA_BYTES)); response.end(Buffer.from([0])); }); }),
  }), /file limit/);
  await assert.rejects(downloadMedia('https://media.example.com/a.png', policy, {
    resolve: publicResolve,
    requestImpl: mediaRequestFixture(response => { Object.assign(response, { headers: { 'content-type': 'image/png', 'content-length': '9' } }); queueMicrotask(() => response.end(png)); }),
  }), /length mismatch/);
  await assert.rejects(downloadMedia('https://media.example.com/a.png', policy, {
    resolve: publicResolve,
    requestImpl: mediaRequestFixture(response => { queueMicrotask(() => response.emit('aborted')); }),
  }), /download failed/);
  let requested = false;
  await assert.rejects(downloadMedia('https://media.example.com/a.png', policy, {
    deadlineMs: 2,
    resolve: async () => await new Promise(resolve => setTimeout(() => resolve([{ address: '8.8.8.8', family: 4 }]), 10)),
    requestImpl: mediaRequestFixture(() => { requested = true; }),
  }), /download failed|timed out/);
  assert.equal(requested, false);
});

test('media root rejects symlink startup and directory replacement without touching the target', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'relay-root-')); const target = mkdtempSync(path.join(os.tmpdir(), 'relay-target-'));
  try {
    const sentinel = path.join(target, 'sentinel'); writeFileSync(sentinel, 'unchanged'); chmodSync(target, 0o755);
    const beforeMode = lstatSync(target).mode & 0o777;
    const linkedRoot = path.join(dataDir, 'linked-root'); symlinkSync(target, linkedRoot);
    assert.throws(() => new Store(linkedRoot), /Unsafe workspace/);
    assert.equal((await import('node:fs')).existsSync(path.join(target, 'workspace.json')), false);
    symlinkSync(target, path.join(dataDir, 'media'));
    assert.throws(() => new MediaStore(dataDir, policy), /Unsafe media store/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'unchanged'); assert.equal(lstatSync(target).mode & 0o777, beforeMode);
    rmSync(path.join(dataDir, 'media'));
    const store = new MediaStore(dataDir, policy, async () => ({ bytes: png, contentType: 'image/png' }));
    const displaced = path.join(dataDir, 'media-old'); renameSync(store.directory, displaced); mkdirSync(store.directory, { mode: 0o700 });
    await assert.rejects(store.save({ kind: 'image', url: 'https://media.example.com/a.png' }, () => undefined), /Unsafe media store/);
    const fake: Artifact = { kind: 'image', url: 'x', localId: 'a'.repeat(64), localUrl: `/api/media/${'a'.repeat(64)}`, sha256: 'a'.repeat(64), bytes: 1, mimeType: 'image/png' };
    assert.throws(() => store.fileFor(fake), /Unsafe media store/);
  } finally { rmSync(dataDir, { recursive: true, force: true }); rmSync(target, { recursive: true, force: true }); }
});

test('packaged Demo video save uses the fixed dist asset without a public directory', async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'relay-pack-data-'));
  const packageRoot = mkdtempSync(path.join(os.tmpdir(), 'relay-pack-root-'));
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
    writeFileSync(path.join(packageRoot, 'dist', 'demo-motion.mp4'), mp4, { mode: 0o600 });
    const store = new MediaStore(dataDir, policy, async () => { throw new Error('network forbidden'); }, packageRoot);
    let saved!: Artifact;
    await store.save({ kind: 'video', url: '/demo-motion.mp4', demo: true }, artifact => { saved = artifact; });
    assert.equal(saved.mimeType, 'video/mp4'); assert.equal(saved.bytes, mp4.length);
    const located = store.fileFor(saved); assert.equal(readFileSync(located.fd).equals(mp4), true); store.releaseFile(located.fd);
  } finally { rmSync(dataDir, { recursive: true, force: true }); rmSync(packageRoot, { recursive: true, force: true }); }
});

test('artifact saves coalesce 100 identical requests, cap distinct work, and abort without metadata', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-coalesce-')); let fetches = 0;
  try {
    const store = new Store(dir);
    const media = new MediaStore(dir, { ...policy, remoteEnabled: false }, async () => { fetches++; await new Promise(resolve => setTimeout(resolve, 5)); return { bytes: png, contentType: 'image/png' }; });
    const service = new CanvasService(store, { ...policy, remoteEnabled: false }, async (_provider, generation) => ({ artifacts: [{ kind: generation.kind, url: 'https://media.example.com/result.png' }] }), media);
    const run = service.start({ boardId: 'welcome', expectedRevision: 0, operationId: randomUUID(), nodeId: 'frame' }); await service.settled(run.id);
    const results = await Promise.all(Array.from({ length: 100 }, () => service.saveArtifact(run.id, 'frame', 0)));
    assert.equal(fetches, 1); assert.equal(new Set(results.map(value => value.localId)).size, 1);

    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const busyMedia = new MediaStore(mkdtempSync(path.join(os.tmpdir(), 'relay-busy-')), { ...policy, remoteEnabled: false }, async () => { await barrier; return { bytes: png, contentType: 'image/png' }; });
    const busyStore = new Store(path.dirname(busyMedia.directory));
    const busyService = new CanvasService(busyStore, { ...policy, remoteEnabled: false }, undefined, busyMedia);
    const template = busyService.board('welcome');
    busyStore.transaction(data => {
      for (let index = 0; index < 9; index++) data.runs.push({ id: `save-${index}`, boardId: template.id, revision: 0, operationId: `save-op-${index}`, status: 'succeeded', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), snapshot: template, providers: data.providers, order: ['frame'], results: { frame: { nodeId: 'frame', status: 'succeeded', artifacts: [{ kind: 'image', url: `https://media.example.com/${index}.png` }] } } });
    });
    const pending = Array.from({ length: 8 }, (_, index) => busyService.saveArtifact(`save-${index}`, 'frame', 0));
    await assert.rejects(busyService.saveArtifact('save-8', 'frame', 0), (error: unknown) => error instanceof Error && /同時保存/.test(error.message));
    release(); await Promise.all(pending); rmSync(path.dirname(busyMedia.directory), { recursive: true, force: true });

    const abortDir = mkdtempSync(path.join(os.tmpdir(), 'relay-abort-')); const abortStore = new Store(abortDir);
    const abortMedia = new MediaStore(abortDir, { ...policy, remoteEnabled: false }, async (_url, _policy, signal) => await new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const abortService = new CanvasService(abortStore, { ...policy, remoteEnabled: false }, async (_provider, generation) => ({ artifacts: [{ kind: generation.kind, url: 'https://media.example.com/abort.png' }] }), abortMedia);
    const abortRun = abortService.start({ boardId: 'welcome', expectedRevision: 0, operationId: randomUUID(), nodeId: 'frame' }); await abortService.settled(abortRun.id);
    const controller = new AbortController(); const saving = abortService.saveArtifact(abortRun.id, 'frame', 0, controller.signal); controller.abort();
    await assert.rejects(saving); assert.equal(abortService.getRun(abortRun.id).results.frame.artifacts[0].localId, undefined);
    rmSync(abortDir, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MEDIA_AUTH and API save enforce scoped cookie, header boundary, SVG sandbox, HEAD/ranges, and metadata references', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-api-v03-')); const port = await freePort(); const origin = `http://127.0.0.1:${port}`;
  const service = new CanvasService(new Store(dir)); const { app, token } = createApp(service, origin, 'a'.repeat(64));
  const server = app.listen(port, '127.0.0.1'); await new Promise<void>(resolve => server.on('listening', resolve));
  const headers = { Origin: origin, 'X-Canvas-Token': token, 'Content-Type': 'application/json' };
  try {
    const run = service.start({ boardId: 'welcome', expectedRevision: 0, operationId: randomUUID() }); await service.settled(run.id);
    assert.equal((await fetch(`${origin}/api/runs/${run.id}/artifacts/frame/0/save`, { method: 'POST', headers, body: '{"url":"bad"}' })).status, 400);
    const savedImage = await fetch(`${origin}/api/runs/${run.id}/artifacts/frame/0/save`, { method: 'POST', headers, body: '{}' });
    assert.equal(savedImage.status, 200); const imageArtifact = await savedImage.json() as Artifact;
    const savedVideo = await fetch(`${origin}/api/runs/${run.id}/artifacts/motion/0/save`, { method: 'POST', headers, body: '{}' });
    assert.equal(savedVideo.status, 200); const videoArtifact = await savedVideo.json() as Artifact;
    const session = await fetch(`${origin}/api/session`, { headers: { Origin: origin, 'X-Canvas-Client': 'ui' } });
    const setCookie = session.headers.get('set-cookie')!;
    assert.match(setCookie, /^relay_canvas_media=[a-f0-9]+; HttpOnly; SameSite=Strict; Path=\/api\/media$/);
    assert.doesNotMatch(setCookie, /Max-Age|Expires|Domain|Secure/);
    const cookie = setCookie.split(';', 1)[0];
    const svg = await fetch(`${origin}${imageArtifact.localUrl}`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(svg.status, 200); assert.equal(svg.headers.get('content-security-policy'), "sandbox; default-src 'none'");
    assert.equal((await fetch(`${origin}/api/state`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } })).status, 403);
    assert.equal((await fetch(`${origin}${imageArtifact.localUrl}`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(`${origin}${imageArtifact.localUrl}`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', Origin: 'https://evil.test' } })).status, 403);
    assert.equal((await fetch(`${origin}${imageArtifact.localUrl}`, { headers: { Cookie: `${cookie}; ${cookie}`, 'Sec-Fetch-Site': 'same-origin' } })).status, 403);
    assert.equal((await fetch(`${origin}${imageArtifact.localUrl}`, { headers: { Cookie: 'relay_canvas_media=%malformed', 'Sec-Fetch-Site': 'same-origin' } })).status, 403);
    assert.equal((await fetch(`${origin}${imageArtifact.localUrl}`, { headers: { Cookie: `relay_canvas_media=${'b'.repeat(64)}`, 'Sec-Fetch-Site': 'same-origin' } })).status, 403);
    const mediaHeaders = { Origin: origin, 'X-Canvas-Token': token };
    const head = await fetch(`${origin}${videoArtifact.localUrl}`, { method: 'HEAD', headers: mediaHeaders });
    assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0); assert.equal(Number(head.headers.get('content-length')), mp4.length === videoArtifact.bytes ? mp4.length : videoArtifact.bytes);
    const partial = await fetch(`${origin}${videoArtifact.localUrl}`, { headers: { ...mediaHeaders, Range: 'bytes=0-3' } });
    assert.equal(partial.status, 206); assert.equal((await partial.arrayBuffer()).byteLength, 4); assert.match(partial.headers.get('content-range')!, /^bytes 0-3\//);
    const abortController = new AbortController(); const abortResponse = await fetch(`${origin}${videoArtifact.localUrl}`, { headers: mediaHeaders, signal: abortController.signal }); abortController.abort();
    await abortResponse.body?.cancel().catch(() => undefined); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(service.media.openFileCount(), 0);
    assert.equal((await fetch(`${origin}${videoArtifact.localUrl}`, { headers: { ...mediaHeaders, Range: 'bytes=0-1,3-4' } })).status, 416);
    assert.equal((await fetch(`${origin}${videoArtifact.localUrl}`, { headers: { ...mediaHeaders, Range: 'bytes=-0' } })).status, 416);
    assert.equal((await fetch(`${origin}${videoArtifact.localUrl}`, { headers: { ...mediaHeaders, Range: 'bytes=999999-' } })).status, 416);
    assert.equal((await fetch(`${origin}/api/media/not-a-hash`)).status, 403);
    assert.equal((await fetch(`${origin}/api/media/not-a-hash`, { headers: mediaHeaders })).status, 400);
    assert.equal((await fetch(`${origin}/api/media/${'f'.repeat(64)}`, { headers: mediaHeaders })).status, 404);
    writeFileSync(path.join(service.media.directory, `${'e'.repeat(64)}.png`), png, { mode: 0o600 });
    assert.equal((await fetch(`${origin}/api/media/${'e'.repeat(64)}`, { headers: mediaHeaders })).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test('MEDIA_FAILURE_ISOLATION save retry never regenerates and UPGRADE_BACKUP is byte-identical with preserved v0.2 state', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-retry-')); let generates = 0; let fail = true;
  const store = new Store(dir);
  const media = new MediaStore(dir, { ...policy, remoteEnabled: false }, async () => { if (fail) throw new Error('fixture'); return { bytes: png, contentType: 'image/png' }; });
  const service = new CanvasService(store, { ...policy, remoteEnabled: false }, async (_provider, req) => {
    generates++; return { artifacts: [{ kind: req.kind, url: req.kind === 'image' ? 'https://media.example.com/a.png' : '/demo-motion.mp4', demo: req.kind === 'video' }] };
  }, media);
  try {
    const run = service.start({ boardId: 'welcome', expectedRevision: 0, operationId: randomUUID(), nodeId: 'frame' }); const completed = await service.settled(run.id);
    const original = completed.results.frame.artifacts[0].url;
    await assert.rejects(service.saveArtifact(run.id, 'frame', 0), /原始生成結果仍保留/);
    assert.equal(service.getRun(run.id).status, 'succeeded'); assert.equal(service.getRun(run.id).results.frame.artifacts[0].url, original);
    fail = false; const saved = await service.saveArtifact(run.id, 'frame', 0);
    assert.equal(saved.url, original); assert.equal(generates, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const upgradeDir = mkdtempSync(path.join(os.tmpdir(), 'relay-upgrade-'));
  try {
    const legacyBoard = { schemaVersion: 1 as const, id: 'legacy', name: 'Legacy', revision: 7, nodes: [], edges: [], viewport: { x: 1, y: 2, zoom: 1 } };
    const legacyProvider = provider('openai', { id: 'legacy-provider' });
    const legacyUrl = 'https://media.example.com/original-v02.png';
    const v02: StoreData = { schemaVersion: 1, boards: [legacyBoard], providers: [legacyProvider], runs: [{ id: 'legacy-run', boardId: 'legacy', revision: 7, operationId: 'legacy-op', status: 'succeeded', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z', snapshot: legacyBoard, providers: [legacyProvider], order: ['legacy-node'], results: { 'legacy-node': { nodeId: 'legacy-node', status: 'succeeded', artifacts: [{ kind: 'image', url: legacyUrl, mimeType: 'image/png' }] } } }] };
    const original = Buffer.from(JSON.stringify(v02)); writeFileSync(path.join(upgradeDir, 'workspace.json'), original, { mode: 0o600 });
    const upgraded = new Store(upgradeDir); assert.deepEqual(readFileSync(path.join(upgradeDir, 'workspace.pre-v0.3.json')), original);
    assert.equal(upgraded.read().boards[0].revision, 7); assert.equal(upgraded.read().providers[0].protocol, 'openai'); assert.equal(upgraded.read().runs[0].results['legacy-node'].artifacts[0].url, legacyUrl);
    const backup = JSON.parse(readFileSync(path.join(upgradeDir, 'workspace.pre-v0.3.json'), 'utf8')) as StoreData;
    assert.ok(backup.providers.every(value => ['demo', 'openai', 'fal', 'replicate'].includes(value.protocol)));
    upgraded.transaction(data => { data.boards[0].name = 'After'; });
    const reopened = new Store(upgradeDir); assert.equal(reopened.read().boards[0].name, 'After'); assert.deepEqual(readFileSync(path.join(upgradeDir, 'workspace.pre-v0.3.json')), original);
  } finally { rmSync(upgradeDir, { recursive: true, force: true }); }
});

test('rename-success directory-fsync failure reconciles memory and never deletes persisted referenced media', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-late-write-'));
  try {
    let writes = 0;
    const lateWriter: typeof atomicWrite = (file, value) => { atomicWrite(file, value); writes++; if (writes >= 2) throw new Error('fixture directory fsync failure'); };
    const store = new Store(dir, { write: lateWriter });
    assert.throws(() => store.transaction(data => { data.boards[0].name = 'durable despite late error'; }));
    assert.equal(store.read().boards[0].name, 'durable despite late error');
    assert.equal(new Store(dir).read().boards[0].name, 'durable despite late error');
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const mediaDir = mkdtempSync(path.join(os.tmpdir(), 'relay-late-media-'));
  try {
    const initial = new Store(mediaDir);
    const initialService = new CanvasService(initial, { ...policy, remoteEnabled: false }, async (_provider, generation) => ({ artifacts: [{ kind: generation.kind, url: 'https://media.example.com/late.png' }] }));
    const run = initialService.start({ boardId: 'welcome', expectedRevision: 0, operationId: randomUUID(), nodeId: 'frame' }); await initialService.settled(run.id);
    let writes = 0;
    const lateWriter: typeof atomicWrite = (file, value) => { atomicWrite(file, value); writes++; if (writes >= 2) throw new Error('fixture directory fsync failure'); };
    const reconciled = new Store(mediaDir, { write: lateWriter });
    const media = new MediaStore(mediaDir, { ...policy, remoteEnabled: false }, async () => ({ bytes: png, contentType: 'image/png' }));
    const service = new CanvasService(reconciled, { ...policy, remoteEnabled: false }, undefined, media);
    await assert.rejects(service.saveArtifact(run.id, 'frame', 0), /保存失敗/);
    const persisted = reconciled.read().runs.find(value => value.id === run.id)!.results.frame.artifacts[0];
    assert.ok(persisted.localId); const located = media.fileFor(persisted); media.releaseFile(located.fd);
    const restarted = new Store(mediaDir); assert.equal(restarted.read().runs.find(value => value.id === run.id)!.results.frame.artifacts[0].localId, persisted.localId);
  } finally { rmSync(mediaDir, { recursive: true, force: true }); }
});
