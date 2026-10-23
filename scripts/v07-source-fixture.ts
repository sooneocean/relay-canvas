import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApp, serveProduction } from '../server/app.js';
import { Store } from '../server/store.js';
import { CanvasService } from '../server/service.js';
import { MediaStore } from '../server/media.js';
import { generate, type ProviderTransport } from '../server/providers.js';
import { readPolicy } from '../server/security.js';

export const SOURCE_PROVIDER_ORIGIN = 'https://source-relay.fixture.example';
export const SOURCE_MEDIA_ORIGIN = 'https://source-media.fixture.example';
export const SOURCE_IMAGE_MODEL = 'source-images';
export const SOURCE_VIDEO_MODEL = 'source-videos';
export const SOURCE_KEY_ENV = 'RELAY_KEY_V07_FIXTURE';

/** Isolated real app/API/adapters with in-memory fictional provider/media I/O.
 * Only this test process sees a dummy key. No production flags or endpoints. */
export async function createSourceFixture(root: string) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v07-sources-'));
  const previousKey = process.env[SOURCE_KEY_ENV], key = 'v07-fixture-not-a-live-credential';
  process.env[SOURCE_KEY_ENV] = key;
  const payloads = new Map<string, { bytes: Buffer; contentType: string }>();
  const events: { method: string; pathname: string; reference?: string; n?: unknown; responseFormat?: unknown }[] = [];
  const downloads: string[] = [];
  let imagePosts = 0, videoPosts = 0, localReferencePosts = 0;
  const jobs = new Map<string, { output: string; polls: number }>();
  const policy = { remoteEnabled: true, providerOrigins: [...readPolicy({}).providerOrigins, SOURCE_PROVIDER_ORIGIN], mediaOrigins: [SOURCE_MEDIA_ORIGIN] };
  const ffmpeg = (args: string[]) => {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `Source fixture FFmpeg: ${result.stderr}`);
  };
  try {
    const image = (file: string, color: string) => ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=320x180`, '-frames:v', '1', '-threads', '1', path.join(directory, file)]);
    const video = (file: string, color: string, webm = false) => ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=24`, '-t', '3', '-an', '-c:v', webm ? 'libvpx-vp9' : 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', ...(webm ? [] : ['-movflags', '+faststart']), path.join(directory, file)]);
    image('local-green.png', 'green'); image('local-photo.jpg', 'yellow');
    // Real lossless 1x1 purple WebP; no optional system WebP encoder required.
    writeFileSync(path.join(directory, 'local-art.webp'), Buffer.from('UklGRhwAAABXRUJQVlA4TBAAAAAvAAAAAAcQBSxg/wMR0f8A', 'base64'));
    video('local-movie.mp4', 'yellow'); video('local-motion.webm', 'purple', true);
    for (const [index, color] of ['red', 'blue', 'orange', 'cyan'].entries()) image(`generated-${index}.png`, color);
    video('remote-red.mp4', 'red'); video('remote-blue.mp4', 'blue'); video('remote-green.mp4', 'green');
    const files = Object.fromEntries(['local-green.png', 'local-photo.jpg', 'local-art.webp', 'local-movie.mp4', 'local-motion.webm'].map(file => [file, path.join(directory, file)]));
    const localImageBytes = readFileSync(files['local-green.png']);
    const localImageBase64 = localImageBytes.toString('base64');
    const localReference = `data:image/png;base64,${localImageBase64}`;
    for (let index = 0; index < 4; index++) payloads.set(`${SOURCE_MEDIA_ORIGIN}/generated-${index}.png`, { bytes: readFileSync(path.join(directory, `generated-${index}.png`)), contentType: 'image/png' });
    for (const color of ['red', 'blue', 'green']) payloads.set(`${SOURCE_MEDIA_ORIGIN}/remote-${color}.mp4`, { bytes: readFileSync(path.join(directory, `remote-${color}.mp4`)), contentType: 'video/mp4' });
    const store = new Store(directory);
    const fixtureBoard = store.transaction(data => {
      const board = { ...data.boards[0], id: 'source-flow', name: 'Imported + generated creator flow', nodes: [], edges: [] };
      data.boards.push(board);
      data.providers.push({ id: 'source-relay', name: 'Fixture multiple image + video relay', protocol: 'relay', baseUrl: `${SOURCE_PROVIDER_ORIGIN}/v1`, keyEnv: SOURCE_KEY_ENV, imageModel: SOURCE_IMAGE_MODEL, videoModel: SOURCE_VIDEO_MODEL });
      return board;
    });
    let service!: CanvasService;
    const media = new MediaStore(directory, policy, async (url, _policy, signal) => {
      assert.ok(!signal?.aborted);
      const payload = payloads.get(url); assert.ok(payload, 'Unknown source fixture media URL'); downloads.push(url);
      return { bytes: Buffer.from(payload.bytes), contentType: payload.contentType };
    }, root);
    const transport: ProviderTransport = async (url, options) => {
      assert.ok(options.headers.authorization === `Bearer ${key}`, 'Fixture authorization mismatch');
      const parsed = new URL(url); assert.equal(parsed.origin, SOURCE_PROVIDER_ORIGIN); assert.equal(parsed.search, '');
      assert.ok(!options.signal.aborted);
      const body = options.body as Record<string, unknown> | undefined;
      if (options.method === 'POST' && parsed.pathname === '/v1/images/generations') {
        assert.ok(body);
        assert.equal(body?.model, SOURCE_IMAGE_MODEL); assert.equal(body.n, 2); assert.equal(body.response_format, 'b64_json');
        events.push({ method: options.method, pathname: parsed.pathname, n: body.n, responseFormat: body.response_format });
        imagePosts++; assert.ok(imagePosts <= 2, 'Unexpected additional image submission');
        const first = imagePosts - 1, second = first + 2;
        return { data: [{ url: `${SOURCE_MEDIA_ORIGIN}/generated-${first}.png` }, { b64_json: payloads.get(`${SOURCE_MEDIA_ORIGIN}/generated-${second}.png`)!.bytes.toString('base64') }] };
      }
      if (options.method === 'POST' && parsed.pathname === '/v1/videos') {
        assert.ok(body);
        assert.equal(body?.model, SOURCE_VIDEO_MODEL);
        const reference = (body?.input_reference as { image_url?: string } | undefined)?.image_url;
        let color: string;
        if (reference === localReference) { color = 'green'; localReferencePosts++; }
        else {
          assert.ok(reference === `${SOURCE_MEDIA_ORIGIN}/generated-0.png` || reference === `${SOURCE_MEDIA_ORIGIN}/generated-1.png`, 'Exact generated upstream URL reaches video');
          color = reference.endsWith('0.png') ? 'red' : 'blue';
        }
        assert.ok(!String(reference).includes('/api/media/') && !String(reference).includes(key), 'Private local URL and credentials never enter reference');
        videoPosts++; assert.ok(videoPosts <= 3, 'Unexpected additional video submission');
        events.push({ method: options.method, pathname: parsed.pathname, reference: color === 'green' ? 'verified-local-png-data' : 'original-generated-url' });
        const id = `source-video-${videoPosts}`; jobs.set(id, { output: `${SOURCE_MEDIA_ORIGIN}/remote-${color}.mp4`, polls: 0 });
        return { id, status: 'queued' };
      }
      events.push({ method: options.method, pathname: parsed.pathname });
      if (options.method === 'GET' && parsed.pathname === '/v1/models') return { data: [{ id: SOURCE_IMAGE_MODEL }, { id: SOURCE_VIDEO_MODEL }] };
      if (options.method === 'GET' && parsed.pathname.startsWith('/v1/videos/')) {
        const id = parsed.pathname.slice('/v1/videos/'.length), job = jobs.get(id); assert.ok(job);
        assert.ok(store.read().runs.some(run => Object.values(run.results).some(result => result.remoteId === id && result.status === 'running')), 'Remote ID durable before poll');
        return ++job.polls === 1 ? { id, status: 'in_progress' } : { id, status: 'completed', video_url: job.output };
      }
      throw new Error('Unknown source fixture provider method/path');
    };
    service = new CanvasService(store, policy, (provider, request) => generate(provider, request, { policy, env: { [SOURCE_KEY_ENV]: key }, transport, pollIntervalMs: 0 }), media);
    const models = service.models.bind(service); service.models = id => models(id, { [SOURCE_KEY_ENV]: key }, transport);
    const probe = net.createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as net.AddressInfo).port; await new Promise<void>(resolve => probe.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`, token = randomBytes(32).toString('hex');
    const { app } = createApp(service, origin, token); serveProduction(app, root);
    const server = app.listen(port, '127.0.0.1'); await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    writeFileSync(path.join(directory, 'session.json'), JSON.stringify({ origin, token, pid: process.pid }), { mode: 0o600 });
    async function api<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
      assert.ok(endpoint.startsWith('/api/'));
      const response = await fetch(`${origin}${endpoint}`, { method, headers: { Origin: origin, 'X-Canvas-Token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.ok(response.ok, `${method} ${endpoint}: ${response.status}`); return response.json() as Promise<T>;
    }
    return { directory, origin, token, fixtureBoard, files, payloads, events, downloads, store, service, api,
      submissions: () => ({ images: imagePosts, videos: videoPosts, localReferences: localReferencePosts }),
      assertNoLeaks: (value: unknown) => { const text = JSON.stringify(value); for (const privateValue of [key, token, directory, localImageBase64]) assert.ok(!text.includes(privateValue), 'Fixture private bytes/path/credential leaked'); },
      fileHash: (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex'),
      close: async () => {
        for (const run of store.read().runs) if (['pending', 'running', 'submitting'].includes(run.status)) service.cancel(run.id);
        await Promise.all(store.read().runs.map(run => service.settled(run.id)));
        for (const job of store.read().exports ?? []) if (job.status === 'pending' || job.status === 'running') await service.cancelExport(job.id);
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
        if (previousKey === undefined) delete process.env[SOURCE_KEY_ENV]; else process.env[SOURCE_KEY_ENV] = previousKey;
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (previousKey === undefined) delete process.env[SOURCE_KEY_ENV]; else process.env[SOURCE_KEY_ENV] = previousKey;
    rmSync(directory, { recursive: true, force: true }); throw error;
  }
}
