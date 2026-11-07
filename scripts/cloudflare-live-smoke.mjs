import assert from 'node:assert/strict';

const base = 'https://reachflow-canvas-preview.sooneocean.workers.dev';
const timeout = 20000;
async function probe(path, options = {}) {
  return fetch(base + path, { ...options, signal: AbortSignal.timeout(timeout) });
}

const home = await probe('/');
assert.equal(home.status, 200, 'Cloudflare homepage should return 200');
assert.match(home.headers.get('content-type') ?? '', /text\/html/i);
assert.match(home.headers.get('x-robots-tag') ?? '', /noindex/);
const html = await home.text();
assert.match(html, /ReachFlow/);
assert.match(html, /Cloudflare Preview/);
assert.match(html, /僅前端展示/);
const js = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
const css = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
assert.ok(js && css, 'Vite JS and CSS must be present in HTML');
for (const [path, expectedType] of [[js, 'javascript'], [css, 'text/css'], ['/cloudflare-preview.css', 'text/css']]) {
  const response = await probe(path);
  assert.equal(response.status, 200, path + ' should be available');
  assert.ok((response.headers.get('content-type') ?? '').includes(expectedType), path + ' has wrong MIME');
  assert.ok((await response.arrayBuffer()).byteLength > 100, path + ' must not be empty');
}
const health = await probe('/healthz');
assert.equal(health.status, 200);
const healthPayload = await health.json();
assert.deepEqual({ok:healthPayload.ok, backend:healthPayload.backend}, {ok:true, backend:false});
const api = await probe('/api/session');
assert.equal(api.status, 503, 'frontend-only backend must fail closed');
assert.equal((await api.json()).code, 'BACKEND_UNAVAILABLE');
const mutation = await probe('/api/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
assert.equal(mutation.status, 405, 'mutations must be rejected');
const range = await probe('/demo-motion.mp4',{headers:{Range:'bytes=0-99'}});
assert.equal(range.status, 206);
assert.match(range.headers.get('content-range') ?? '', /^bytes 0-99\/\d+$/);
assert.equal((await range.arrayBuffer()).byteLength, 100);
console.log(JSON.stringify({result:'PASS',homepage:home.status,assets:3,health:health.status,api:api.status,mutation:mutation.status,range:range.status}));
