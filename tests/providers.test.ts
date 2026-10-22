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
    id: `test-${protocol}`,
    name: `Test ${protocol}`,
    protocol,
    baseUrl,
    keyEnv: protocol === 'demo' ? '' : 'RELAY_KEY_TEST',
    imageModel: 'owner/image-model',
    videoModel: 'owner/video-model',
  };
}

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    kind: 'image',
    model: 'owner/model',
    prompt: 'safe prompt',
    params: { steps: 4 },
    referenceField: 'image_url',
    signal: new AbortController().signal,
    onSubmitted: () => undefined,
    ...overrides,
  };
}

test('preflight validates every remote generation without making network requests', () => {
  assert.doesNotThrow(() => preflightGeneration(provider('openai'), {
    kind: 'image', model: 'gpt-image-1', params: { quality: 'high' }, referenceField: 'image_url',
  }, { policy, env }));
  assert.doesNotThrow(() => preflightGeneration(provider('fal', 'https://queue.example.com'), {
    kind: 'video', model: 'fal-ai/kling-video/v2.1/standard/image-to-video', params: { duration: 5 }, referenceField: 'start_image_url',
  }, { policy, env }));
  assert.doesNotThrow(() => preflightGeneration(provider('fal', 'https://queue.example.com'), {
    kind: 'image', model: 'fal.ai/model', params: {}, referenceField: 'image_url',
  }, { policy, env }));
  assert.doesNotThrow(() => preflightGeneration(provider('replicate'), {
    kind: 'image', model: 'owner/name', params: {}, referenceField: 'image_url',
  }, { policy, env }));
  assert.throws(() => preflightGeneration(provider('openai'), {
    kind: 'video', model: 'video-model', params: {}, referenceField: 'image_url',
  }, { policy, env }), /capability is not supported/);
  assert.throws(() => preflightGeneration(provider('fal', 'https://queue.example.com'), {
    kind: 'image', model: 'fal-ai/valid', params: { nested: { headers: 'forbidden' } }, referenceField: 'image_url',
  }, { policy, env }), /Invalid provider configuration/);
  assert.throws(() => preflightGeneration(provider('replicate'), {
    kind: 'image', model: 'owner/name/version', params: {}, referenceField: 'image_url',
  }, { policy, env }), /Invalid provider model/);
  assert.throws(() => preflightGeneration({ ...provider('openai'), baseUrl: 'https://evil.example/v1' }, {
    kind: 'image', model: 'gpt-image-1', params: {}, referenceField: 'image_url',
  }, { policy, env }), /origin is not allowed/);
  assert.throws(() => preflightGeneration(provider('openai'), {
    kind: 'image', model: 'gpt-image-1', params: {}, referenceField: 'image_url',
  }, { policy, env: {} }), /credential is unavailable/);
});

test('Demo image is locally generated, escaped and never calls transport', async () => {
  let called = false;
  const output = await generate(provider('demo', ''), request({ prompt: '<script>alert(1)</script>' }), {
    policy: { ...policy, remoteEnabled: false },
    transport: async () => { called = true; throw new Error('unexpected'); },
  });
  assert.equal(called, false);
  assert.equal(output.artifacts[0].demo, true);
  const svg = decodeURIComponent(output.artifacts[0].url.split(',')[1]);
  assert.match(svg, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(svg, /<script>/);
});

test('Demo video returns only the trusted local media path', async () => {
  const output = await generate(provider('demo', ''), request({ kind: 'video', referenceUrl: 'https://media.example.com/input.png' }), {
    policy: { ...policy, remoteEnabled: false },
  });
  assert.deepEqual(output.artifacts, [{ kind: 'video', url: '/demo-motion.mp4', demo: true }]);
});

test('OpenAI-compatible image uses exact path/body and normalizes URL output', async () => {
  const calls: Array<{ url: string; body: unknown; authorization?: string }> = [];
  const transport: ProviderTransport = async (url, options) => {
    calls.push({ url, body: options.body, authorization: options.headers.authorization });
    return { data: [{ url: 'https://media.example.com/result.png' }] };
  };
  const output = await generate(provider('openai'), request({
    model: 'gpt-image-1',
    params: { prompt: 'attacker', model: 'attacker', n: 99, quality: 'high' },
  }), { policy, env, transport });
  assert.deepEqual(calls, [{
    url: 'https://api.example.com/v1/images/generations',
    authorization: 'Bearer test-secret-value',
    body: { prompt: 'safe prompt', model: 'gpt-image-1', n: 1, quality: 'high' },
  }]);
  assert.equal(output.artifacts[0].url, 'https://media.example.com/result.png');
});

test('OpenAI-compatible accepts bounded base64 raster output', async () => {
  const output = await generate(provider('openai'), request({ model: 'gpt-image-1' }), {
    policy,
    env,
    transport: async () => ({ data: [{ b64_json: 'aGVsbG8=' }] }),
  });
  assert.equal(output.artifacts[0].url, 'data:image/png;base64,aGVsbG8=');
});

test('fal queue persists remote id before same-origin polling and sends exact reference URL', async () => {
  const events: string[] = [];
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const responses = [
    {
      request_id: 'fal_123',
      status_url: 'https://queue.example.com/status/fal_123',
      response_url: 'https://queue.example.com/result/fal_123',
    },
    { status: 'IN_PROGRESS' },
    { status: 'COMPLETED' },
    { video: { url: 'https://media.example.com/out.mp4' } },
  ];
  const transport: ProviderTransport = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    events.push(`${options.method}:${url}`);
    return responses.shift();
  };
  const output = await generate(provider('fal', 'https://queue.example.com'), request({
    kind: 'video',
    model: 'fal-ai/kling-video/v2.1/standard/image-to-video',
    referenceUrl: 'https://media.example.com/upstream.png',
    referenceField: 'start_image_url',
    params: { prompt: 'bad', start_image_url: 'bad', duration: 5 },
    onSubmitted: async (id) => { events.push(`saved:${id}`); await Promise.resolve(); },
  }), { policy, env, transport, pollIntervalMs: 0, maxPolls: 3 });

  assert.deepEqual(calls[0], {
    url: 'https://queue.example.com/fal-ai/kling-video/v2.1/standard/image-to-video',
    method: 'POST',
    body: { prompt: 'safe prompt', start_image_url: 'https://media.example.com/upstream.png', duration: 5 },
  });
  assert.deepEqual(events, [
    'POST:https://queue.example.com/fal-ai/kling-video/v2.1/standard/image-to-video',
    'saved:fal_123',
    'GET:https://queue.example.com/status/fal_123',
    'GET:https://queue.example.com/status/fal_123',
    'GET:https://queue.example.com/result/fal_123',
  ]);
  assert.equal(output.remoteId, 'fal_123');
  assert.deepEqual(output.artifacts, [{ kind: 'video', url: 'https://media.example.com/out.mp4' }]);
});

test('fal rejects a cross-origin poll URL before sending the key to it', async () => {
  const calls: string[] = [];
  await assert.rejects(generate(provider('fal', 'https://queue.example.com'), request({
    model: 'fal-ai/flux/schnell',
  }), {
    policy,
    env,
    transport: async (url) => {
      calls.push(url);
      return { request_id: 'fal_1', status_url: 'https://evil.example/status/fal_1' };
    },
    pollIntervalMs: 0,
  }), /Provider request failed/);
  assert.deepEqual(calls, ['https://queue.example.com/fal-ai/flux/schnell']);
});

test('runtime reference URL is policy checked before any remote POST', async () => {
  let calls = 0;
  await assert.rejects(generate(provider('fal', 'https://queue.example.com'), request({
    kind: 'video',
    model: 'fal-ai/kling/video',
    referenceUrl: 'https://evil.example/upstream.png',
  }), {
    policy,
    env,
    transport: async () => { calls += 1; return {}; },
  }), /Provider request failed/);
  assert.equal(calls, 0);
});

test('Replicate official-model adapter uses fixed create/poll paths and exact input body', async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const responses = [
    { id: 'pred_1' },
    { status: 'processing' },
    { status: 'succeeded', output: ['https://media.example.com/result.webp'] },
  ];
  let submitted = '';
  const output = await generate(provider('replicate'), request({
    model: 'black-forest-labs/flux-schnell',
    params: { prompt: 'bad', aspect_ratio: '16:9' },
    onSubmitted: (id) => { submitted = id; },
  }), {
    policy,
    env,
    pollIntervalMs: 0,
    maxPolls: 3,
    transport: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body });
      return responses.shift();
    },
  });
  assert.equal(submitted, 'pred_1');
  assert.deepEqual(calls, [
    {
      url: 'https://api.example.com/v1/models/black-forest-labs/flux-schnell/predictions',
      method: 'POST',
      body: { input: { prompt: 'safe prompt', aspect_ratio: '16:9' } },
    },
    { url: 'https://api.example.com/v1/predictions/pred_1', method: 'GET', body: undefined },
    { url: 'https://api.example.com/v1/predictions/pred_1', method: 'GET', body: undefined },
  ]);
  assert.equal(output.artifacts[0].url, 'https://media.example.com/result.webp');
});

test('model grammar accepts internal dots but rejects unsafe fal paths and non-official Replicate forms with zero POSTs', async () => {
  const invalidFal = [
    '.hidden/model',
    'fal-ai/.hidden',
    'fal-ai/./model',
    'fal-ai/../model',
    'fal-ai/%2e%2e/model',
    'fal-ai\\model',
    'fal-ai//model',
    'fal-ai/model?query=1',
    'fal-ai/model#fragment',
    'one',
  ];
  for (const model of invalidFal) {
    let calls = 0;
    await assert.rejects(generate(provider('fal', 'https://queue.example.com'), request({ model }), {
      policy, env, transport: async () => { calls += 1; return {}; },
    }), /Invalid provider model/);
    assert.equal(calls, 0);
  }
  for (const model of ['owner/name/version', 'owner', 'owner/.']) {
    let calls = 0;
    await assert.rejects(generate(provider('replicate'), request({ model }), {
      policy, env, transport: async () => { calls += 1; return {}; },
    }), /Invalid provider model/);
    assert.equal(calls, 0);
  }
});

test('remote disabled and missing own env credential stop before transport', async () => {
  let calls = 0;
  await assert.rejects(generate(provider('openai'), request({ model: 'gpt-image-1' }), {
    policy: { ...policy, remoteEnabled: false }, env, transport: async () => { calls += 1; return {}; },
  }), /Remote generation is disabled/);
  const inherited = Object.create({ RELAY_KEY_TEST: 'inherited-secret' }) as NodeJS.ProcessEnv;
  await assert.rejects(generate(provider('openai'), request({ model: 'gpt-image-1' }), {
    policy, env: inherited, transport: async () => { calls += 1; return {}; },
  }), /credential is unavailable/);
  assert.equal(calls, 0);
});

test('runtime request shape and prompt length are checked before transport', async () => {
  let calls = 0;
  await assert.rejects(generate(provider('openai'), request({
    model: 'gpt-image-1', prompt: 'x'.repeat(16_001),
  }), {
    policy, env, transport: async () => { calls += 1; return {}; },
  }), /Invalid generation request/);
  assert.equal(calls, 0);
});

test('reserved reference fields are rejected case-insensitively before any POST', async () => {
  const reserved = [
    '__proto__', 'proto', 'prototype', 'constructor', 'headers', 'Authorization', 'keyEnv',
    'url', 'method', 'redirect', 'timeout', 'prompt', 'model', 'input', 'n',
  ];
  for (const referenceField of reserved) {
    let calls = 0;
    await assert.rejects(generate(provider('fal', 'https://queue.example.com'), request({
      kind: 'video',
      model: 'fal-ai/kling-video/v2.1/standard/image-to-video',
      referenceField,
      referenceUrl: 'https://media.example.com/input.png',
    }), {
      policy,
      env,
      transport: async () => { calls += 1; return {}; },
    }), /Invalid reference field/);
    assert.equal(calls, 0, referenceField);
  }
  assert.doesNotThrow(() => preflightGeneration(provider('fal', 'https://queue.example.com'), {
    kind: 'video', model: 'fal-ai/kling-video/v2.1/standard/image-to-video', params: {}, referenceField: 'image_url',
  }, { policy, env }));
  assert.doesNotThrow(() => preflightGeneration(provider('fal', 'https://queue.example.com'), {
    kind: 'video', model: 'fal-ai/kling-video/v2.1/standard/image-to-video', params: {}, referenceField: 'start_image_url',
  }, { policy, env }));
});

test('malformed response is rejected with a safe error', async () => {
  await assert.rejects(generate(provider('openai'), request({ model: 'gpt-image-1' }), {
    policy, env, transport: async () => ({ data: [{ unexpected: '<secret-response>' }] }),
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Provider returned an invalid response');
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});

for (const { label, failure } of [
  { label: '429', failure: 'HTTP 429 secret response' },
  { label: '500', failure: 'HTTP 500 secret response' },
  { label: 'timeout', failure: 'timeout with secret response' },
]) {
  test(`POST failure is safe and never retried: ${label}`, async () => {
    let calls = 0;
    await assert.rejects(generate(provider('openai'), request({ model: 'gpt-image-1' }), {
      policy,
      env,
      transport: async () => { calls += 1; throw new Error(failure); },
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'Provider request failed');
      assert.doesNotMatch(error.message, /secret|429|500|timeout/i);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test('abort stops an in-flight POST and is reported safely without retry', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = generate(provider('openai'), request({ model: 'gpt-image-1', signal: controller.signal }), {
    policy,
    env,
    transport: async (_url, options) => {
      calls += 1;
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('remote secret')), { once: true });
      });
    },
  });
  controller.abort();
  await assert.rejects(pending, /Generation aborted/);
  assert.equal(calls, 1);
});
