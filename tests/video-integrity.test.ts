import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateVideoIntegrity, validateCandidate, DEFAULT_INTEGRITY_POLICY,
  type DriftEvent, type IntegrityAnchor, type MetricAssessment,
  type SegmentCandidate, type VerifiedCheckpoint,
} from '../src/shared/video-integrity.js';

const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const hashC = 'c'.repeat(64);
const anchor: IntegrityAnchor = {
  schemaVersion: 1, id: 'anchor-1', boardId: 'board-1', artifactSha256: hashA,
  kind: 'image', origin: 'imported_original',
  approval: { reviewerId: 'reviewer-1', approvedAt: '2026-11-07T15:00:00.000Z' },
};
const checkpoint: VerifiedCheckpoint = {
  schemaVersion: 1, id: 'verified-1', boardId: 'board-1', segmentId: 'previous',
  artifactSha256: hashB, status: 'verified', verifiedAt: '2026-11-07T15:01:00.000Z',
};
function metrics(score = 0.95, confidence = 0.99): MetricAssessment[] {
  return DEFAULT_INTEGRITY_POLICY.requiredMetrics.map(metric => ({ metric, score, confidence, scorerId: 'fixture-v1' }));
}
function candidate(overrides: Partial<SegmentCandidate> = {}): SegmentCandidate {
  return {
    schemaVersion: 1, id: 'segment-2', boardId: 'board-1', artifactSha256: hashB,
    promptSha256: hashC, modelId: 'demo-video', anchorIds: [anchor.id],
    parentCheckpointId: checkpoint.id, startMs: 5_000, endMs: 10_000,
    assessments: metrics(), events: [], ...overrides,
  };
}
function event(type: DriftEvent['type'], overrides: Partial<DriftEvent> = {}): DriftEvent {
  return { type, confidence: 0.98, affectedFraction: 0.1, startMs: 7_000,
    endMs: 9_000, persistsAcrossSegments: false, ...overrides };
}
const evaluate = (c: SegmentCandidate, a = [anchor], p: VerifiedCheckpoint | undefined = checkpoint) => evaluateVideoIntegrity(c, a, p);

test('complete, confident and independently anchored candidate passes; input is not mutated', () => {
  const input = candidate();
  const before = structuredClone(input);
  assert.deepEqual(evaluate(input), { candidateId: 'segment-2', action: 'accept', reason: 'PASSED', failedMetrics: [], driftTypes: [] });
  assert.deepEqual(input, before);
});

test('anchor and checkpoint boundaries fail closed', () => {
  assert.equal(evaluate(candidate(), []).reason, 'UNVERIFIED_ANCHOR');
  assert.equal(evaluate(candidate(), [{ ...anchor, boardId: 'foreign' }]).reason, 'UNVERIFIED_ANCHOR');
  assert.equal(evaluateVideoIntegrity(candidate(), [anchor], undefined).reason, 'MISSING_PARENT');
  assert.equal(evaluate(candidate(), [anchor], { ...checkpoint, boardId: 'foreign' }).reason, 'UNVERIFIED_PARENT');
  assert.equal(evaluate(candidate({ parentCheckpointId: undefined })).reason, 'UNVERIFIED_PARENT');
});

test('missing, low-confidence and failing metrics never self-certify a segment', () => {
  assert.equal(evaluate(candidate({ assessments: [] })).reason, 'INCOMPLETE_METRICS');
  assert.equal(evaluate(candidate({ assessments: metrics(0.95, 0.4) })).reason, 'LOW_CONFIDENCE');
  assert.deepEqual(evaluate(candidate({ assessments: metrics(0.1) })).failedMetrics,
    ['subject', 'background', 'temporal', 'semantic', 'imaging']);
  assert.equal(evaluate(candidate({ assessments: metrics(0.1) })).action, 'manual_review');
  assert.equal(evaluate(candidate({ events: [event('motion', { confidence: 0.4 })] })).reason, 'LOW_CONFIDENCE');
});

test('single local drift is repaired locally, larger drift regenerates, motion regenerates', () => {
  assert.equal(evaluate(candidate({ events: [event('local_geometry', { affectedFraction: 0.25 })] })).action, 'local_inpaint');
  assert.equal(evaluate(candidate({ events: [event('local_geometry', { affectedFraction: 0.251 })] })).action, 'regenerate_segment');
  assert.equal(evaluate(candidate({ events: [event('motion')] })).action, 'regenerate_segment');
  assert.equal(evaluate(candidate({ events: [event('local_geometry'), event('motion')] })).action, 'regenerate_segment');
});

test('persistent or identity/semantic/scene drift rolls back, first segment regenerates', () => {
  for (const type of ['identity', 'semantic', 'scene_geometry'] as const) {
    const drifted = candidate({ events: [event(type)] });
    assert.deepEqual([evaluate(drifted).action, evaluate(drifted).checkpointId], ['rollback_and_regenerate', checkpoint.id]);
    assert.equal(evaluateVideoIntegrity({ ...drifted, parentCheckpointId: undefined }, [anchor], undefined).action, 'regenerate_segment');
  }
  assert.equal(evaluate(candidate({ events: [event('color', { persistsAcrossSegments: true })] })).action, 'rollback_and_regenerate');
});

test('repairable visual defects route to restoration without claiming recovery', () => {
  for (const type of ['color', 'compression'] as const) {
    assert.equal(evaluate(candidate({ events: [event(type)] })).action, 'restore');
  }
});

test('invalid inputs rejected: unknown fields, range, duplicates, NaN and fake hash', () => {
  const invalid: SegmentCandidate[] = [
    { ...candidate(), anchorIds: ['anchor-1', 'anchor-1'] },
    { ...candidate(), endMs: 5_000 },
    { ...candidate(), artifactSha256: 'not-sha' },
    { ...candidate(), assessments: [{ ...metrics()[0], score: Number.NaN }] },
    { ...candidate(), assessments: [...metrics(), metrics()[0]] },
    { ...candidate(), events: [event('identity', { endMs: 12_000 })] },
    { ...candidate(), injected: 'not allowed' } as SegmentCandidate,
  ];
  for (const input of invalid) assert.throws(() => validateCandidate(input), /Invalid video integrity input/);
});

test('policy thresholds are not silently bypassed', () => {
  const input = candidate({ assessments: metrics(0.79) });
  assert.equal(evaluate(input).reason, 'NO_REPAIR_DIAGNOSIS');
  assert.throws(() => evaluateVideoIntegrity(input, [anchor], checkpoint, {
    ...DEFAULT_INTEGRITY_POLICY, minimumConfidence: Number.NaN,
  }), /Invalid video integrity input/);
});
