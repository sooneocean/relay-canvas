import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanvasService } from '../server/service.js';
import { enqueueLearningEvent, LocalLearningJournal, sealLearningEvent } from '../server/learning-events.js';
import { summarizeLearningJournal } from '../server/learning-replay.js';
import { Store, atomicWrite } from '../server/store.js';
import type { GenerationRequest, Provider } from '../src/shared/types.js';

const policy = { remoteEnabled: false, providerOrigins: ['https://api.openai.com'], mediaOrigins: ['https://media.example.com'] };
const journalName = 'learning-events.v1.jsonl';
const journalPath = (dir: string) => path.join(dir, journalName);
const generator = async (_provider: Provider, request: GenerationRequest) => ({
  artifacts: [{ kind: request.kind, url: request.kind === 'image'
    ? 'https://media.example.com/synthetic.png' : 'https://media.example.com/synthetic.mp4' }]
});

function fixture(enabled = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-durable-learning-'));
  const store = new Store(dir);
  const learning = enabled ? new LocalLearningJournal(dir) : undefined;
  const service = new CanvasService(store, policy, generator, undefined, undefined, learning);
  return { dir, store, learning, service, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function events(dir: string): Array<Record<string, unknown>> {
  return readFileSync(journalPath(dir), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

test('journal delivery failure retains events in the same committed workspace; restart drains stable IDs', () => {
  const f = fixture();
  try {
    const privatePrompt = 'NEVER_LOG_THIS_CREATIVE_PROMPT';
    const target = path.join(f.dir, 'target');
    writeFileSync(target, 'untouched');
    symlinkSync(target, journalPath(f.dir));
    assert.equal(f.service.patch('welcome', 0, [{ type: 'update_node', id: 'brief', data: { prompt: privatePrompt } }]).revision, 1);
    const persisted = new Store(f.dir).read();
    assert.equal(persisted.learningOutbox?.length, 2);
    const committedIds = persisted.learningOutbox!.map(entry => entry.eventId);
    assert.deepEqual(persisted.learningOutbox!.map(entry => entry.type), ['board.revision_committed', 'board.patch_committed']);
    assert.ok(persisted.learningOutbox!.every(entry => entry.actor === 'unattributed' && entry.scope === 'local_only'));
    assert.ok(!JSON.stringify(persisted.learningOutbox).includes(privatePrompt));
    assert.ok(!JSON.stringify(persisted.learningOutbox).includes('api.openai.com'));
    const visible = f.service.state() as Record<string, unknown>;
    assert.equal(Object.hasOwn(visible, 'learningOutbox'), false);
    assert.equal(Object.hasOwn(visible, 'learningObservedRuns'), false);
    assert.equal(Object.hasOwn(visible, 'learningDroppedEvents'), false);
    assert.equal(readFileSync(target, 'utf8'), 'untouched');
    unlinkSync(journalPath(f.dir));
    new CanvasService(new Store(f.dir), policy, generator, undefined, undefined, new LocalLearningJournal(f.dir));
    assert.deepEqual(events(f.dir).map(event => event.eventId), committedIds);
    assert.equal(new Store(f.dir).read().learningOutbox?.length, 0);
  } finally { f.cleanup(); }
});

test('workspace transaction write failure rolls back graph and enqueue atomically', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-durable-write-'));
  let fail = false;
  try {
    const store = new Store(dir, { write: (file, value) => {
      if (fail) throw new Error('synthetic disk failure');
      atomicWrite(file, value);
    } });
    const service = new CanvasService(store, policy, generator, undefined, undefined, new LocalLearningJournal(dir));
    fail = true;
    assert.throws(() => service.patch('welcome', 0, [{ type: 'remove_node', id: 'frame' }]), /synthetic disk failure/);
    assert.equal(new Store(dir).read().boards.find(board => board.id === 'welcome')!.revision, 0);
    assert.equal(store.read().learningOutbox?.length ?? 0, 0);
    assert.equal(existsSync(journalPath(dir)), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('after append but before outbox ack, duplicate delivery keeps a single logical eventId', () => {
  const f = fixture(false);
  try {
    f.store.transaction(data => { enqueueLearningEvent(data, {
      type: 'board.revision_committed', boardId: 'welcome', revision: 0, nodes: 4, edges: 2
    }); });
    const pending = f.store.read().learningOutbox![0];
    const journal = new LocalLearningJournal(f.dir);
    assert.equal(journal.append(pending), true);
    new CanvasService(new Store(f.dir), policy, generator, undefined, undefined, journal);
    const raw = readFileSync(journalPath(f.dir), 'utf8');
    const summary = summarizeLearningJournal(raw);
    assert.equal(summary.acceptedEvents, 1);
    assert.equal(summary.duplicateEvents, 1);
    assert.deepEqual(events(f.dir).map(event => event.eventId), [pending.eventId, pending.eventId]);
    assert.equal(new Store(f.dir).read().learningOutbox!.length, 0);
  } finally { f.cleanup(); }
});

test('crashed observed run emits an interrupted terminal without new provider submission', () => {
  const f = fixture(false);
  let called = 0;
  try {
    const board = f.store.read().boards[0];
    f.store.transaction(data => {
      const run = {
        id: 'crashed-run', boardId: board.id, revision: board.revision, operationId: 'once',
        status: 'running' as const, startedAt: new Date().toISOString(),
        snapshot: board, providers: data.providers, order: ['frame'],
        results: { frame: { nodeId: 'frame', status: 'submitting' as const, artifacts: [], attemptId: 'attempt-1' } }
      };
      data.runs.unshift(run);
      enqueueLearningEvent(data, { type: 'run.started', boardId: board.id, revision: board.revision,
        runId: run.id, generations: 1, remote: false });
      data.learningObservedRuns = [run.id];
    });
    const recovered = new Store(f.dir);
    assert.equal(recovered.read().runs[0].status, 'interrupted');
    new CanvasService(recovered, policy, async () => { called++; throw new Error('must not generate'); },
      undefined, undefined, new LocalLearningJournal(f.dir));
    assert.equal(called, 0);
    assert.deepEqual(events(f.dir).map(e => e.type), ['run.started', 'run.finished']);
    assert.equal(events(f.dir)[1].status, 'interrupted');
    assert.equal(new Store(f.dir).read().learningObservedRuns?.length, 0);
  } finally { f.cleanup(); }
});

test('normal opt-in run creates exactly one start and terminal event with no text or URL', async () => {
  const f = fixture();
  try {
    const run = f.service.start({ boardId: 'welcome', expectedRevision: 0, operationId: randomUUID() });
    assert.equal(f.service.start({ boardId: 'welcome', expectedRevision: 0, operationId: run.operationId }).id, run.id);
    assert.equal((await f.service.settled(run.id)).status, 'succeeded');
    assert.deepEqual(events(f.dir).map(e => e.type), ['run.started', 'run.finished']);
    assert.equal(events(f.dir)[1].artifactCount, 2);
    assert.equal(f.store.read().learningOutbox?.length, 0);
    assert.equal(f.store.read().learningObservedRuns?.length, 0);
    assert.ok(!readFileSync(journalPath(f.dir), 'utf8').includes('media.example.com'));
  } finally { f.cleanup(); }
});

test('outbox capacity is bounded, records observation loss, and does not block graph mutation', () => {
  const f = fixture();
  try {
    const target = path.join(f.dir, 'target');
    writeFileSync(target, 'unchanged');
    symlinkSync(target, journalPath(f.dir));
    f.store.transaction(data => {
      data.learningOutbox = Array.from({ length: 1024 }, () =>
        sealLearningEvent({ type: 'board.revision_committed', boardId: 'welcome',
          revision: 0, nodes: 4, edges: 2 }));
    });
    const saved = f.service.patch('welcome', 0, [{ type: 'remove_node', id: 'direction' }]);
    assert.equal(saved.revision, 1);
    const data = f.store.read();
    assert.equal(data.learningOutbox?.length, 1024);
    assert.equal(data.learningDroppedEvents, 2);
    assert.equal(readFileSync(target, 'utf8'), 'unchanged');
  } finally { f.cleanup(); }
});

test('torn journal tail blocks new writes but retains committed outbox for manual repair', () => {
  const f = fixture();
  try {
    writeFileSync(journalPath(f.dir), '{"incomplete":', { mode: 0o600 });
    const saved = f.service.patch('welcome', 0, [{ type: 'remove_node', id: 'direction' }]);
    assert.equal(saved.revision, 1);
    assert.equal(f.store.read().learningOutbox?.length, 2);
    assert.equal(readFileSync(journalPath(f.dir), 'utf8'), '{"incomplete":');
  } finally { f.cleanup(); }
});

test('disabled collector never drains existing outbox and never exposes it through state', () => {
  const f = fixture(false);
  try {
    f.store.transaction(data => { enqueueLearningEvent(data, {
      type: 'board.revision_committed', boardId: 'welcome', revision: 0, nodes: 4, edges: 2
    }); });
    const fresh = new CanvasService(new Store(f.dir), policy, generator);
    assert.equal(existsSync(journalPath(f.dir)), false);
    assert.equal(new Store(f.dir).read().learningOutbox?.length, 1);
    assert.equal(Object.hasOwn(fresh.state(), 'learningOutbox'), false);
  } finally { f.cleanup(); }
});
