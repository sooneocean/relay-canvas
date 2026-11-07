import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CanvasService } from '../server/service.js';
import { LocalLearningJournal } from '../server/learning-events.js';
import { Store } from '../server/store.js';
import type { GenerationRequest, Provider } from '../src/shared/types.js';

const policy = { remoteEnabled: false, providerOrigins: ['https://api.openai.com'], mediaOrigins: ['https://media.example.com'] };
const journalName = 'learning-events.v1.jsonl';

function fixture(enabled: boolean) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-learning-'));
  const store = new Store(dir);
  const learning = enabled ? new LocalLearningJournal(dir) : undefined;
  const generate = async (_provider: Provider, request: GenerationRequest) => ({
    artifacts: [{ kind: request.kind, url: request.kind === 'image' ? 'https://media.example.com/out.png' : 'https://media.example.com/out.mp4' }],
  });
  const service = new CanvasService(store, policy, generate, undefined, undefined, learning);
  return { dir, service, learning, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
function events(dir: string): Array<Record<string, unknown>> {
  return readFileSync(path.join(dir, journalName), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
}

test('learning observation is disabled by default', async () => {
  const f = fixture(false);
  try {
    f.service.patch('welcome', 0, [{ type: 'update_node', id: 'brief', data: { label: 'private' } }]);
    const run = f.service.start({ boardId: 'welcome', expectedRevision: 1, operationId: randomUUID() });
    await f.service.settled(run.id);
    assert.equal(existsSync(path.join(f.dir, journalName)), false);
  } finally { f.cleanup(); }
});

test('opt-in observation records committed revisions, patch types and one terminal run without raw content', async () => {
  const f = fixture(true);
  try {
    const secret = 'PRIVATE_PROMPT_DO_NOT_STORE';
    f.service.patch('welcome', 0, [{ type: 'update_node', id: 'brief', data: { prompt: secret } }]);
    const request = { boardId: 'welcome', expectedRevision: 1, operationId: randomUUID() };
    const run = f.service.start(request);
    assert.equal(f.service.start(request).id, run.id);
    const completed = await f.service.settled(run.id);
    assert.equal(completed.status, 'succeeded');
    const result = events(f.dir);
    assert.deepEqual(result.map(x => x.type), [
      'board.revision_committed', 'board.patch_committed', 'run.started', 'run.finished'
    ]);
    assert.equal(result[0].revision, 1);
    assert.deepEqual(result[1].operationTypes, ['update_node']);
    assert.equal(result[2].episodeId, run.id);
    assert.equal(result[3].status, 'succeeded');
    assert.equal(result[3].artifactCount, 2);
    assert.equal((statSync(path.join(f.dir, journalName)).mode & 0o777), 0o600);
    const raw = readFileSync(path.join(f.dir, journalName), 'utf8');
    assert.ok(!raw.includes(secret));
    assert.ok(!raw.includes('media.example.com'));
    assert.ok(!raw.includes('keyEnv'));
    assert.ok(result.every(x => x.schemaVersion === 1 && typeof x.eventId === 'string'));
  } finally { f.cleanup(); }
});

test('invalid patches and revision conflicts do not emit committed events', () => {
  const f = fixture(true);
  try {
    assert.throws(() => f.service.patch('welcome', 0, [{ type: 'connect', edge: { id: 'bad', source: 'not-found', target: 'frame' } }]));
    assert.throws(() => f.service.patch('welcome', 5, [{ type: 'remove_node', id: 'frame' }]));
    assert.equal(existsSync(path.join(f.dir, journalName)), false);
  } finally { f.cleanup(); }
});

test('cancellation emits a single terminal event, not success', async () => {
  const f = fixture(true);
  try {
    const run = f.service.start({ boardId: 'welcome', expectedRevision: 0, operationId: randomUUID() });
    f.service.cancel(run.id);
    await f.service.settled(run.id);
    assert.deepEqual(events(f.dir).map(e => e.type), ['run.started', 'run.finished']);
    assert.equal(events(f.dir)[1].status, 'cancelled');
  } finally { f.cleanup(); }
});

test('unsafe journal path does not block valid board mutations or overwrite symlink target', () => {
  const f = fixture(true);
  try {
    const target = path.join(f.dir, 'outside.txt');
    writeFileSync(target, 'preserve');
    symlinkSync(target, path.join(f.dir, journalName));
    const saved = f.service.patch('welcome', 0, [{ type: 'remove_node', id: 'frame' }]);
    assert.equal(saved.revision, 1);
    assert.equal(readFileSync(target, 'utf8'), 'preserve');
  } finally { f.cleanup(); }
});
