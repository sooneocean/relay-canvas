/**
 * DE-X SR (user-defined reference-conditioned precision restoration) P0.
 * This is a read-only and fail-closed planning API. It NEVER starts Python,
 * charges providers, creates frames, or declares original identity verified.
 *
 * An actual runtime executor must independently verify the exact media bytes
 * again and use sandboxed content-addressed staging, not user file paths.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from './graph.js';
import { CanvasService } from './service.js';
import type { Artifact } from '../src/shared/types.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const roles = z.enum(['identity', 'detail', 'scene', 'color']);
const source = z.object({ artifactSha256: sha }).strict();
const planInput = z.object({
  schemaVersion: z.literal(1),
  currentVideo: source,
  previousSegment: source.optional(),
  originals: z.array(z.object({
    artifactSha256: sha,
    role: roles,
  }).strict()).min(1).max(8),
  prompt: z.string().max(1200),
  temporalRadius: z.number().int().min(0).max(2).default(2),
  targetHeight: z.literal(1080),
}).strict().superRefine((value, ctx) => {
  const all = value.originals.map(ref => ref.artifactSha256);
  if (new Set(all).size !== all.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate image reference' });
  if (value.previousSegment && value.previousSegment.artifactSha256 === value.currentVideo.artifactSha256) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'previous and current media must differ' });
  }
  if (value.previousSegment && value.temporalRadius === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'segment history needs temporal radius' });
  }
});

type Role = z.infer<typeof roles>;
export interface DexSrPlan {
  schemaVersion: 1;
  status: 'plan_only';
  boardId: string;
  mode: 'non_generative_precision_restoration';
  current: { sha256: string; kind: 'video'; width: number; height: number; duration: number };
  previousSegment?: { sha256: string; kind: 'video'; width: number; height: number; duration: number };
  originals: Array<{
    sha256: string; role: Role; provenance: 'user_imported_not_identity_verified';
    pixelTransfer: 'same_view_match_only' | 'disabled';
  }>;
  promptPolicy: {
    promptSha256: string;
    intent: 'strict_fidelity' | 'grain_preserving' | 'conservative';
    temporalStrength: number;
    referenceStrength: number;
    allowGeneration: false;
    identityLock: true;
  };
  processing: { targetHeight: 1080; temporalRadius: number; acceptsVideoContextNotJpeg: true };
  currentSourceVerified: true;
  colorAndCfrValidation: 'deferred_to_worker';
  referenceGeometryMatching: 'deferred_to_worker';
  runnable: false;
}

function fail(code: string, message: string, status = 400): never {
  throw new AppError(code, message, status);
}
function promptPolicy(text: string): DexSrPlan['promptPolicy'] {
  const lowered = text.toLowerCase();
  const strict = ['保真','保持五官','不改五官','維持人臉','preserve identity',
    'identity lock','original likeness','strict','不要生成'].some(keyword => lowered.includes(keyword));
  const grain = ['保留顆粒','preserve grain','grain intact'].some(keyword => lowered.includes(keyword));
  return {
    promptSha256: createHash('sha256').update(text).digest('hex'),
    intent: strict ? 'strict_fidelity' : grain ? 'grain_preserving' : 'conservative',
    temporalStrength: grain ? 0.15 : strict ? 0.30 : 0.45,
    referenceStrength: strict ? 0.25 : 0.30,
    allowGeneration: false, identityLock: true,
  };
}

export class DexSrPlanner {
  constructor(private readonly service: CanvasService) {}

  verifiedMedia(boardId: string, digest: string, kind: 'video' | 'image',
    importedOnly: boolean): Artifact {
    const workspace = this.service.store.read();
    const matches = (art: Artifact | undefined) =>
      art?.kind === kind && art.localId === digest &&
      art.sha256 === digest && art.localUrl === '/api/media/' + digest &&
      art.mimeType !== undefined;
    let artifact = workspace.localAssets?.find(entry =>
      entry.boardId === boardId && matches(entry.artifact))?.artifact;
    if (!artifact && !importedOnly) {
      for (const run of workspace.runs) {
        if (run.boardId !== boardId || run.status !== 'succeeded') continue;
        for (const result of Object.values(run.results)) {
          if (result.status !== 'succeeded') continue;
          artifact = result.artifacts.find(art => matches(art));
          if (artifact) break;
        }
        if (artifact) break;
      }
      artifact ??= workspace.exports?.find(job =>
        job.boardId === boardId && job.status === 'succeeded' &&
        matches(job.artifact))?.artifact;
    }
    if (!artifact) fail('DEX_SR_MEDIA_NOT_OWNED', 'No verified local source of this type belongs to the board.', 404);
    try { return this.service.media.verifyArtifact(artifact); }
    catch { fail('DEX_SR_SOURCE_TAMPERED', 'Saved asset no longer matches its SHA-256.', 409); }
  }

  async plan(boardId: string, input: unknown): Promise<DexSrPlan> {
    this.service.board(boardId);
    const parsed = planInput.safeParse(input);
    if (!parsed.success) fail('DEX_SR_INVALID_INPUT', 'Invalid DE-X SR reference bundle.');
    const request = parsed.data;
    const current = this.verifiedMedia(boardId, request.currentVideo.artifactSha256, 'video', false);
    const previous = request.previousSegment
      ? this.verifiedMedia(boardId, request.previousSegment.artifactSha256, 'video', false)
      : undefined;
    const references = request.originals.map(item => ({
      ref: item,
      artifact: this.verifiedMedia(boardId, item.artifactSha256, 'image', true),
    }));
    let currentInfo;
    let previousInfo;
    try {
      currentInfo = await this.service.editor.probe(current);
      if (previous) previousInfo = await this.service.editor.probe(previous);
    } catch {
      fail('DEX_SR_INVALID_VIDEO', 'Cannot probe a saved video input.', 422);
    }
    if (currentInfo.duration < 1 || currentInfo.duration > 30 ||
        currentInfo.width * currentInfo.height > 1280 * 720 ||
        Math.min(currentInfo.width, currentInfo.height) < 64 ||
        (previousInfo && (previousInfo.duration < 1 || previousInfo.duration > 8 ||
         previousInfo.width !== currentInfo.width || previousInfo.height !== currentInfo.height))) {
      fail('DEX_SR_UNSUPPORTED_CLIP', 'Input clips must meet the preservation worker limits.', 422);
    }
    return {
      schemaVersion: 1, status: 'plan_only', boardId,
      mode: 'non_generative_precision_restoration',
      current: {
        sha256: current.sha256!, kind: 'video',
        width: currentInfo.width, height: currentInfo.height,
        duration: currentInfo.duration,
      },
      ...(previous && previousInfo ? { previousSegment: {
        sha256: previous.sha256!, kind: 'video' as const,
        width: previousInfo.width, height: previousInfo.height,
        duration: previousInfo.duration,
      } } : {}),
      originals: references.map(({ ref, artifact }) => ({
        sha256: artifact.sha256!, role: ref.role,
        provenance: 'user_imported_not_identity_verified' as const,
        pixelTransfer: (ref.role === 'scene' || ref.role === 'detail'
          ? 'same_view_match_only' : 'disabled') as 'same_view_match_only' | 'disabled',
      })),
      promptPolicy: promptPolicy(request.prompt),
      processing: {
        targetHeight: 1080, temporalRadius: request.temporalRadius,
        acceptsVideoContextNotJpeg: true,
      },
      currentSourceVerified: true,
      colorAndCfrValidation: 'deferred_to_worker',
      referenceGeometryMatching: 'deferred_to_worker',
      runnable: false,
    };
  }
}
