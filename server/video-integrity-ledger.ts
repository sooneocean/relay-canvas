/**
 * Video Integrity P0-b. Synchronous, single-writer, append-only sidecar journal.
 * Only locally registered media, verified by SHA-256 from actual bytes, may enter
 * anchor/candidate lineage. "verified" checkpoints require explicit operator
 * review; no client-supplied metric or LLM judgment can approve a segment.
 *
 * The current local session token is not a named reviewer identity.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from './graph.js';
import { atomicWrite } from './store.js';
import { CanvasService } from './service.js';
import type { Artifact, LocalAsset, Run, StoredExportJob } from '../src/shared/types.js';
import {
  validateAnchor, validateCandidate, validateCheckpoint,
  type IntegrityAnchor, type SegmentCandidate, type VerifiedCheckpoint,
} from '../src/shared/video-integrity.js';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[a-f0-9]{64}$/;
const LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_COMMITS = 4000;
const ZERO_HASH = '0'.repeat(64);
const idSchema = z.string().regex(ID);
const shaSchema = z.string().regex(HASH);
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const writeBase = { expectedRevision: revisionSchema, operationId: idSchema };
const anchorWriteSchema = z.object({ ...writeBase, artifactSha256: shaSchema }).strict();
const candidateWriteSchema = z.object({ ...writeBase, candidate: z.unknown() }).strict();
const reviewWriteSchema = z.object({
  ...writeBase, confirmReviewed: z.literal(true), reason: z.string().trim().min(8).max(500),
}).strict();
const rejectionWriteSchema = z.object({
  ...writeBase, reason: z.string().trim().min(8).max(500),
}).strict();

type JournalAction =
  | { type: 'anchor'; anchor: IntegrityAnchor }
  | { type: 'candidate'; candidate: SegmentCandidate }
  | { type: 'approve'; candidateId: string; checkpoint: VerifiedCheckpoint; reason: string; reviewMode: 'explicit_local_operator' }
  | { type: 'reject'; candidateId: string; reason: string };

interface JournalCommit {
  revision: number;
  boardId: string;
  operationId: string;
  requestSha256: string;
  previousSha256: string;
  committedAt: string;
  action: JournalAction;
  entrySha256: string;
}
interface Journal { schemaVersion: 1; commits: JournalCommit[] }
type CandidateStatus = 'proposed' | 'operator_approved' | 'rejected';
interface CandidateView { candidate: SegmentCandidate; status: CandidateStatus; submittedAt: string; reason?: string }
interface LedgerState {
  revision: number;
  anchors: Map<string, IntegrityAnchor>;
  candidates: Map<string, CandidateView>;
  checkpoints: Map<string, VerifiedCheckpoint>;
  operations: Map<string, JournalCommit>;
}
export interface IntegrityLedgerView {
  schemaVersion: 1;
  revision: number;
  boardId: string;
  anchors: IntegrityAnchor[];
  candidates: CandidateView[];
  checkpoints: VerifiedCheckpoint[];
}
export interface IntegrityWriteReceipt {
  revision: number;
  currentRevision: number;
  operationId: string;
  replayed: boolean;
  action: JournalAction;
}

function fail(code: string, message: string, status = 400): never {
  throw new AppError(code, message, status);
}
function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function assertRecord(value: unknown, keys: string[], name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(name);
  const props = Object.keys(value);
  if (props.length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new Error(name);
}
function id(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}
function sha(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value);
}
function validTime(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 64 &&
    /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
}
function initialState(): LedgerState {
  return { revision: 0, anchors: new Map(), candidates: new Map(), checkpoints: new Map(), operations: new Map() };
}
function applyAction(state: LedgerState, boardId: string, action: JournalAction): void {
  if (!id(boardId)) throw new Error('board identity');
  if (action.type === 'anchor') {
    assertRecord(action, ['type', 'anchor'], 'anchor action');
    validateAnchor(action.anchor);
    if (action.anchor.boardId !== boardId ||
      action.anchor.origin !== 'imported_original' ||
      action.anchor.approval.reviewerId !== 'local-session' ||
      state.anchors.has(action.anchor.id)) throw new Error('anchor invariant');
    state.anchors.set(action.anchor.id, action.anchor);
  } else if (action.type === 'candidate') {
    assertRecord(action, ['type', 'candidate'], 'candidate action');
    validateCandidate(action.candidate);
    const c = action.candidate;
    if (c.boardId !== boardId || state.candidates.has(c.id) || c.assessments.length || c.events.length ||
      c.anchorIds.some(anchorId => state.anchors.get(anchorId)?.boardId !== boardId)) throw new Error('candidate authority');
    if (c.parentCheckpointId) {
      const parent = state.checkpoints.get(c.parentCheckpointId);
      const parentSegment = parent && state.candidates.get(parent.segmentId)?.candidate;
      if (!parent || !parentSegment || parent.boardId !== boardId || parentSegment.endMs > c.startMs ||
        parent.artifactSha256 === c.artifactSha256) throw new Error('candidate parent');
    }
    state.candidates.set(c.id, { candidate: c, status: 'proposed', submittedAt: '' });
  } else if (action.type === 'approve') {
    assertRecord(action, ['type', 'candidateId', 'checkpoint', 'reason', 'reviewMode'], 'approval action');
    validateCheckpoint(action.checkpoint);
    const current = state.candidates.get(action.candidateId);
    if (!current || current.status !== 'proposed' || action.reviewMode !== 'explicit_local_operator' ||
      typeof action.reason !== 'string' || action.reason.trim().length < 8 || action.reason.length > 500 ||
      action.checkpoint.boardId !== boardId || action.checkpoint.segmentId !== action.candidateId ||
      action.checkpoint.artifactSha256 !== current.candidate.artifactSha256 ||
      state.checkpoints.has(action.checkpoint.id)) throw new Error('approval invariant');
    current.status = 'operator_approved'; current.reason = action.reason;
    state.checkpoints.set(action.checkpoint.id, action.checkpoint);
  } else if (action.type === 'reject') {
    assertRecord(action, ['type', 'candidateId', 'reason'], 'rejection action');
    const current = state.candidates.get(action.candidateId);
    if (!current || current.status !== 'proposed' || typeof action.reason !== 'string' ||
      action.reason.trim().length < 8 || action.reason.length > 500) throw new Error('rejection invariant');
    current.status = 'rejected'; current.reason = action.reason;
  } else {
    throw new Error('unknown journal action');
  }
}
function rebuild(journal: Journal): LedgerState {
  const state = initialState();
  let previousSha256 = ZERO_HASH;
  for (const commit of journal.commits) {
    assertRecord(commit, ['revision', 'boardId', 'operationId', 'requestSha256', 'previousSha256', 'committedAt', 'action', 'entrySha256'], 'commit shape');
    if (!id(commit.boardId) || !id(commit.operationId) || !sha(commit.requestSha256) ||
      !validTime(commit.committedAt) || commit.revision !== state.revision + 1 ||
      commit.previousSha256 !== previousSha256 || state.operations.has(commit.operationId) ||
      !sha(commit.entrySha256)) throw new Error('journal commit metadata');
    const { entrySha256, ...unsigned } = commit;
    if (hashValue(unsigned) !== entrySha256) throw new Error('journal hash chain');
    applyAction(state, commit.boardId, commit.action);
    if (commit.action.type === 'candidate') {
      state.candidates.get(commit.action.candidate.id)!.submittedAt = commit.committedAt;
    }
    state.revision = commit.revision;
    state.operations.set(commit.operationId, commit);
    previousSha256 = entrySha256;
  }
  return state;
}
function isLocalMatch(artifact: Artifact, digest: string, kind?: 'image' | 'video'): boolean {
  return artifact.localId === digest && artifact.sha256 === digest &&
    artifact.localUrl === '/api/media/' + digest && artifact.url === artifact.localUrl &&
    (kind === undefined || artifact.kind === kind);
}

export class VideoIntegrityLedger {
  readonly file: string;
  constructor(private readonly service: CanvasService) {
    this.file = path.join(service.store.directory, 'video-integrity.json');
  }

  private load(): { journal: Journal; state: LedgerState } {
    if (!existsSync(this.file)) {
      const journal: Journal = { schemaVersion: 1, commits: [] };
      return { journal, state: initialState() };
    }
    let raw: Buffer;
    try {
      const metadata = lstatSync(this.file);
      if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600 ||
        metadata.size < 1 || metadata.size > LIMIT_BYTES) throw new Error('unsafe ledger');
      const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino ||
          opened.size !== metadata.size || (opened.mode & 0o777) !== 0o600) throw new Error('ledger changed');
        raw = readFileSync(fd);
      } finally { closeSync(fd); }
    } catch {
      fail('VIDEO_LEDGER_UNSAFE', 'Video integrity ledger cannot be read safely.', 500);
    }
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      assertRecord(parsed, ['schemaVersion', 'commits'], 'journal shape');
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.commits) || parsed.commits.length > MAX_COMMITS) throw new Error('journal limit');
      const journal = parsed as unknown as Journal;
      return { journal, state: rebuild(journal) };
    } catch {
      fail('VIDEO_LEDGER_CORRUPT', 'Video integrity journal failed validation; original preserved.', 500);
    }
  }

  private assertBoard(boardId: string): void {
    if (!id(boardId)) fail('INVALID_VIDEO_BOARD', 'Invalid board ID.');
    this.service.board(boardId);
  }

  private findMedia(boardId: string, digest: string, kind?: 'image' | 'video', importedOnly = false): Artifact {
    if (!sha(digest)) fail('INVALID_VIDEO_MEDIA', 'Invalid media hash.');
    const workspace = this.service.store.read();
    const imported = (workspace.localAssets ?? []).find(
      (asset: LocalAsset) => asset.boardId === boardId && isLocalMatch(asset.artifact, digest, kind),
    )?.artifact;
    let artifact: Artifact | undefined = imported;
    if (!artifact && !importedOnly) {
      for (const run of workspace.runs as Run[]) {
        if (run.boardId !== boardId || run.status !== 'succeeded') continue;
        for (const result of Object.values(run.results)) {
          if (result.status !== 'succeeded') continue;
          artifact = result.artifacts.find(media => isLocalMatch(media, digest, kind));
          if (artifact) break;
        }
        if (artifact) break;
      }
      artifact ??= (workspace.exports ?? []).find((job: StoredExportJob) =>
        job.boardId === boardId && job.status === 'succeeded' &&
        job.artifact !== undefined && isLocalMatch(job.artifact, digest, kind))?.artifact;
    }
    if (!artifact) fail('VIDEO_MEDIA_NOT_OWNED', 'Media must be saved and registered on this board.', 404);
    try { return this.service.media.verifyArtifact(artifact); }
    catch { fail('VIDEO_MEDIA_UNVERIFIED', 'Media bytes or digest could not be verified.', 409); }
  }

  view(boardId: string): IntegrityLedgerView {
    this.assertBoard(boardId);
    const { state } = this.load();
    return {
      schemaVersion: 1, revision: state.revision, boardId,
      anchors: [...state.anchors.values()].filter(value => value.boardId === boardId),
      candidates: [...state.candidates.values()].filter(value => value.candidate.boardId === boardId),
      checkpoints: [...state.checkpoints.values()].filter(value => value.boardId === boardId),
    };
  }

  private replayOrNext(operationId: string, requestSha256: string, expectedRevision: number) {
    const { journal, state } = this.load();
    const prior = state.operations.get(operationId);
    if (prior) {
      if (prior.requestSha256 !== requestSha256) fail('VIDEO_OPERATION_CONFLICT', 'Operation ID has different content.', 409);
      return { replay: prior, journal, state };
    }
    if (state.revision !== expectedRevision) fail('VIDEO_REVISION_CONFLICT', 'Video ledger changed; reload before writing.', 409);
    return { journal, state };
  }

  private commit(journal: Journal, state: LedgerState, boardId: string, operationId: string,
    requestSha256: string, action: JournalAction): IntegrityWriteReceipt {
    const committedAt = new Date().toISOString();
    const unsigned = {
      revision: state.revision + 1, boardId, operationId, requestSha256,
      previousSha256: journal.commits.at(-1)?.entrySha256 ?? ZERO_HASH,
      committedAt, action,
    };
    const commit: JournalCommit = { ...unsigned, entrySha256: hashValue(unsigned) };
    // Validate the complete updated journal before touching durable state.
    const updated: Journal = { schemaVersion: 1, commits: [...journal.commits, commit] };
    if (updated.commits.length > MAX_COMMITS || Buffer.byteLength(JSON.stringify(updated)) > LIMIT_BYTES) {
      fail('VIDEO_LEDGER_LIMIT', 'Video integrity journal capacity reached.', 409);
    }
    try { rebuild(updated); } catch { fail('INVALID_VIDEO_LINEAGE', 'Video lineage validation failed.', 409); }
    try { atomicWrite(this.file, updated); }
    catch { fail('VIDEO_LEDGER_WRITE_FAILED', 'Could not persist video integrity journal.', 500); }
    return { revision: commit.revision, currentRevision: commit.revision, operationId, replayed: false, action };
  }

  private receipt(prior: JournalCommit, currentRevision: number): IntegrityWriteReceipt {
    return {
      revision: prior.revision, currentRevision, operationId: prior.operationId,
      replayed: true, action: prior.action,
    };
  }

  registerAnchor(boardId: string, input: unknown): IntegrityWriteReceipt {
    this.assertBoard(boardId);
    const parsed = anchorWriteSchema.safeParse(input);
    if (!parsed.success) fail('INVALID_VIDEO_INPUT', 'Invalid anchor request.');
    const requestSha = hashValue({ type: 'anchor', boardId, ...parsed.data });
    const { journal, state, replay } = this.replayOrNext(parsed.data.operationId, requestSha, parsed.data.expectedRevision);
    if (replay) return this.receipt(replay, state.revision);
    const artifact = this.findMedia(boardId, parsed.data.artifactSha256, undefined, true);
    const anchor: IntegrityAnchor = {
      schemaVersion: 1, id: parsed.data.operationId, boardId, artifactSha256: artifact.sha256!,
      kind: artifact.kind, origin: 'imported_original',
      approval: { reviewerId: 'local-session', approvedAt: new Date().toISOString() },
    };
    return this.commit(journal, state, boardId, parsed.data.operationId, requestSha, { type: 'anchor', anchor });
  }

  registerCandidate(boardId: string, input: unknown): IntegrityWriteReceipt {
    this.assertBoard(boardId);
    const parsed = candidateWriteSchema.safeParse(input);
    if (!parsed.success) fail('INVALID_VIDEO_INPUT', 'Invalid candidate request.');
    const c = parsed.data.candidate as SegmentCandidate;
    try { validateCandidate(c); }
    catch { fail('INVALID_VIDEO_INPUT', 'Invalid candidate manifest.'); }
    if (c.boardId !== boardId || c.assessments.length !== 0 || c.events.length !== 0) {
      fail('INVALID_VIDEO_INPUT', 'Only unscored local candidates can be registered.');
    }
    const requestSha = hashValue({ type: 'candidate', boardId, ...parsed.data });
    const { journal, state, replay } = this.replayOrNext(parsed.data.operationId, requestSha, parsed.data.expectedRevision);
    if (replay) return this.receipt(replay, state.revision);
    this.findMedia(boardId, c.artifactSha256, 'video');
    for (const anchorId of c.anchorIds) {
      const anchor = state.anchors.get(anchorId);
      if (!anchor || anchor.boardId !== boardId) fail('VIDEO_ANCHOR_NOT_FOUND', 'Trusted anchor not found on this board.', 409);
      this.findMedia(boardId, anchor.artifactSha256, anchor.kind, true);
    }
    if (c.parentCheckpointId) {
      const checkpoint = state.checkpoints.get(c.parentCheckpointId);
      if (!checkpoint || checkpoint.boardId !== boardId) fail('VIDEO_PARENT_NOT_VERIFIED', 'Parent checkpoint is not verified.', 409);
      this.findMedia(boardId, checkpoint.artifactSha256, 'video');
    }
    return this.commit(journal, state, boardId, parsed.data.operationId, requestSha, { type: 'candidate', candidate: c });
  }

  approveCandidate(boardId: string, candidateId: string, input: unknown): IntegrityWriteReceipt {
    this.assertBoard(boardId);
    if (!id(candidateId)) fail('INVALID_VIDEO_INPUT', 'Invalid candidate ID.');
    const parsed = reviewWriteSchema.safeParse(input);
    if (!parsed.success) fail('VIDEO_REVIEW_REQUIRED', 'Explicit local operator review is required.', 400);
    const requestSha = hashValue({ type: 'approve', boardId, candidateId, ...parsed.data });
    const { journal, state, replay } = this.replayOrNext(parsed.data.operationId, requestSha, parsed.data.expectedRevision);
    if (replay) return this.receipt(replay, state.revision);
    const registered = state.candidates.get(candidateId);
    if (!registered || registered.candidate.boardId !== boardId || registered.status !== 'proposed') {
      fail('VIDEO_CANDIDATE_NOT_PENDING', 'Candidate was not found or is already reviewed.', 409);
    }
    const c = registered.candidate;
    this.findMedia(boardId, c.artifactSha256, 'video');
    for (const anchorId of c.anchorIds) {
      const anchor = state.anchors.get(anchorId);
      if (!anchor) fail('VIDEO_ANCHOR_NOT_FOUND', 'Anchor is missing.', 409);
      this.findMedia(boardId, anchor.artifactSha256, anchor.kind, true);
    }
    if (c.parentCheckpointId) {
      const parent = state.checkpoints.get(c.parentCheckpointId);
      if (!parent || parent.boardId !== boardId) fail('VIDEO_PARENT_NOT_VERIFIED', 'Parent checkpoint invalid.', 409);
      this.findMedia(boardId, parent.artifactSha256, 'video');
    }
    const checkpoint: VerifiedCheckpoint = {
      schemaVersion: 1, id: parsed.data.operationId, boardId, segmentId: c.id,
      artifactSha256: c.artifactSha256, status: 'verified', verifiedAt: new Date().toISOString(),
    };
    return this.commit(journal, state, boardId, parsed.data.operationId, requestSha, {
      type: 'approve', candidateId, checkpoint, reason: parsed.data.reason,
      reviewMode: 'explicit_local_operator',
    });
  }

  rejectCandidate(boardId: string, candidateId: string, input: unknown): IntegrityWriteReceipt {
    this.assertBoard(boardId);
    if (!id(candidateId)) fail('INVALID_VIDEO_INPUT', 'Invalid candidate ID.');
    const parsed = rejectionWriteSchema.safeParse(input);
    if (!parsed.success) fail('INVALID_VIDEO_INPUT', 'Invalid rejection request.');
    const requestSha = hashValue({ type: 'reject', boardId, candidateId, ...parsed.data });
    const { journal, state, replay } = this.replayOrNext(parsed.data.operationId, requestSha, parsed.data.expectedRevision);
    if (replay) return this.receipt(replay, state.revision);
    const registered = state.candidates.get(candidateId);
    if (!registered || registered.candidate.boardId !== boardId || registered.status !== 'proposed') {
      fail('VIDEO_CANDIDATE_NOT_PENDING', 'Candidate was not found or is already reviewed.', 409);
    }
    return this.commit(journal, state, boardId, parsed.data.operationId, requestSha, {
      type: 'reject', candidateId, reason: parsed.data.reason,
    });
  }
}
