import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, preflightGeneration, type ProviderTransport } from '../server/providers.js';
import type { GenerationRequest, Provider } from '../src/shared/types.js';

const policy = {
  remoteEnabled: true,
  providerOrigins: ['https://api.example.com', 'https://queue.example.com'],
  mediaOrigins: ['https://media.example.com'],
};
const env = { RELAY_KEY_TEST: 'test-secret-value' };

function provider(protocol: Provider['protocol'], baseUrl = 'https://api.example.com/v1'): Provider {
  return {
    id: `v07-${protocol}`,
    name: `v0.7 ${protocol}`,
    protocol,
    baseUrl,
    keyEnv: 'RELAY_KEY_TEST',
    imageModel: 'owner/image-model',
    videoModel: 'owner/video-model',
  };
}

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    kind: 'image',
    model: 'owner/model',
    prompt: 'safe prompt',
    params: {},
    referenceField: 'image_url',
    signal: new AbortController().signal,
    onSubmitted: () => undefined,
    ...overrides,
  };
}

async function openAiOutput(
  data: unknown[],
  overrides: Partial<GenerationRequest> = {},
  protocol: 'openai' | 'relay' = 'openai',
) {
  return await generate(provider(protocol), request({ model: 'gpt-image-1', ...overrides }), {
    policy,
    env,
    transport: async () => ({ data }),
  });
}

async function falOutput(images: unknown[]) {
  const responses = [
    { request_id: 'fal_v07', status_url: 'https://queue.example.com/status/fal_v07' },
    { status: 'COMPLETED', images },
  ];
  return await generate(provider('fal', 'https://queue.example.com'), request({ model: 'fal-ai/flux/schnell' }), {
    policy,
    env,
    pollIntervalMs: 0,
    maxPolls: 1,
    transport: async () => responses.shift(),
  });
}

async function replicateOutput(output: unknown) {
  const responses = [
    { id: 'pred_v07' },
    { status: 'succeeded', output },
  ];
  return await generate(provider('replicate'), request({ model: 'owner/model' }), {
    policy,
    env,
    pollIntervalMs: 0,
    maxPolls: 1,
    transport: async () => responses.shift(),
  });
}

for (const protocol of ['openai', 'relay'] as const) {
  test(`${protocol} images preserve ordered URL, base64 fallback, and data URL outputs`, async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const transport: ProviderTransport = async (url, options) => {
      calls.push({ url, body: options.body });
      return {
        data: [
          { url: 'https://media.example.com/first.png', b64_json: 'aGlkZGVu' },
          { b64_json: 'c2Vjb25k' },
          { url: 'data:image/webp;base64,dGhpcmQ=' },
        ],
      };
    };
    const output = await generate(provider(protocol), request({
      model: 'gpt-image-1',
      params: { n: 3, response_format: 'url', output_format: 'webp', quality: 'high' },
    }), { policy, env, transport });

    assert.deepEqual(calls, [{
      url: 'https://api.example.com/v1/images/generations',
      body: {
        n: 3,
        response_format: 'url',
        output_format: 'webp',
        quality: 'high',
        model: 'gpt-image-1',
        prompt: 'safe prompt',
      },
    }]);
    assert.deepEqual(output.artifacts, [
      { kind: 'image', url: 'https://media.example.com/first.png' },
      { kind: 'image', url: 'data:image/webp;base64,c2Vjb25k' },
      { kind: 'image', url: 'data:image/webp;base64,dGhpcmQ=' },
    ]);
  });

  test(`${protocol} defaults image count to one`, async () => {
    let body: unknown;
    await generate(provider(protocol), request({ model: 'gpt-image-1' }), {
      policy,
      env,
      transport: async (_url, options) => {
        body = options.body;
        return { data: [{ url: 'https://media.example.com/only.png' }] };
      },
    });
    assert.deepEqual(body, { model: 'gpt-image-1', prompt: 'safe prompt', n: 1 });
  });
}

test('OpenAI-compatible image params reject invalid n and response_format before POST', async () => {
  const invalidParams = [
    { n: 0 },
    { n: 5 },
    { n: 9 },
    { n: 99 },
    { n: 1.5 },
    { n: '2' },
    { response_format: 'data-url' },
    { response_format: null },
  ];
  for (const protocol of ['openai', 'relay'] as const) {
    for (const params of invalidParams) {
      assert.throws(() => preflightGeneration(provider(protocol), {
        kind: 'image', model: 'gpt-image-1', params, referenceField: 'image_url',
      }, { policy, env }), /Invalid provider configuration/);
      let calls = 0;
      await assert.rejects(generate(provider(protocol), request({ model: 'gpt-image-1', params }), {
        policy,
        env,
        transport: async () => { calls += 1; return {}; },
      }), /Invalid provider configuration/);
      assert.equal(calls, 0, `${protocol} ${JSON.stringify(params)}`);
    }
  }
});

test('OpenAI-compatible arrays reject invalid later, empty, sparse, and 101-entry responses atomically', async () => {
  const sparse = new Array(2);
  sparse[0] = { url: 'https://media.example.com/first.png' };
  const invalid = [
    [],
    [
      { url: 'https://media.example.com/first.png' },
      { url: '', b64_json: 'dmFsaWQtZmFsbGJhY2s=' },
    ],
    [
      { url: 'https://media.example.com/first.png' },
      { url: 'https://media.example.com/second.png', b64_json: '***' },
    ],
    sparse,
    Array.from({ length: 101 }, (_, index) => ({ url: `https://media.example.com/${index}.png` })),
  ];
  for (const data of invalid) {
    await assert.rejects(openAiOutput(data));
  }
});

test('all multi-output adapters accept the exact 100-entry boundary in order', async () => {
  const urls = Array.from({ length: 100 }, (_, index) => `https://media.example.com/${index}.png`);
  const openAi = await openAiOutput(urls.map((url) => ({ url })));
  const fal = await falOutput(urls.map((url) => ({ url })));
  const replicate = await replicateOutput(urls);
  for (const output of [openAi, fal, replicate]) {
    assert.equal(output.artifacts.length, 100);
    assert.equal(output.artifacts[0].url, urls[0]);
    assert.equal(output.artifacts[99].url, urls[99]);
  }
});

test('OpenAI-compatible arrays enforce aggregate base64 across hidden fields and data URLs', async () => {
  const limit = 6 * 1024 * 1024;
  await assert.rejects(openAiOutput([
    {
      url: 'https://media.example.com/visible.png',
      b64_json: 'A'.repeat(limit + 4),
    },
  ]));

  const half = 'A'.repeat(limit / 2);
  await assert.rejects(openAiOutput([
    { url: 'https://media.example.com/first.png', b64_json: half },
    { url: 'https://media.example.com/second.png', b64_json: `${half}AAAA` },
  ]));
  await assert.rejects(openAiOutput([
    { url: `data:image/png;base64,${half}` },
    { url: `data:image/png;base64,${half}AAAA` },
  ]));
});

test('fal image responses preserve every ordered URL and reject arrays atomically', async () => {
  const output = await falOutput([
    { url: 'https://media.example.com/first.png' },
    { url: 'https://media.example.com/second.png' },
    { url: 'data:image/webp;base64,dGhpcmQ=' },
  ]);
  assert.equal(output.remoteId, 'fal_v07');
  assert.deepEqual(output.artifacts, [
    { kind: 'image', url: 'https://media.example.com/first.png' },
    { kind: 'image', url: 'https://media.example.com/second.png' },
    { kind: 'image', url: 'data:image/webp;base64,dGhpcmQ=' },
  ]);

  const sparse = new Array(2);
  sparse[1] = { url: 'https://media.example.com/second.png' };
  for (const images of [
    [],
    [{ url: 'https://media.example.com/first.png' }, { url: '' }],
    sparse,
    Array.from({ length: 101 }, (_, index) => ({ url: `https://media.example.com/${index}.png` })),
  ]) {
    await assert.rejects(falOutput(images));
  }
});

test('Replicate preserves string and every ordered string-array output', async () => {
  const single = await replicateOutput('https://media.example.com/only.png');
  assert.deepEqual(single.artifacts, [{ kind: 'image', url: 'https://media.example.com/only.png' }]);

  const multiple = await replicateOutput([
    'https://media.example.com/first.png',
    'https://media.example.com/second.png',
    'data:image/webp;base64,dGhpcmQ=',
  ]);
  assert.deepEqual(multiple.artifacts, [
    { kind: 'image', url: 'https://media.example.com/first.png' },
    { kind: 'image', url: 'https://media.example.com/second.png' },
    { kind: 'image', url: 'data:image/webp;base64,dGhpcmQ=' },
  ]);
});

test('Replicate rejects empty, invalid later, sparse, and 101-entry arrays atomically', async () => {
  const sparse = new Array(2);
  sparse[0] = 'https://media.example.com/first.png';
  for (const output of [
    [],
    ['https://media.example.com/first.png', 7],
    ['https://media.example.com/first.png', ''],
    sparse,
    Array.from({ length: 101 }, (_, index) => `https://media.example.com/${index}.png`),
  ]) {
    await assert.rejects(replicateOutput(output));
  }
});
