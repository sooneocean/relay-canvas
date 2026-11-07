/**
 * ReachFlow video integrity P0: pure, provider-independent, fail-closed review policy.
 *
 * This module does not generate media, call paid providers, inspect image bytes,
 * assert that a detector is trustworthy, or persist authoritative approvals.
 * Only trusted server code may create anchor/checkpoint records from verified media.
 */

export type DriftType =
  | 'identity' | 'scene_geometry' | 'semantic' | 'motion'
  | 'local_geometry' | 'color' | 'compression';
export type QualityMetric = 'subject' | 'background' | 'temporal' | 'semantic' | 'imaging';
export type RepairAction =
  | 'accept' | 'manual_review' | 'restore' | 'local_inpaint'
  | 'regenerate_segment' | 'rollback_and_regenerate';
export type DecisionReason =
  | 'PASSED' | 'UNVERIFIED_ANCHOR' | 'MISSING_PARENT' | 'UNVERIFIED_PARENT'
  | 'INCOMPLETE_METRICS' | 'LOW_CONFIDENCE' | 'BELOW_THRESHOLD'
  | 'DRIFT_DETECTED' | 'NO_REPAIR_DIAGNOSIS';

export interface IntegrityAnchor {
  schemaVersion: 1;
  id: string;
  boardId: string;
  artifactSha256: string;
  kind: 'image' | 'video';
  origin: 'imported_original' | 'human_approved_generation';
  approval: { reviewerId: string; approvedAt: string };
}
export interface VerifiedCheckpoint {
  schemaVersion: 1;
  id: string;
  boardId: string;
  segmentId: string;
  artifactSha256: string;
  status: 'verified';
  verifiedAt: string;
}
export interface MetricAssessment {
  metric: QualityMetric;
  score: number;
  confidence: number;
  scorerId: string;
}
export interface DriftEvent {
  type: DriftType;
  confidence: number;
  affectedFraction: number;
  startMs: number;
  endMs: number;
  persistsAcrossSegments: boolean;
}
export interface SegmentCandidate {
  schemaVersion: 1;
  id: string;
  boardId: string;
  artifactSha256: string;
  promptSha256: string;
  modelId: string;
  anchorIds: string[];
  parentCheckpointId?: string;
  startMs: number;
  endMs: number;
  assessments: MetricAssessment[];
  events: DriftEvent[];
}
export interface IntegrityPolicy {
  requiredMetrics: readonly QualityMetric[];
  minimumScores: Readonly<Record<QualityMetric, number>>;
  minimumConfidence: number;
  maximumLocalRepairFraction: number;
}
export interface IntegrityDecision {
  candidateId: string;
  action: RepairAction;
  reason: DecisionReason;
  failedMetrics: QualityMetric[];
  checkpointId?: string;
  driftTypes: DriftType[];
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const METRICS: readonly QualityMetric[] = ['subject', 'background', 'temporal', 'semantic', 'imaging'];
const DRIFT_TYPES: readonly DriftType[] = ['identity', 'scene_geometry', 'semantic', 'motion', 'local_geometry', 'color', 'compression'];

/** Defaults are conservative starter thresholds, not scientifically calibrated. */
export const DEFAULT_INTEGRITY_POLICY: IntegrityPolicy = Object.freeze({
  requiredMetrics: Object.freeze([...METRICS]),
  minimumScores: Object.freeze({ subject: 0.80, background: 0.80, temporal: 0.80, semantic: 0.80, imaging: 0.75 }),
  minimumConfidence: 0.80,
  maximumLocalRepairFraction: 0.25,
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error('Invalid video integrity input: ' + message);
}
function id(value: unknown, name: string): asserts value is string {
  assert(typeof value === 'string' && ID.test(value), name);
}
function sha(value: unknown, name: string): asserts value is string {
  assert(typeof value === 'string' && SHA256.test(value), name);
}
function ms(value: unknown, name: string): asserts value is number {
  assert(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, name);
}
function ratio(value: unknown, name: string): asserts value is number {
  assert(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1, name);
}
function iso(value: unknown, name: string) {
  assert(typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d\d:\d\d)$/.test(value), name);
}
function keys(value: unknown, required: readonly string[], optional: readonly string[], name: string): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), name);
  const record = value as Record<string, unknown>;
  assert(required.every(key => Object.hasOwn(record, key)), name + '.required');
  assert(Object.keys(record).every(key => required.includes(key) || optional.includes(key)), name + '.unknown_key');
}
function unique(values: readonly string[], name: string) {
  assert(new Set(values).size === values.length, name + '.duplicate');
}
export function validateAnchor(value: IntegrityAnchor): void {
  keys(value, ['schemaVersion', 'id', 'boardId', 'artifactSha256', 'kind', 'origin', 'approval'], [], 'anchor');
  assert(value.schemaVersion === 1, 'anchor.schemaVersion');
  id(value.id, 'anchor.id'); id(value.boardId, 'anchor.boardId'); sha(value.artifactSha256, 'anchor.sha256');
  assert(value.kind === 'image' || value.kind === 'video', 'anchor.kind');
  assert(value.origin === 'imported_original' || value.origin === 'human_approved_generation', 'anchor.origin');
  keys(value.approval, ['reviewerId', 'approvedAt'], [], 'anchor.approval');
  id(value.approval.reviewerId, 'anchor.reviewerId'); iso(value.approval.approvedAt, 'anchor.approvedAt');
}
export function validateCheckpoint(value: VerifiedCheckpoint): void {
  keys(value, ['schemaVersion', 'id', 'boardId', 'segmentId', 'artifactSha256', 'status', 'verifiedAt'], [], 'checkpoint');
  assert(value.schemaVersion === 1 && value.status === 'verified', 'checkpoint.status');
  id(value.id, 'checkpoint.id'); id(value.boardId, 'checkpoint.boardId'); id(value.segmentId, 'checkpoint.segmentId');
  sha(value.artifactSha256, 'checkpoint.sha256'); iso(value.verifiedAt, 'checkpoint.verifiedAt');
}
export function validateCandidate(value: SegmentCandidate): void {
  keys(value, ['schemaVersion', 'id', 'boardId', 'artifactSha256', 'promptSha256', 'modelId', 'anchorIds', 'startMs', 'endMs', 'assessments', 'events'], ['parentCheckpointId'], 'candidate');
  assert(value.schemaVersion === 1, 'candidate.schemaVersion');
  id(value.id, 'candidate.id'); id(value.boardId, 'candidate.boardId');
  sha(value.artifactSha256, 'candidate.sha256'); sha(value.promptSha256, 'candidate.promptSha256');
  assert(typeof value.modelId === 'string' && value.modelId.length > 0 && value.modelId.length <= 200, 'candidate.modelId');
  assert(Array.isArray(value.anchorIds) && value.anchorIds.length >= 1 && value.anchorIds.length <= 16, 'candidate.anchorIds');
  value.anchorIds.forEach(v => id(v, 'candidate.anchorId')); unique(value.anchorIds, 'candidate.anchorIds');
  if (value.parentCheckpointId !== undefined) id(value.parentCheckpointId, 'candidate.parentCheckpointId');
  ms(value.startMs, 'candidate.startMs'); ms(value.endMs, 'candidate.endMs');
  assert(value.endMs > value.startMs && value.endMs - value.startMs <= 60_000, 'candidate.time_range');
  assert(Array.isArray(value.assessments) && value.assessments.length <= METRICS.length, 'candidate.assessments');
  value.assessments.forEach(a => {
    keys(a, ['metric', 'score', 'confidence', 'scorerId'], [], 'assessment');
    assert(METRICS.includes(a.metric), 'assessment.metric'); ratio(a.score, 'assessment.score'); ratio(a.confidence, 'assessment.confidence');
    assert(typeof a.scorerId === 'string' && a.scorerId.length >= 1 && a.scorerId.length <= 120, 'assessment.scorerId');
  });
  unique(value.assessments.map(a => a.metric), 'candidate.assessments');
  assert(Array.isArray(value.events) && value.events.length <= 64, 'candidate.events');
  value.events.forEach(e => {
    keys(e, ['type', 'confidence', 'affectedFraction', 'startMs', 'endMs', 'persistsAcrossSegments'], [], 'event');
    assert(DRIFT_TYPES.includes(e.type), 'event.type'); ratio(e.confidence, 'event.confidence'); ratio(e.affectedFraction, 'event.affectedFraction');
    ms(e.startMs, 'event.startMs'); ms(e.endMs, 'event.endMs');
    assert(e.endMs > e.startMs && e.startMs >= value.startMs && e.endMs <= value.endMs, 'event.time_range');
    assert(typeof e.persistsAcrossSegments === 'boolean', 'event.persistsAcrossSegments');
  });
}
function validatePolicy(policy: IntegrityPolicy) {
  assert(Array.isArray(policy.requiredMetrics) && policy.requiredMetrics.length > 0, 'policy.requiredMetrics');
  policy.requiredMetrics.forEach(m => assert(METRICS.includes(m), 'policy.metric'));
  unique(policy.requiredMetrics, 'policy.requiredMetrics');
  METRICS.forEach(m => ratio(policy.minimumScores[m], 'policy.threshold.' + m));
  ratio(policy.minimumConfidence, 'policy.minimumConfidence');
  ratio(policy.maximumLocalRepairFraction, 'policy.maximumLocalRepairFraction');
}
function result(candidate: SegmentCandidate, action: RepairAction, reason: DecisionReason, failedMetrics: QualityMetric[] = [], checkpointId?: string): IntegrityDecision {
  return {
    candidateId: candidate.id, action, reason, failedMetrics,
    ...(checkpointId ? { checkpointId } : {}),
    driftTypes: [...new Set(candidate.events.map(e => e.type))],
  };
}

/**
 * Deterministic planner. Scores are supplied by external scorers; no claim of
 * actual visual validation is made here. A trusted caller must verify that
 * anchor hashes, scorer identities and checkpoint records reflect real assets.
 */
export function evaluateVideoIntegrity(
  candidate: SegmentCandidate,
  anchors: readonly IntegrityAnchor[],
  checkpoint: VerifiedCheckpoint | undefined,
  policy: IntegrityPolicy = DEFAULT_INTEGRITY_POLICY,
): IntegrityDecision {
  validateCandidate(candidate); validatePolicy(policy);
  assert(Array.isArray(anchors) && anchors.length <= 16, 'anchors');
  anchors.forEach(validateAnchor);
  unique(anchors.map(a => a.id), 'anchors');
  if (checkpoint) validateCheckpoint(checkpoint);

  const referenced = new Map(anchors.map(a => [a.id, a]));
  if (candidate.anchorIds.some(anchorId => referenced.get(anchorId)?.boardId !== candidate.boardId)) {
    return result(candidate, 'manual_review', 'UNVERIFIED_ANCHOR');
  }
  if (candidate.parentCheckpointId && (!checkpoint || checkpoint.id !== candidate.parentCheckpointId)) {
    return result(candidate, 'manual_review', 'MISSING_PARENT');
  }
  if (checkpoint && (!candidate.parentCheckpointId || checkpoint.boardId !== candidate.boardId || checkpoint.segmentId === candidate.id)) {
    return result(candidate, 'manual_review', 'UNVERIFIED_PARENT');
  }
  const scores = new Map(candidate.assessments.map(a => [a.metric, a]));
  if (policy.requiredMetrics.some(metric => !scores.has(metric))) {
    return result(candidate, 'manual_review', 'INCOMPLETE_METRICS');
  }
  if (candidate.assessments.some(a => a.confidence < policy.minimumConfidence)
      || candidate.events.some(e => e.confidence < policy.minimumConfidence)) {
    return result(candidate, 'manual_review', 'LOW_CONFIDENCE');
  }
  const failedMetrics = policy.requiredMetrics.filter(metric => scores.get(metric)!.score < policy.minimumScores[metric]);
  if (failedMetrics.length === 0 && candidate.events.length === 0) {
    return result(candidate, 'accept', 'PASSED');
  }
  if (candidate.events.length === 0) {
    return result(candidate, 'manual_review', 'NO_REPAIR_DIAGNOSIS', failedMetrics);
  }
  const events = candidate.events;
  const requiresRollback = events.some(e => e.persistsAcrossSegments || ['identity', 'scene_geometry', 'semantic'].includes(e.type));
  if (requiresRollback) {
    const action: RepairAction = checkpoint ? 'rollback_and_regenerate' : 'regenerate_segment';
    return result(candidate, action, 'DRIFT_DETECTED', failedMetrics, checkpoint?.id);
  }
  if (events.some(e => e.type === 'motion')) return result(candidate, 'regenerate_segment', 'DRIFT_DETECTED', failedMetrics);
  if (events.some(e => e.type === 'local_geometry')) {
    const localOnly = events.every(e => e.type === 'local_geometry' && e.affectedFraction <= policy.maximumLocalRepairFraction);
    return result(candidate, localOnly ? 'local_inpaint' : 'regenerate_segment', 'DRIFT_DETECTED', failedMetrics);
  }
  if (events.every(e => e.type === 'color' || e.type === 'compression')) return result(candidate, 'restore', 'DRIFT_DETECTED', failedMetrics);
  return result(candidate, 'manual_review', 'NO_REPAIR_DIAGNOSIS', failedMetrics);
}
