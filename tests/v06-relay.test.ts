import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MediaStore } from '../server/media.js';
import { generate, providerDiagnostics, providerModels, type ProviderTransport } from '../server/providers.js';
import { CanvasService } from '../server/service.js';
import { Store } from '../server/store.js';
import { providerCapabilities, providerSupportsKind } from '../src/shared/provider-capabilities.js';
import { parseProviders } from '../src/shared/schema.js';
import { starterBoard } from '../src/shared/defaults.js';
import type { Artifact, GenerationOutput, GenerationRequest, Provider, Run, StoreData } from '../src/shared/types.js';

const policy = {
  remoteEnabled: true,
  providerOrigins: ['https://api.example.com'],
  mediaOrigins: ['https://media.example.com'],
};
const env = { RELAY_KEY_TEST: 'fixture-secret' };
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(8)]);

function provider(protocol: Provider['protocol'], overrides: Partial<Provider> = {}): Provider {
  return {
    id: `p-${protocol}`,
    name: `Provider ${protocol}`,
    protocol,
    baseUrl: protocol === 'demo' ? '' : 'https://api.example.com/v1',
    keyEnv: protocol === 'demo' ? '' : 'RELAY_KEY_TEST',
    imageModel: 'image-model',
    videoModel: 'video-model',
    ...overrides,
  };
}

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    kind: 'image', model: 'image-model', prompt: 'safe prompt', params: {}, referenceField: 'image_url',
    signal: new AbortController().signal, onSubmitted: () => undefined, ...overrides,
  };
}

function withRelayBoard(store: Store): void {
  store.transaction(data => {
    data.providers = [provider('relay')];
    const board = data.boards[0];
    for (const node of board.nodes) {
      if (node.data.kind === 'image') Object.assign(node.data, { providerId: 'p-relay', model: 'image-model', params: {} });
      if (node.data.kind === 'video') Object.assign(node.data, { providerId: 'p-relay', model: 'video-model', params: {}, referenceField: 'image_url' });
    }
  });
}

function completedRun(store: Store, id: string, url: string): Run {
  const board = store.read().boards[0];
  const run: Run = {
    id, boardId: board.id, revision: board.revision, operationId: `${id}-operation`, status: 'succeeded',
    startedAt: '2026-10-23T00:00:00.000Z', finishedAt: '2026-10-23T00:00:01.000Z', snapshot: board,
    providers: store.read().providers, order: ['frame'],
    results: { frame: { nodeId: 'frame', status: 'succeeded', artifacts: [{ kind: 'image', url }] } },
  };
  store.transaction(data => { data.runs.push(run); });
  return run;
}

test('relay is an additive current protocol with one shared capability contract', () => {
  assert.deepEqual(providerCapabilities('openai'), ['image']);
  assert.deepEqual(providerCapabilities('videos'), ['video']);
  assert.deepEqual(providerCapabilities('relay'), ['image', 'video']);
  assert.equal(providerSupportsKind('relay', 'image'), true);
  assert.equal(providerSupportsKind('relay', 'video'), true);
  assert.equal(providerSupportsKind('videos', 'image'), false);
  assert.equal(parseProviders([provider('relay')])[0].protocol, 'relay');
  for (const protocol of ['demo', 'openai', 'videos', 'fal', 'replicate'] as const) {
    assert.equal(parseProviders([provider(protocol)])[0].protocol, protocol);
  }
  assert.throws(() => parseProviders([{ ...provider('relay'), protocol: 'openai-compatible' }]));
  assert.throws(() => parseProviders([{ ...provider('relay'), arbitraryPath: '/unsafe' }]));
  const diagnostics = providerDiagnostics([provider('relay')], policy, env);
  assert.deepEqual(diagnostics[0].capabilities, ['image', 'video']);
  assert.doesNotMatch(JSON.stringify(diagnostics), /fixture-secret/);
});

test('current stores reload relay while existing protocol stores retain their grammar', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v06-store-'));
  try {
    const board = starterBoard('stored', 'Stored');
    const value: StoreData = {
      schemaVersion: 1, boards: [board],
      providers: [provider('demo'), provider('openai'), provider('videos'), provider('relay'), provider('fal'), provider('replicate')],
      runs: [],
    };
    writeFileSync(path.join(directory, 'workspace.json'), JSON.stringify(value), { mode: 0o600 });
    const reopened = new Store(directory);
    assert.deepEqual(reopened.read().providers.map(entry => entry.protocol), ['demo', 'openai', 'videos', 'relay', 'fal', 'replicate']);
    assert.equal(JSON.parse(readFileSync(reopened.file, 'utf8')).providers[3].protocol, 'relay');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('relay delegates image and video to fixed existing contracts with exact auth, bodies, refs and durable IDs', async () => {
  const imageCalls: Array<{ url: string; method: string; authorization?: string; body: unknown }> = [];
  const image = await generate(provider('relay'), request({
    params: { prompt: 'attacker', model: 'attacker', quality: 'high', output_format: 'png' },
  }), { policy, env, transport: async (url, options) => {
    imageCalls.push({ url, method: options.method, authorization: options.headers.authorization, body: options.body });
    return { data: [{ url: 'https://media.example.com/image.png' }] };
  } });
  assert.deepEqual(imageCalls, [{
    url: 'https://api.example.com/v1/images/generations', method: 'POST', authorization: 'Bearer fixture-secret',
    body: { quality: 'high', output_format: 'png', model: 'image-model', prompt: 'safe prompt', n: 1 },
  }]);
  assert.equal(image.artifacts[0].url, 'https://media.example.com/image.png');

  const events: string[] = [];
  const responses: unknown[] = [
    { id: 'video_42', status: 'queued' },
    { id: 'video_42', status: 'in_progress' },
    { id: 'video_42', status: 'completed', video_url: 'https://media.example.com/video.mp4' },
  ];
  const video = await generate(provider('relay'), request({
    kind: 'video', model: 'video-model', params: { seconds: '8', size: '1280x720' },
    referenceUrl: 'https://media.example.com/image.png', referenceField: 'ignored_but_safe',
    onSubmitted: async id => { events.push(`saved:${id}`); await Promise.resolve(); },
  }), { policy, env, pollIntervalMs: 0, maxPolls: 3, transport: async (url, options) => {
    events.push(`${options.method}:${url}:${options.headers.authorization}:${JSON.stringify(options.body)}`);
    return responses.shift();
  } });
  assert.equal(video.remoteId, 'video_42');
  assert.deepEqual(events, [
    'POST:https://api.example.com/v1/videos:Bearer fixture-secret:{"model":"video-model","prompt":"safe prompt","seconds":"8","size":"1280x720","input_reference":{"image_url":"https://media.example.com/image.png"}}',
    'saved:video_42',
    'GET:https://api.example.com/v1/videos/video_42:Bearer fixture-secret:undefined',
    'GET:https://api.example.com/v1/videos/video_42:Bearer fixture-secret:undefined',
  ]);
  assert.equal(video.artifacts[0].url, 'https://media.example.com/video.mp4');
});

test('one relay profile carries the canonical image URL into video and persists the remote ID before polling', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v06-sequence-'));
  const previousKey = process.env.RELAY_KEY_TEST;
  process.env.RELAY_KEY_TEST = env.RELAY_KEY_TEST;
  try {
    const store = new Store(directory); withRelayBoard(store);
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let service!: CanvasService;
    const transport: ProviderTransport = async (url, options) => {
      calls.push({ url, method: options.method, body: options.body });
      if (url.endsWith('/images/generations')) return { data: [{ url: 'https://media.example.com/canonical.png' }] };
      if (url.endsWith('/videos')) return { id: 'durable_video_1', status: 'queued' };
      if (url.endsWith('/videos/durable_video_1')) {
        const running = store.read().runs[0];
        assert.equal(running.results.motion.remoteId, 'durable_video_1');
        assert.equal(running.results.motion.status, 'running');
        return { id: 'durable_video_1', status: 'completed', url: 'https://media.example.com/final.mp4' };
      }
      throw new Error('unexpected fixture URL');
    };
    service = new CanvasService(store, policy, (relayProvider, generation) => generate(relayProvider, generation, {
      policy, env, transport, pollIntervalMs: 0, maxPolls: 2,
    }));
    const started = service.start({ boardId: 'welcome', expectedRevision: 0, operationId: randomUUID(), nodeId: 'motion', confirmExternal: true });
    const complete = await service.settled(started.id);
    assert.equal(complete.status, 'succeeded');
    assert.equal(complete.results.motion.referenceUrl, 'https://media.example.com/canonical.png');
    assert.equal(complete.results.motion.remoteId, 'durable_video_1');
    assert.deepEqual(calls, [
      {
        url: 'https://api.example.com/v1/images/generations', method: 'POST',
        body: { model: 'image-model', prompt: '一座安靜的沙漠建築，溫暖晨光穿過拱門，細緻的沙色石材，電影感構圖。\n柔和陰影，極簡，35mm。', n: 1 },
      },
      {
        url: 'https://api.example.com/v1/videos', method: 'POST',
        body: { model: 'video-model', prompt: '鏡頭緩慢向前，光線微微流動。', input_reference: { image_url: 'https://media.example.com/canonical.png' } },
      },
      { url: 'https://api.example.com/v1/videos/durable_video_1', method: 'GET', body: undefined },
    ]);
  } finally {
    if (previousKey === undefined) delete process.env.RELAY_KEY_TEST; else process.env.RELAY_KEY_TEST = previousKey;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('relay reuses the fixed models contract and rejects unsupported params and references before transport', async () => {
  const modelCalls: string[] = [];
  const models = await providerModels(provider('relay'), { policy, env, transport: async (url, options) => {
    modelCalls.push(`${options.method}:${url}:${options.headers.authorization}`);
    return { data: [{ id: 'image-model' }, { id: 'video-model' }, { id: 'image-model' }] };
  } });
  assert.deepEqual(modelCalls, ['GET:https://api.example.com/v1/models:Bearer fixture-secret']);
  assert.deepEqual(models, { models: ['image-model', 'video-model'] });

  const invalid = [
    request({ params: { output_format: 'gif' } }),
    request({ kind: 'video', model: 'video-model', params: { seconds: 8 } }),
    request({ kind: 'video', model: 'video-model', params: { extra: true } }),
  ];
  for (const generation of invalid) {
    let calls = 0;
    await assert.rejects(generate(provider('relay'), generation, { policy, env, transport: async () => { calls += 1; return {}; } }));
    assert.equal(calls, 0);
  }
  let referenceCalls = 0;
  await assert.rejects(generate(provider('relay'), request({
    kind: 'video', model: 'video-model', referenceUrl: '/demo-motion.mp4',
  }), { policy, env, transport: async () => { referenceCalls += 1; return {}; } }));
  assert.equal(referenceCalls, 0);
});

test('old capability mismatches and relay preflight errors create no run and call no generator', () => {
  const previousKey = process.env.RELAY_KEY_TEST;
  process.env.RELAY_KEY_TEST = env.RELAY_KEY_TEST;
  try {
    for (const [protocol, nodeId] of [['videos', 'frame'], ['openai', 'motion']] as const) {
      const directory = mkdtempSync(path.join(os.tmpdir(), `relay-v06-${protocol}-`));
      try {
        const store = new Store(directory); let calls = 0;
        store.transaction(data => {
          data.providers = [provider(protocol)];
          const node = data.boards[0].nodes.find(entry => entry.id === nodeId)!;
          node.data.providerId = `p-${protocol}`;
          node.data.model = node.data.kind === 'image' ? 'image-model' : 'video-model';
        });
        const service = new CanvasService(store, policy, async () => { calls += 1; return { artifacts: [] }; });
        assert.throws(() => service.start({ boardId: 'welcome', expectedRevision: 0, operationId: randomUUID(), nodeId, confirmExternal: true }), /不支援/);
        assert.equal(calls, 0); assert.equal(store.read().runs.length, 0);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }

    for (const [nodeId, params] of [['frame', { output_format: 'gif' }], ['motion', { seconds: 8 }]] as const) {
      const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v06-preflight-'));
      try {
        const store = new Store(directory); withRelayBoard(store); let calls = 0;
        store.transaction(data => { data.boards[0].nodes.find(node => node.id === nodeId)!.data.params = params; });
        const service = new CanvasService(store, policy, async () => { calls += 1; return { artifacts: [] }; });
        assert.throws(() => service.start({ boardId: 'welcome', expectedRevision: 0, operationId: randomUUID(), nodeId, confirmExternal: true }));
        assert.equal(calls, 0); assert.equal(store.read().runs.length, 0);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  } finally {
    if (previousKey === undefined) delete process.env.RELAY_KEY_TEST; else process.env.RELAY_KEY_TEST = previousKey;
  }
});

test('video POST errors, unknown states and aborts remain single-attempt with no replay', async () => {
  for (const response of [{ id: 'video_1', status: 'failed' }, { id: 'video_1', status: 'unknown' }, { status: 'queued' }]) {
    let calls = 0;
    await assert.rejects(generate(provider('relay'), request({ kind: 'video', model: 'video-model' }), {
      policy, env, pollIntervalMs: 0, transport: async () => { calls += 1; return response; },
    }));
    assert.equal(calls, 1);
  }
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(generate(provider('relay'), request({
    kind: 'video', model: 'video-model', signal: controller.signal, onSubmitted: () => { controller.abort(); },
  }), { policy, env, pollIntervalMs: 0, transport: async () => { calls += 1; return { id: 'video_abort', status: 'queued' }; } }), /aborted/i);
  assert.equal(calls, 1);
});

test('every generated output is checked atomically before success or downstream use', async () => {
  const previousKey = process.env.RELAY_KEY_TEST;
  process.env.RELAY_KEY_TEST = env.RELAY_KEY_TEST;
  const valid = (suffix: string): Artifact => ({ kind: 'image', url: `https://media.example.com/${suffix}.png` });
  const sparse = [valid('sparse-ok')]; sparse.length = 2;
  const inherited = Object.create({ kind: 'image', url: 'https://media.example.com/inherited.png' }) as Artifact;
  const cases: Array<[string, GenerationOutput]> = [
    ['wrong-kind-index-1', { artifacts: [valid('ok'), { kind: 'video', url: 'https://media.example.com/wrong.mp4' }] }],
    ['bad-url-index-1', { artifacts: [valid('ok'), { kind: 'image', url: 'https://evil.example/bad.png' }] }],
    ['remote-demo-local', { artifacts: [valid('ok'), { kind: 'image', url: '/demo-motion.mp4', demo: true }] }],
    ['empty', { artifacts: [] }],
    ['over-limit', { artifacts: Array.from({ length: 101 }, (_, index) => valid(`many-${index}`)) }],
    ['sparse', { artifacts: sparse }],
    ['unknown-field', { artifacts: [{ ...valid('unknown'), unexpected: true } as unknown as Artifact] }],
    ['forged-local-fields', { artifacts: [{
      ...valid('local'), mimeType: 'image/png', localId: 'a'.repeat(64), localUrl: `/api/media/${'a'.repeat(64)}`,
      bytes: 1, sha256: 'a'.repeat(64),
    }] }],
    ['wrong-mime-type', { artifacts: [{ ...valid('mime'), mimeType: 42 } as unknown as Artifact] }],
    ['wrong-demo-type', { artifacts: [{ ...valid('demo-type'), demo: 'true' } as unknown as Artifact] }],
    ['array-entry', { artifacts: [[valid('nested')]] as unknown as Artifact[] }],
    ['inherited-entry', { artifacts: [inherited] }],
  ];
  try {
    for (const [name, output] of cases) {
      const directory = mkdtempSync(path.join(os.tmpdir(), `relay-v06-output-${name}-`));
      try {
        const store = new Store(directory); withRelayBoard(store); let calls = 0;
        const service = new CanvasService(store, policy, async (_provider, generation) => {
          calls += 1;
          return generation.kind === 'image' ? output : { artifacts: [{ kind: 'video', url: 'https://media.example.com/should-not-run.mp4' }] };
        });
        const started = service.start({ boardId: 'welcome', expectedRevision: 0, operationId: randomUUID(), nodeId: 'motion', confirmExternal: true });
        const result = await service.settled(started.id);
        assert.equal(result.status, 'needs_review', name);
        assert.equal(result.results.frame.status, 'needs_review', name);
        assert.deepEqual(result.results.frame.artifacts, [], name);
        assert.equal(result.results.motion.status, 'cancelled', name);
        assert.equal(calls, 1, name);
        const reopened = new Store(directory);
        assert.equal(reopened.read().runs[0].status, 'needs_review', name);
        assert.deepEqual(reopened.read().runs[0].results.frame.artifacts, [], name);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  } finally {
    if (previousKey === undefined) delete process.env.RELAY_KEY_TEST; else process.env.RELAY_KEY_TEST = previousKey;
  }
});

test('exactly 100 strict artifacts commit atomically and permit downstream execution', async () => {
  const previousKey = process.env.RELAY_KEY_TEST;
  process.env.RELAY_KEY_TEST = env.RELAY_KEY_TEST;
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v06-output-100-'));
  try {
    const store = new Store(directory); withRelayBoard(store); let calls = 0;
    const service = new CanvasService(store, policy, async (_provider, generation) => {
      calls += 1;
      if (generation.kind === 'image') {
        return { artifacts: Array.from({ length: 100 }, (_, index): Artifact => ({
          kind: 'image', url: `https://media.example.com/exact-${index}.png`, mimeType: 'image/png', demo: false,
        })) };
      }
      return { artifacts: [{ kind: 'video', url: 'https://media.example.com/exact.mp4', mimeType: 'video/mp4', demo: false }] };
    });
    const started = service.start({ boardId: 'welcome', expectedRevision: 0, operationId: randomUUID(), nodeId: 'motion', confirmExternal: true });
    const result = await service.settled(started.id);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.results.frame.artifacts.length, 100);
    assert.deepEqual(result.results.frame.artifacts[99], {
      kind: 'image', url: 'https://media.example.com/exact-99.png', mimeType: 'image/png', demo: false,
    });
    assert.equal(result.results.motion.status, 'succeeded');
    assert.equal(result.results.motion.referenceUrl, 'https://media.example.com/exact-0.png');
    assert.equal(calls, 2);
    const reopened = new Store(directory);
    assert.equal(reopened.read().runs[0].results.frame.artifacts.length, 100);
    assert.equal(reopened.read().runs[0].status, 'succeeded');
  } finally {
    if (previousKey === undefined) delete process.env.RELAY_KEY_TEST; else process.env.RELAY_KEY_TEST = previousKey;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('artifact save CAS rejects held-fetch source drift, removes the orphan and preserves referenced media', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v06-save-cas-'));
  let release!: () => void;
  let started!: () => void;
  const fetchStarted = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const changedPng = Buffer.concat([png, Buffer.from([1])]);
  try {
    const store = new Store(directory);
    completedRun(store, 'keep-run', 'https://media.example.com/keep.png');
    completedRun(store, 'drift-run', 'https://media.example.com/drift.png');
    const media = new MediaStore(directory, policy, async url => {
      if (url.endsWith('/keep.png')) return { bytes: png, contentType: 'image/png' };
      if (url.endsWith('/drift.png')) { started(); await held; return { bytes: changedPng, contentType: 'image/png' }; }
      throw new Error('unexpected fixture URL');
    });
    const service = new CanvasService(store, policy, undefined, media);
    const kept = await service.saveArtifact('keep-run', 'frame', 0);
    assert.ok(kept.localId);
    const keptFile = path.join(media.directory, `${kept.localId}.png`);
    assert.equal(existsSync(keptFile), true);

    const saving = service.saveArtifact('drift-run', 'frame', 0);
    await fetchStarted;
    store.transaction(data => {
      data.runs.find(run => run.id === 'drift-run')!.results.frame.artifacts[0] = {
        kind: 'image', url: 'https://media.example.com/replacement.png',
      };
    });
    release();
    await assert.rejects(saving, (error: unknown) => {
      return error instanceof Error && 'code' in error && error.code === 'REVISION_CONFLICT' && 'status' in error && error.status === 409;
    });
    const orphanHash = createHash('sha256').update(changedPng).digest('hex');
    assert.equal(existsSync(path.join(media.directory, `${orphanHash}.png`)), false);
    assert.equal(existsSync(keptFile), true);
    const current = store.read().runs.find(run => run.id === 'drift-run')!.results.frame.artifacts[0];
    assert.deepEqual(current, { kind: 'image', url: 'https://media.example.com/replacement.png' });
    const reopened = new Store(directory);
    assert.equal(reopened.read().runs.find(run => run.id === 'keep-run')!.results.frame.artifacts[0].localId, kept.localId);
    assert.deepEqual(reopened.read().runs.find(run => run.id === 'drift-run')!.results.frame.artifacts[0], current);
  } finally { release?.(); rmSync(directory, { recursive: true, force: true }); }
});

test('artifact save revalidates the canonical source when queued work begins', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-v06-save-queue-'));
  let release!: () => void;
  let started!: () => void;
  const fetchStarted = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const fetched: string[] = [];
  try {
    const store = new Store(directory);
    completedRun(store, 'block-run', 'https://media.example.com/block.png');
    completedRun(store, 'queue-run', 'https://media.example.com/queue.png');
    const media = new MediaStore(directory, policy, async url => {
      fetched.push(url);
      if (url.endsWith('/block.png')) { started(); await held; return { bytes: png, contentType: 'image/png' }; }
      return { bytes: png, contentType: 'image/png' };
    });
    const service = new CanvasService(store, policy, undefined, media);
    const blocker = service.saveArtifact('block-run', 'frame', 0);
    await fetchStarted;
    const queued = service.saveArtifact('queue-run', 'frame', 0);
    store.transaction(data => {
      data.runs.find(run => run.id === 'queue-run')!.results.frame.artifacts[0].url = 'https://media.example.com/replacement.png';
    });
    release(); await blocker;
    await assert.rejects(queued, (error: unknown) => error instanceof Error && 'code' in error && error.code === 'REVISION_CONFLICT');
    assert.deepEqual(fetched, ['https://media.example.com/block.png']);
  } finally { release?.(); rmSync(directory, { recursive: true, force: true }); }
});

