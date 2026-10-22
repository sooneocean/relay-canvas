import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundary, isPublicAddress, readPolicy, safeJsonRequest, validateBaseUrl, validateMediaUrl } from '../server/security.js';
import { parseBoard, parseOperations, parseProviders, parseRunInput } from '../src/shared/schema.js';
import type { Board } from '../src/shared/types.js';

const policy = {
  remoteEnabled: true,
  providerOrigins: ['https://api.example.com'],
  mediaOrigins: ['https://media.example.com'],
};

function board(): Board {
  return {
    schemaVersion: 1,
    id: 'board_1',
    name: 'Board',
    revision: 0,
    nodes: [
      { id: 'a', type: 'canvas', position: { x: 0, y: 0 }, data: { kind: 'prompt', label: 'A', params: {} } },
      { id: 'b', type: 'canvas', position: { x: 1, y: 1 }, data: { kind: 'image', label: 'B', params: {} } },
    ],
    edges: [{ id: 'a-b', source: 'a', target: 'b' }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

test('policy accepts exact HTTPS origins and defaults remote off', () => {
  const result = readPolicy({
    RELAY_PROVIDER_ORIGINS: 'https://api.example.com',
    RELAY_MEDIA_ORIGINS: 'https://media.example.com',
  });
  assert.equal(result.remoteEnabled, false);
  assert.deepEqual(result.providerOrigins, ['https://api.example.com']);
  assert.throws(() => readPolicy({ RELAY_PROVIDER_ORIGINS: 'http://api.example.com' }), /Invalid security policy/);
  assert.throws(() => readPolicy({ RELAY_PROVIDER_ORIGINS: 'https://127.0.0.1' }), /Invalid security policy/);
  assert.throws(() => readPolicy({ RELAY_PROVIDER_ORIGINS: 'https://[::1]' }), /Invalid security policy/);
  assert.throws(() => readPolicy({ RELAY_PROVIDER_ORIGINS: 'https://api.example.com/' }), /Invalid security policy/);
  assert.throws(() => readPolicy({ RELAY_ENABLE_REMOTE: 'yes' }), /Invalid security policy/);
});

test('base and media URLs enforce exact origin and safe syntax', () => {
  assert.equal(validateBaseUrl('https://api.example.com/v1', policy).pathname, '/v1');
  assert.throws(() => validateBaseUrl('https://other.example.com/v1', policy), /not allowed/);
  assert.throws(() => validateBaseUrl('https://user:pass@api.example.com/v1', policy), /Invalid URL/);
  assert.throws(() => validateBaseUrl('https://api.example.com:444/v1', policy), /Invalid URL/);
  assert.throws(() => validateBaseUrl('https://api.example.com/v1?key=x', policy), /Invalid URL/);
  assert.throws(() => validateBaseUrl('https://api.example.com/%2e%2e/x', policy), /Invalid URL/);
  assert.throws(() => validateBaseUrl('https://api.example.com/v1/../admin', policy), /Invalid URL/);
  assert.equal(validateMediaUrl('https://media.example.com/a%20b.png?signature=abc', policy), 'https://media.example.com/a%20b.png?signature=abc');
  assert.throws(() => validateMediaUrl('https://api.example.com/a.png', policy), /not allowed/);
  assert.throws(() => validateMediaUrl('data:image/svg+xml;base64,PHN2Zz4=', policy), /Invalid URL/);
  assert.equal(validateMediaUrl('/demo-motion.mp4', policy, { allowDemo: true }), '/demo-motion.mp4');
});

test('public address classifier rejects local and special-use addresses', () => {
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('127.0.0.1'), false);
  assert.equal(isPublicAddress('10.0.0.1'), false);
  assert.equal(isPublicAddress('169.254.1.1'), false);
  assert.equal(isPublicAddress('::1'), false);
  assert.equal(isPublicAddress('not-an-ip'), false);
});

test('safe transport rejects literal hosts and pre-aborted requests before network access', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    safeJsonRequest('https://api.example.com/v1', { method: 'GET', headers: {}, signal: controller.signal }, policy),
    /Request aborted/,
  );
  await assert.rejects(
    safeJsonRequest('https://127.0.0.1/v1', { method: 'GET', headers: {}, signal: new AbortController().signal }, {
      ...policy, providerOrigins: ['https://127.0.0.1'],
    }),
    /Invalid URL/,
  );
});

test('safe transport observes cancellation while DNS resolution is pending', async () => {
  const controller = new AbortController();
  let resolved = false;
  const pending = safeJsonRequest('https://api.example.com/v1', {
    method: 'POST',
    headers: { authorization: 'Bearer secret' },
    body: { prompt: 'test' },
    signal: controller.signal,
    resolve: async () => await new Promise<Array<{ address: string; family: number }>>((resolve) => {
      setTimeout(() => { resolved = true; resolve([{ address: '8.8.8.8', family: 4 }]); }, 25);
    }),
  }, policy);
  controller.abort();
  await assert.rejects(pending, /Request aborted/);
  assert.equal(resolved, false);
});

interface MockResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  setHeader(name: string, value: string): void;
  status(code: number): MockResponse;
  json(value: unknown): void;
}

function invokeBoundary(input: {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  dev?: boolean;
}): { next: boolean; response: MockResponse } {
  const middleware = createBoundary({ origin: 'http://127.0.0.1:4310', token: 'x'.repeat(48), dev: input.dev ?? false, policy });
  const headers = Object.fromEntries(Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const response: MockResponse = {
    statusCode: 200,
    body: undefined,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; },
  };
  let next = false;
  middleware({
    path: input.path,
    method: input.method ?? 'GET',
    headers,
    get(name: string) { return headers[name.toLowerCase()]; },
  } as never, response as never, () => { next = true; });
  return { next, response };
}

test('boundary requires exact Host, session metadata, token and Origin', () => {
  const host = { host: '127.0.0.1:4310' };
  assert.equal(invokeBoundary({ path: '/healthz', headers: host }).next, true);
  assert.equal(invokeBoundary({ path: '/healthz', headers: { host: 'localhost:4310' } }).response.statusCode, 403);
  assert.equal(invokeBoundary({ path: '/api/session', headers: host }).response.statusCode, 403);
  assert.equal(invokeBoundary({ path: '/api/session', headers: { ...host, 'x-canvas-client': 'ui', 'sec-fetch-site': 'same-origin' } }).next, true);
  assert.equal(invokeBoundary({ path: '/api/session', headers: { ...host, origin: 'http://evil.test', 'x-canvas-client': 'ui', 'sec-fetch-site': 'same-origin' } }).response.statusCode, 403);
  assert.equal(invokeBoundary({ path: '/api/state', headers: { ...host, origin: 'http://127.0.0.1:4310', 'x-canvas-token': 'bad' } }).response.statusCode, 403);
  assert.equal(invokeBoundary({ path: '/api', headers: host }).response.statusCode, 403);
  const accepted = invokeBoundary({ path: '/api/state', headers: { ...host, origin: 'http://127.0.0.1:4310', 'x-canvas-token': 'x'.repeat(48) } });
  assert.equal(accepted.next, true);
  assert.match(accepted.response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.doesNotMatch(accepted.response.headers['content-security-policy'], /script-src[^;]*unsafe-inline/);
  const development = invokeBoundary({
    path: '/api/state',
    dev: true,
    headers: { ...host, origin: 'http://127.0.0.1:4310', 'x-canvas-token': 'x'.repeat(48) },
  });
  assert.match(development.response.headers['content-security-policy'], /script-src 'self' 'unsafe-inline'/);
  assert.match(development.response.headers['content-security-policy'], /ws:\/\/localhost:\*/);
});

test('strict schemas reject unknown fields, dangerous params, malformed URLs and cycles', () => {
  assert.deepEqual(parseBoard(board()), board());
  assert.throws(() => parseBoard({ ...board(), extra: true }), /Invalid request/);
  const dangerous = board();
  dangerous.nodes[0].data.params = { nested: { Authorization: 'secret' } };
  assert.throws(() => parseBoard(dangerous), /Invalid request/);
  const svg = board();
  svg.nodes[0].data.assetUrl = 'data:image/svg+xml;base64,PHN2Zz4=';
  assert.throws(() => parseBoard(svg), /Invalid request/);
  const cycle = board();
  cycle.edges.push({ id: 'b-a', source: 'b', target: 'a' });
  assert.throws(() => parseBoard(cycle), /Invalid request/);
  assert.throws(() => parseOperations([{ type: 'remove_node', id: 'a', extra: true }]), /Invalid request/);
  const reservedReference = board();
  reservedReference.nodes[1].data.referenceField = 'Authorization';
  assert.throws(() => parseBoard(reservedReference), /Invalid request/);
  assert.throws(() => parseRunInput({ boardId: 'a', expectedRevision: 0, operationId: 'op', confirmExternal: true, extra: 1 }), /Invalid request/);
  assert.throws(() => parseProviders([{ id: 'p', name: 'P', protocol: 'openai', baseUrl: '', keyEnv: 'HOME', imageModel: 'x', videoModel: '' }]), /Invalid request/);
});

test('parameter bounds cover depth, arrays and serialized size', () => {
  const deep = board();
  deep.nodes[0].data.params = { a: { b: { c: { d: { e: { f: {} } } } } } };
  assert.throws(() => parseBoard(deep), /Invalid request/);
  const wide = board();
  wide.nodes[0].data.params = { list: Array.from({ length: 101 }, () => 1) };
  assert.throws(() => parseBoard(wide), /Invalid request/);
  const large = board();
  large.nodes[0].data.params = { value: 'x'.repeat(16_000) };
  assert.doesNotThrow(() => parseBoard(large));
  large.nodes[0].data.params = { a: 'x'.repeat(9_000), b: 'y'.repeat(9_000) };
  assert.throws(() => parseBoard(large), /Invalid request/);
});
