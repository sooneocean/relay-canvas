/**
 * Read-only verification boundary for opt-in controlled AI-video continuation.
 *
 * The preflight is deliberately NOT a generation permission, capability token,
 * scorer attestation, or proof that human quality review occurred. A future
 * paid dispatch MUST repeat the check against the same authoritative ledger
 * and media bytes immediately before sending any request to a provider.
 */
import { z } from 'zod';
import { AppError } from './graph.js';
import { VideoIntegrityLedger } from './video-integrity-ledger.js';

const safeId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const timeMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const continuationInputSchema = z.object({
  expectedLedgerRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  parentCheckpointId: safeId,
  anchorIds: z.array(safeId).min(1).max(16),
  mode: z.enum(['continue', 'rollback_branch']),
  startMs: timeMs,
  endMs: timeMs,
}).strict().superRefine((value, ctx) => {
  if (value.endMs <= value.startMs || value.endMs - value.startMs > 60_000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid continuation duration.' });
  }
  if (new Set(value.anchorIds).size !== value.anchorIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate anchors.' });
  }
});

export type ControlledContinuationMode = 'continue' | 'rollback_branch';
export interface ContinuationPreflight {
  schemaVersion: 1;
  boardId: string;
  ledgerRevision: number;
  mode: ControlledContinuationMode;
  status: 'preflight_only';
  parent: {
    checkpointId: string;
    segmentId: string;
    artifactSha256: string;
    endMs: number;
    reviewSource: 'explicit_local_operator';
  };
  anchors: Array<{
    id: string;
    artifactSha256: string;
    kind: 'image' | 'video';
  }>;
  nextSegment: { startMs: number; endMs: number };
  recheckRequiredAtDispatch: true;
  generationStarted: false;
  visualQualityVerified: false;
  approvalIsNamedHuman: false;
}

function fail(code: string, status = 409): never {
  throw new AppError(code, 'Controlled continuation source did not pass the verification boundary.', status);
}

function equalSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(id => right.includes(id));
}

export class VerifiedContinuationGate {
  constructor(private readonly ledger: VideoIntegrityLedger) {}

  preflight(boardId: string, input: unknown): ContinuationPreflight {
    const parsed = continuationInputSchema.safeParse(input);
    if (!parsed.success) fail('INVALID_CONTINUATION_INPUT', 400);
    const request = parsed.data;
    const view = this.ledger.view(boardId);

    if (view.revision !== request.expectedLedgerRevision) fail('CONTINUATION_STALE_LEDGER');

    // Require a real, committed checkpoint, never a proposed/rejected segment.
    const checkpoint = view.checkpoints.find(item => item.id === request.parentCheckpointId);
    if (!checkpoint || checkpoint.boardId !== boardId || checkpoint.status !== 'verified') {
      fail('CONTINUATION_PARENT_NOT_VERIFIED');
    }
    const entry = view.candidates.find(item => item.candidate.id === checkpoint.segmentId);
    if (!entry || entry.status !== 'operator_approved' ||
      entry.candidate.boardId !== boardId ||
      entry.candidate.artifactSha256 !== checkpoint.artifactSha256) {
      fail('CONTINUATION_PARENT_NOT_VERIFIED');
    }

    // Ordinary continuation must use the newest approved checkpoint; branching
    // from an earlier approved checkpoint requires explicit rollback_branch.
    const latest = view.checkpoints.at(-1);
    if (request.mode === 'continue' && latest?.id !== checkpoint.id) {
      fail('CONTINUATION_REQUIRES_LATEST');
    }

    // No implicit scene-reference substitutions, omissions, or cross-board refs.
    if (!equalSet(request.anchorIds, entry.candidate.anchorIds)) {
      fail('CONTINUATION_ANCHOR_SET_CHANGED');
    }
    if (request.startMs !== entry.candidate.endMs) {
      fail('CONTINUATION_TIME_DISCONTINUITY');
    }
    const anchors = request.anchorIds.map(id => {
      const anchor = view.anchors.find(value => value.id === id && value.boardId === boardId);
      if (!anchor) fail('CONTINUATION_ANCHOR_NOT_VERIFIED');
      return { id: anchor.id, artifactSha256: anchor.artifactSha256, kind: anchor.kind };
    });

    // All lookups below re-hash actual local media, including the source
    // candidate, referenced anchors and its older verified parent lineage.
    const verifiedSource = this.ledger.analysisSource(boardId, checkpoint.segmentId);
    if (verifiedSource.candidate.id !== entry.candidate.id ||
      verifiedSource.artifact.sha256 !== checkpoint.artifactSha256) {
      fail('CONTINUATION_SOURCE_CHANGED');
    }

    return {
      schemaVersion: 1,
      boardId,
      ledgerRevision: view.revision,
      mode: request.mode,
      status: 'preflight_only',
      parent: {
        checkpointId: checkpoint.id, segmentId: checkpoint.segmentId,
        artifactSha256: checkpoint.artifactSha256,
        endMs: entry.candidate.endMs,
        reviewSource: 'explicit_local_operator',
      },
      anchors,
      nextSegment: { startMs: request.startMs, endMs: request.endMs },
      recheckRequiredAtDispatch: true,
      generationStarted: false,
      visualQualityVerified: false,
      approvalIsNamedHuman: false,
    };
  }
}
