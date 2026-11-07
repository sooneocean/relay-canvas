import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { GRAPH_BENCHMARK_V1 } from './fixtures/graph-benchmark-v01.js';
import { compareGraphPolicies, replayGraphBenchmark, scoreGraphCandidate } from '../server/graph-benchmark.js';
import { summarizeLearningJournal } from '../server/learning-replay.js';

test('synthetic Graph Benchmark v0.1 passes real service patch/validation semantics', () => {
  const report = replayGraphBenchmark(GRAPH_BENCHMARK_V1);
  assert.equal(GRAPH_BENCHMARK_V1.length, 29);
  assert.equal(report.failed, 0, JSON.stringify(report.cases.filter(row => !row.passed)));
  assert.equal(report.passed, 29);
  assert.ok(report.cases.filter(row => row.category === 'guardrail').length >= 10);
});

test('benchmark rejects valid no-op and unrelated patches: goal equivalence is required', () => {
  const example = GRAPH_BENCHMARK_V1.find(row => row.id === 'edit-rename')!;
  assert.equal(scoreGraphCandidate(example, {
    expectedRevision: 0, operations: [{ type: 'update_node', id: 'brief', data: { label: 'Wrong label' } }]
  }).passed, false);
  assert.equal(scoreGraphCandidate(example, {
    expectedRevision: 0, operations: [{ type: 'update_node', id: 'direction', data: { label: 'Unrelated' } }]
  }).passed, false);
  assert.equal(scoreGraphCandidate(example, {
    expectedRevision: 0, operations: (example.challenge.kind === 'patch' ? example.challenge.reference.operations : [])
  }).passed, true);
});

test('stale revision and unsafe changes earn no credit unless correct fail-closed behavior occurs', () => {
  const stale = GRAPH_BENCHMARK_V1.find(row => row.id === 'guard-stale-revision')!;
  assert.equal(scoreGraphCandidate(stale, {
    expectedRevision: 1, operations: [{ type: 'update_node', id: 'brief', data: { label: 'Stale' } }]
  }).passed, true);
  assert.equal(scoreGraphCandidate(stale, {
    expectedRevision: 0, operations: [{ type: 'update_node', id: 'brief', data: { label: 'Applied' } }]
  }).passed, false);
});

test('paired baseline/candidate comparison records repairs and regressions without hiding failures', () => {
  const example = GRAPH_BENCHMARK_V1.find(row => row.id === 'edit-rename')!;
  const reference = example.challenge.kind === 'patch' ? example.challenge.reference.operations : [];
  const better = { [example.id]: { expectedRevision: 0, operations: reference } };
  const worse = { [example.id]: { expectedRevision: 0, operations: [{ type: 'update_node' as const, id: 'brief', data: { label: 'Wrong' } }] } };
  const gain = compareGraphPolicies([example], worse, better);
  assert.deepEqual(gain, { total: 1, baselinePassed: 0, candidatePassed: 1, repaired: 1, regressed: 0, bothPassed: 0, bothFailed: 0 });
  const loss = compareGraphPolicies([example], better, worse);
  assert.equal(loss.regressed, 1);
  assert.equal(loss.repaired, 0);
});

function ev(type: string, runId: string, extra: Record<string, unknown> = {}) {
  return { schemaVersion: 1, eventId: randomUUID(), occurredAt: new Date(0).toISOString(),
    type, boardId: 'welcome', revision: 0, episodeId: runId,
    runId, ...extra };
}
test('journal summary deduplicates exact event IDs and records incompletes and orphans', () => {
  const start = JSON.stringify(ev('run.started', 'runA', { generations: 2, remote: false }));
  const finish = JSON.stringify(ev('run.finished', 'runA', { status: 'succeeded', succeededNodes: 2, artifactCount: 2 }));
  const orphan = JSON.stringify(ev('run.finished', 'runB', { status: 'needs_review', succeededNodes: 0, artifactCount: 0 }));
  const pending = JSON.stringify(ev('run.started', 'runC', { generations: 1, remote: false }));
  const summary = summarizeLearningJournal([start, start, finish, orphan, pending, ''].join('\n'));
  assert.equal(summary.acceptedEvents, 4);
  assert.equal(summary.duplicateEvents, 1);
  assert.equal(summary.startedRuns, 2);
  assert.equal(summary.terminalRuns, 2);
  assert.equal(summary.orphanTerminals, 1);
  assert.equal(summary.incompleteRuns, 1);
  assert.equal(summary.terminalStatusCounts.needs_review, 1);
});

test('torn final line is not interpreted as valid evidence; corrupt inner lines fail closed', () => {
  const start = JSON.stringify(ev('run.started', 'runA'));
  const summary = summarizeLearningJournal(start + '\n{"schemaVersion":');
  assert.equal(summary.acceptedEvents, 1);
  assert.equal(summary.truncatedTail, true);
  assert.throws(() => summarizeLearningJournal('{"bad":}\n' + start + '\n'), /Invalid journal line/);
  assert.throws(() => summarizeLearningJournal(start + '\n{"bad":}\n'), /Invalid journal line/);
});

test('unknown or conflicting records and forged status fail closed', () => {
  const start = ev('run.started', 'runA');
  const first = JSON.stringify(start);
  assert.throws(() => summarizeLearningJournal(first + '\n' + JSON.stringify({ ...start, revision: 1 }) + '\n'), /Conflicting duplicate/);
  assert.throws(() => summarizeLearningJournal(JSON.stringify(ev('run.finished', 'runA', { status: 'paid' })) + '\n'), /Invalid event schema/);
  assert.throws(() => summarizeLearningJournal(JSON.stringify({ ...start, type: 'artifact.content' }) + '\n'), /Invalid event schema/);
});
