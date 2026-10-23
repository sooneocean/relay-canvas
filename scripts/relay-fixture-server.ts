import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApp, serveProduction } from '../server/app.js';
import { Store } from '../server/store.js';
import { CanvasService } from '../server/service.js';
import { MediaStore } from '../server/media.js';
import { generate, type ProviderTransport } from '../server/providers.js';
import { readPolicy } from '../server/security.js';

export const RELAY_FIXTURE_BASE = 'https://relay.fixture.example/v1';
export const RELAY_FIXTURE_MEDIA = 'https://media.fixture.example';
export const RELAY_FIXTURE_KEY_ENV = 'RELAY_KEY_V06_FIXTURE';
export const RELAY_FIXTURE_IMAGE_MODEL = 'relay-image-fixture';
export const RELAY_FIXTURE_VIDEO_MODEL = 'relay-video-fixture';

/** Test-only construction. It is never imported by server/main or packaged.
 * All provider/media dependencies terminate in memory; no live requests. */
export async function createRelayFixture(root: string) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v06-flow-'));
  const previousKey = process.env[RELAY_FIXTURE_KEY_ENV];
  const fixtureKey = 'v06-fixture-not-a-live-credential';
  process.env[RELAY_FIXTURE_KEY_ENV] = fixtureKey;
  const payloads = new Map<string, { bytes: Buffer; contentType: string }>();
  const events: { method: string; pathname: string; body?: unknown }[] = [];
  const downloads: string[] = [];
  const jobs = new Map<string, { version: number; polls: number }>();
  let imagePosts = 0; let videoPosts = 0;
  const policy = { remoteEnabled: true, providerOrigins: [...readPolicy({}).providerOrigins, 'https://relay.fixture.example'], mediaOrigins: [RELAY_FIXTURE_MEDIA] };
  const store = new Store(directory);
  const fixtureBoard = store.transaction(state => {
    const board = { ...state.boards[0], id: 'relay-flow', name: 'Relay creator flow', nodes: [], edges: [] };
    state.boards.push(board); return board;
  });
  const command = (args: string[]) => {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `Fixture FFmpeg: ${result.stderr}`);
  };
  try {
    for (const [index, color] of ['red', 'blue'].entries()) {
      const png = path.join(directory, `image-${index + 1}.png`);
      const mp4 = path.join(directory, `video-${index + 1}.mp4`);
      command(['-f', 'lavfi', '-i', `color=c=${color}:s=320x180`, '-frames:v', '1', '-threads', '1', png]);
      command(['-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=24`, '-t', '3', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', '-movflags', '+faststart', mp4]);
      payloads.set(`${RELAY_FIXTURE_MEDIA}/image-${index + 1}.png`, { bytes: readFileSync(png), contentType: 'image/png' });
      payloads.set(`${RELAY_FIXTURE_MEDIA}/video-${index + 1}.mp4`, { bytes: readFileSync(mp4), contentType: 'video/mp4' });
    }
    // A distinct, valid URL used only for live-catalog drift fault injection.
    payloads.set(`${RELAY_FIXTURE_MEDIA}/image-2.png?drift`, payloads.get(`${RELAY_FIXTURE_MEDIA}/image-2.png`)!);
    const media = new MediaStore(directory, policy, async (url, _policy, signal) => {
      if (signal?.aborted) throw new Error('Fixture media aborted');
      const payload = payloads.get(url);
      if (!payload) throw new Error('Unknown fixture media URL');
      downloads.push(url);
      return { bytes: Buffer.from(payload.bytes), contentType: payload.contentType };
    }, root);
    let service!: CanvasService;
    const transport: ProviderTransport = async (url, options) => {
      assert.ok(options.headers.authorization === `Bearer ${fixtureKey}`, 'Fixture credential contract mismatch');
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://relay.fixture.example');
      assert.equal(parsed.search, '');
      events.push({ method: options.method, pathname: parsed.pathname, body: structuredClone(options.body) });
      if (options.signal.aborted) throw new Error('Fixture provider aborted');
      if (options.method === 'GET' && parsed.pathname === '/v1/models') return { data: [{ id: RELAY_FIXTURE_IMAGE_MODEL }, { id: RELAY_FIXTURE_VIDEO_MODEL }] };
      const body = options.body as Record<string, unknown> | undefined;
      if (options.method === 'POST' && parsed.pathname === '/v1/images/generations') {
        assert.equal(body?.model, RELAY_FIXTURE_IMAGE_MODEL);
        assert.equal(body?.n, 1);
        assert.equal(typeof body?.prompt, 'string');
        imagePosts++; assert.ok(imagePosts <= 2, 'Unexpected extra image submission');
        return { data: [{ url: `${RELAY_FIXTURE_MEDIA}/image-${imagePosts}.png` }] };
      }
      if (options.method === 'POST' && parsed.pathname === '/v1/videos') {
        assert.equal(body?.model, RELAY_FIXTURE_VIDEO_MODEL);
        const reference = (body?.input_reference as { image_url?: string } | undefined)?.image_url;
        assert.equal(reference, `${RELAY_FIXTURE_MEDIA}/image-${imagePosts}.png`, 'Original upstream image URL reaches video');
        assert.ok(!String(reference).includes('/api/media/'));
        videoPosts++; assert.ok(videoPosts <= 2, 'Unexpected extra video submission');
        const id = `fixture-video-${videoPosts}`; jobs.set(id, { version: imagePosts, polls: 0 });
        return { id, status: 'queued' };
      }
      if (options.method === 'GET' && parsed.pathname.startsWith('/v1/videos/')) {
        const id = parsed.pathname.slice('/v1/videos/'.length), job = jobs.get(id);
        assert.ok(job, 'Unknown fixture job');
        const persisted = store.read().runs.flatMap(run => Object.values(run.results)).find(result => result.remoteId === id);
        assert.ok(persisted && persisted.status === 'running', 'Remote ID is durable before every poll');
        job.polls++;
        return job.polls === 1 ? { id, status: 'in_progress' } : { id, status: 'completed', video_url: `${RELAY_FIXTURE_MEDIA}/video-${job.version}.mp4` };
      }
      throw new Error('Unknown fixture provider method/path');
    };
    service = new CanvasService(store, policy, (provider, request) => generate(provider, request, { policy, env: { [RELAY_FIXTURE_KEY_ENV]: fixtureKey }, transport, pollIntervalMs: 0 }), media);
    // Instance-only binding through the existing method parameters. The real
    // authenticated route and providerModels fixed /models parser still run.
    const models = service.models.bind(service);
    service.models = id => models(id, { [RELAY_FIXTURE_KEY_ENV]: fixtureKey }, transport);
    const probe = net.createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`, token = randomBytes(32).toString('hex');
    const { app } = createApp(service, origin, token); serveProduction(app, root);
    const server = app.listen(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    async function api<T>(endpoint: string, method = 'GET', body?: unknown): Promise<T> {
      assert.ok(endpoint.startsWith('/api/'));
      const response = await fetch(`${origin}${endpoint}`, { method, headers: { Origin: origin, 'X-Canvas-Token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      assert.ok(response.ok, `${method} ${endpoint}: ${response.status}`);
      return response.json() as Promise<T>;
    }
    return { origin, token, directory, service, store, fixtureBoard, events, downloads, payloads, api,
      submissions: () => ({ image: imagePosts, video: videoPosts }),
      assertNoSecret: (value: unknown) => assert.ok(!JSON.stringify(value).includes(fixtureKey), 'Fixture credential must stay out of output/state'),
      close: async () => {
        for (const run of store.read().runs) if (['pending', 'running', 'submitting'].includes(run.status)) service.cancel(run.id);
        await Promise.all(store.read().runs.map(run => service.settled(run.id)));
        for (const job of store.read().exports ?? []) if (job.status === 'pending' || job.status === 'running') await service.cancelExport(job.id);
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
        if (previousKey === undefined) delete process.env[RELAY_FIXTURE_KEY_ENV]; else process.env[RELAY_FIXTURE_KEY_ENV] = previousKey;
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (previousKey === undefined) delete process.env[RELAY_FIXTURE_KEY_ENV]; else process.env[RELAY_FIXTURE_KEY_ENV] = previousKey;
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
