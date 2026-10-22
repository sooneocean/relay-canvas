import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, atomicWrite } from '../server/store.js';
import { CanvasService } from '../server/service.js';
import { topology } from '../server/graph.js';
import { starterBoard } from '../src/shared/defaults.js';
import type { GenerationOutput, GenerationRequest, Provider } from '../src/shared/types.js';

const policy = { remoteEnabled: false, providerOrigins: ['https://api.openai.com'], mediaOrigins: ['https://media.example.com'] };
function fixture(generator?: (p: Provider, r: GenerationRequest) => Promise<GenerationOutput>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-unit-'));
  const store = new Store(dir), service = new CanvasService(store, policy, generator);
  return { dir, store, service, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('compare-and-swap accepts one concurrent revision and stale writes have no effects', () => {
  const f = fixture();
  try {
    const first = f.service.board('welcome'), second = structuredClone(first);
    first.name = 'Human'; second.name = 'Agent';
    assert.equal(f.service.save('welcome', 0, first).revision, 1);
    const bytes = readFileSync(f.store.file, 'utf8');
    assert.throws(() => f.service.save('welcome', 0, second), /其他視窗或 Agent/);
    assert.equal(readFileSync(f.store.file, 'utf8'), bytes);
  } finally { f.cleanup(); }
});

test('atomic patches cascade deletion and malformed edges roll back the whole transaction', () => {
  const f = fixture();
  try {
    assert.throws(() => f.service.patch('welcome', 0, [
      { type: 'update_node', id: 'brief', data: { label: 'should not persist' } },
      { type: 'connect', edge: { id: 'bad', source: 'missing', target: 'frame' } },
    ]));
    assert.equal(f.service.board('welcome').revision, 0);
    const saved = f.service.patch('welcome', 0, [{ type: 'remove_node', id: 'frame' }]);
    assert.equal(saved.edges.length, 0);
    assert.equal(saved.nodes.some(n => n.id === 'frame'), false);
  } finally { f.cleanup(); }
});

test('typed connections reject duplicate input and wrong media before execution', () => {
  const board = starterBoard();
  board.edges.push({ id: 'wrong', source: 'motion', target: 'frame' });
  assert.throws(() => topology(board), /圖片只接收/);
  board.edges.pop();
  board.nodes.push({ id: 'second', type: 'canvas', position: { x: 0, y: 0 }, data: { kind: 'image', label: 'second' } });
  board.edges.push({ id: 'extra', source: 'second', target: 'motion' });
  assert.throws(() => topology(board), /最多接收/);
});

test('same-run image is passed exactly to video, snapshots isolate concurrent edits, operation replay is idempotent', async () => {
  const calls: GenerationRequest[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async (_p, request) => {
    calls.push(request);
    if (request.kind === 'image') { await barrier; return { artifacts: [{ kind: 'image', url: 'https://media.example.com/exact.png' }] }; }
    return { artifacts: [{ kind: 'video', url: 'https://media.example.com/exact.mp4' }] };
  });
  try {
    const operationId = randomUUID();
    const input = { boardId: 'welcome', expectedRevision: 0, operationId, nodeId: 'motion' };
    const run = f.service.start(input);
    assert.equal(f.service.start(input).id, run.id);
    await Promise.resolve();
    f.service.patch('welcome', 0, [{ type: 'update_node', id: 'frame', data: { prompt: 'Changed after run started' } }]);
    release();
    const complete = await f.service.settled(run.id);
    assert.equal(complete.status, 'succeeded');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].referenceUrl, 'https://media.example.com/exact.png');
    assert.equal(complete.results.motion.referenceUrl, complete.results.frame.artifacts[0].url);
    assert.match(calls[0].prompt, /一座安靜的沙漠/);
    assert.doesNotMatch(calls[0].prompt, /Changed after/);
    assert.equal(f.service.start(input).id, run.id);
    const reopened = new CanvasService(new Store(f.dir), policy);
    assert.equal(reopened.start(input).id, run.id);
    assert.equal(reopened.getRun(run.id).results.motion.referenceUrl, 'https://media.example.com/exact.png');
  } finally { release(); f.cleanup(); }
});

test('default remote gate, missing configuration and stale revision prevent all generation', () => {
  let called = 0;
  const f = fixture(async () => { called++; return { artifacts: [] }; });
  try {
    const board = f.service.board('welcome');
    board.nodes.find(n => n.id === 'frame')!.data.providerId = 'openai';
    f.service.save('welcome', 0, board);
    assert.throws(() => f.service.start({ boardId: 'welcome', expectedRevision: 1, operationId: randomUUID() }), /REMOTE|遠端生成/);
    assert.throws(() => f.service.start({ boardId: 'welcome', expectedRevision: 0, operationId: randomUUID() }), /版本/);
    assert.equal(called, 0); assert.equal(f.store.read().runs.length, 0);
  } finally { f.cleanup(); }
});

test('failed node stops descendants and preserves a durable single-attempt marker', async () => {
  let count = 0;
  const f = fixture(async () => { count++; throw new Error('secret upstream error must never be persisted'); });
  try {
    const run = f.service.start({ boardId: 'welcome', expectedRevision: 0, operationId: randomUUID() });
    const result = await f.service.settled(run.id);
    assert.equal(result.status, 'failed'); assert.equal(count, 1);
    assert.ok(result.results.frame.attemptId);
    assert.equal(result.results.motion.status, 'cancelled');
    assert.doesNotMatch(readFileSync(f.store.file, 'utf8'), /secret upstream/);
  } finally { f.cleanup(); }
});

test('cancellation stops descendants without claiming remote cancellation', async () => {
  let release!: () => void;
  const barrier = new Promise<void>(r => { release = r; });
  let calls = 0;
  const f = fixture(async () => { calls++; await barrier; return { artifacts: [{ kind: 'image', url: 'https://media.example.com/a.png' }] }; });
  try {
    const run = f.service.start({ boardId: 'welcome', expectedRevision: 0, operationId: randomUUID() });
    await Promise.resolve(); f.service.cancel(run.id); release();
    const result = await f.service.settled(run.id);
    assert.equal(result.status, 'cancelled'); assert.equal(calls, 1);
    assert.match(result.error!, /遠端任務可能/);
  } finally { release(); f.cleanup(); }
});

test('crash recovery retains submitted attempts and does not replay them', () => {
  const f = fixture();
  try {
    const board = f.service.board('welcome');
    f.store.transaction(data => { data.runs.push({ id: 'crash-run', boardId: board.id, revision: 0, operationId: 'once', status: 'running', snapshot: board, providers: data.providers, startedAt: new Date().toISOString(), order: ['frame'], results: { frame: { nodeId: 'frame', status: 'submitting', artifacts: [], attemptId: 'durable-attempt', remoteId: 'upstream-42' } } }); });
    const recovered = new CanvasService(new Store(f.dir), policy);
    const run = recovered.start({ boardId: board.id, expectedRevision: 0, operationId: 'once' });
    assert.equal(run.status, 'interrupted');
    assert.equal(run.results.frame.attemptId, 'durable-attempt'); assert.equal(run.results.frame.remoteId, 'upstream-42');
  } finally { f.cleanup(); }
});

test('corrupt store fails closed and failed writes preserve prior bytes', () => {
  const f = fixture();
  try {
    const before = readFileSync(f.store.file, 'utf8');
    assert.throws(() => atomicWrite(f.store.file, { impossible: 1n }));
    assert.equal(readFileSync(f.store.file, 'utf8'), before);
    writeFileSync(f.store.file, '{broken json');
    assert.throws(() => new Store(f.dir));
    assert.equal(readFileSync(f.store.file, 'utf8'), '{broken json');
  } finally { f.cleanup(); }
});
