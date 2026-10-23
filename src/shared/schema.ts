import { z } from 'zod';
import type {
  Artifact,
  Board,
  CanonicalRun,
  EditorCapabilities,
  ExportInput,
  ExportJob,
  MediaInfo,
  Operation,
  Provider,
  RunComparison,
  StoreData,
  StoredExportJob,
  Timeline,
  TimelineInput,
} from './types.js';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_ENV = /^RELAY_KEY_[A-Z0-9_]{1,64}$/;
const REFERENCE_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_PARAM_KEYS = new Set([
  '__proto__',
  'proto',
  'prototype',
  'constructor',
  'url',
  'method',
  'headers',
  'authorization',
  'keyenv',
  'redirect',
  'timeout',
]);
const RESERVED_REFERENCE_FIELDS = new Set([
  ...RESERVED_PARAM_KEYS,
  'prompt',
  'model',
  'input',
  'n',
]);
const MAX_DATA_URL = 6 * 1024 * 1024;
const MAX_PARAM_BYTES = 16 * 1024;

const idSchema = z.string().regex(ID);
const shortText = z.string().max(120);
const modelSchema = z.string().max(200);
const finiteNumber = z.number().finite();
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const isoDateSchema = z.string().datetime({ offset: true }).max(64);

export function isSafeReferenceField(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && REFERENCE_FIELD.test(value) &&
    !RESERVED_REFERENCE_FIELDS.has(value.toLowerCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateParamValue(value: unknown, depth: number): boolean {
  if (depth > 6) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 16_000;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 100 && value.every((entry) => validateParamValue(entry, depth + 1));
  }
  if (!isPlainObject(value)) return false;
  return Object.keys(value).every((key) =>
    !RESERVED_PARAM_KEYS.has(key.toLowerCase()) && validateParamValue(value[key], depth + 1));
}

function validParams(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value) || !validateParamValue(value, 1)) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_PARAM_BYTES;
  } catch {
    return false;
  }
}

function validAssetUrl(value: string): boolean {
  if (value.length > MAX_DATA_URL) return false;
  if (value.startsWith('data:')) {
    return /^data:(image\/(?:png|jpeg|webp)|video\/(?:mp4|webm));base64,[A-Za-z0-9+/]*={0,2}$/i.test(value);
  }
  if (value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

const paramsSchema = z.custom<Record<string, unknown>>(validParams);
const positionSchema = z.object({ x: finiteNumber, y: finiteNumber }).strict();
const dataShape = {
  kind: z.enum(['prompt', 'image', 'video', 'asset', 'note']),
  label: shortText,
  prompt: z.string().max(16_000).optional(),
  providerId: idSchema.optional(),
  model: modelSchema.optional(),
  params: paramsSchema.optional(),
  referenceField: z.string().refine(isSafeReferenceField).optional(),
  assetUrl: z.string().refine(validAssetUrl).optional(),
  assetKind: z.enum(['image', 'video']).optional(),
};
const canvasDataSchema = z.object(dataShape).strict();
const partialCanvasDataSchema = z.object({
  kind: dataShape.kind.optional(),
  label: dataShape.label.optional(),
  prompt: dataShape.prompt,
  providerId: dataShape.providerId,
  model: dataShape.model,
  params: dataShape.params,
  referenceField: dataShape.referenceField,
  assetUrl: dataShape.assetUrl,
  assetKind: dataShape.assetKind,
}).strict();
const nodeSchema = z.object({
  id: idSchema,
  type: z.literal('canvas'),
  position: positionSchema,
  data: canvasDataSchema,
}).strict();
const edgeSchema = z.object({ id: idSchema, source: idSchema, target: idSchema }).strict();
const boardSchema = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  name: shortText,
  revision: revisionSchema,
  nodes: z.array(nodeSchema).max(100),
  edges: z.array(edgeSchema).max(200),
  viewport: z.object({ x: finiteNumber, y: finiteNumber, zoom: finiteNumber.min(0.01).max(100) }).strict(),
}).strict().superRefine((board, context) => {
  const nodeIds = new Set(board.nodes.map((node) => node.id));
  const edgeIds = new Set(board.edges.map((edge) => edge.id));
  if (nodeIds.size !== board.nodes.length || edgeIds.size !== board.edges.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate id' });
  }
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const edge of board.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid edge' });
      continue;
    }
    adjacency.get(edge.source)?.push(edge.target);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) if (!visit(next)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  if ([...nodeIds].some((id) => !visit(id))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'cycle' });
  }
});

const providerSchema = z.object({
  id: idSchema,
  name: shortText,
  protocol: z.enum(['demo', 'openai', 'videos', 'relay', 'fal', 'replicate']),
  baseUrl: z.string().max(4096),
  keyEnv: z.union([z.literal(''), z.string().max(74).regex(KEY_ENV)]),
  imageModel: modelSchema,
  videoModel: modelSchema,
}).strict().superRefine((provider, context) => {
  if (provider.protocol !== 'demo' && !KEY_ENV.test(provider.keyEnv)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid key env' });
  }
});

const operationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('add_node'), node: nodeSchema }).strict(),
  z.object({ type: z.literal('update_node'), id: idSchema, data: partialCanvasDataSchema.optional(), position: positionSchema.optional() }).strict(),
  z.object({ type: z.literal('remove_node'), id: idSchema }).strict(),
  z.object({ type: z.literal('connect'), edge: edgeSchema }).strict(),
  z.object({ type: z.literal('remove_edge'), id: idSchema }).strict(),
]);

const runInputSchema = z.object({
  boardId: idSchema,
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  operationId: idSchema,
  nodeId: idSchema.optional(),
  confirmExternal: z.boolean().optional(),
}).strict();

const clipSourceSchema = z.object({
  runId: idSchema,
  nodeId: idSchema,
  artifactIndex: z.number().int().min(0).max(99),
}).strict();
const mediaInfoSchema = z.object({
  duration: finiteNumber.positive().max(60 * 60),
  width: z.number().int().positive().max(16_384),
  height: z.number().int().positive().max(16_384),
  hasAudio: z.boolean(),
}).strict().superRefine((media, context) => {
  if (media.width * media.height > 3840 * 2160) context.addIssue({ code: z.ZodIssueCode.custom, message: 'source dimensions exceed limit' });
});
const artifactSchema = z.object({
  kind: z.enum(['image', 'video']),
  url: z.string().min(1).max(MAX_DATA_URL),
  mimeType: z.string().max(100).optional(),
  demo: z.boolean().optional(),
  localId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  localUrl: z.string().regex(/^\/api\/media\/[a-f0-9]{64}$/).optional(),
  bytes: z.number().int().min(1).max(64 * 1024 * 1024).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((artifact, context) => {
  const local = [artifact.localId, artifact.localUrl, artifact.bytes, artifact.sha256];
  const count = local.filter(value => value !== undefined).length;
  if (count !== 0 && count !== local.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'incomplete local artifact metadata' });
  if (count && (!artifact.mimeType || artifact.sha256 !== artifact.localId || artifact.localUrl !== `/api/media/${artifact.localId}`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid local artifact metadata' });
  }
});
const savedVideoArtifactSchema = artifactSchema.superRefine((artifact, context) => {
  if (artifact.kind !== 'video' || !artifact.localId || !['video/mp4', 'video/webm'].includes(artifact.mimeType ?? '')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'timeline source must be a saved video' });
  }
});
const timelineInputClipShape = {
  id: idSchema,
  source: clipSourceSchema,
  inSeconds: finiteNumber.min(0).max(60 * 60),
  outSeconds: finiteNumber.positive().max(60 * 60),
};
const validateClipTrim = (clip: { inSeconds: number; outSeconds: number }, context: z.RefinementCtx) => {
  const length = clip.outSeconds - clip.inSeconds;
  if (length < 1 / 24 || length > 60) context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid clip trim' });
};
const timelineInputClipSchema = z.object(timelineInputClipShape).strict().superRefine(validateClipTrim);
const timelineInputShape = {
  expectedRevision: revisionSchema,
  format: z.enum(['landscape', 'portrait']),
  clips: z.array(timelineInputClipSchema).max(12),
};
const timelineInputSchema = z.object(timelineInputShape).strict().superRefine((timeline, context) => {
  if (new Set(timeline.clips.map(clip => clip.id)).size !== timeline.clips.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate clip id' });
  if (timeline.clips.reduce((sum, clip) => sum + clip.outSeconds - clip.inSeconds, 0) > 180) context.addIssue({ code: z.ZodIssueCode.custom, message: 'timeline duration exceeds limit' });
});
const timelineClipSchema = z.object({ ...timelineInputClipShape, artifact: savedVideoArtifactSchema, media: mediaInfoSchema }).strict().superRefine((clip, context) => {
  validateClipTrim(clip, context);
  if (clip.outSeconds > clip.media.duration + 1e-6) context.addIssue({ code: z.ZodIssueCode.custom, message: 'clip trim exceeds media duration' });
});
const timelineSchema = z.object({
  boardId: idSchema,
  revision: revisionSchema,
  format: z.enum(['landscape', 'portrait']),
  clips: z.array(timelineClipSchema).max(12),
}).strict().superRefine((timeline, context) => {
  if (new Set(timeline.clips.map(clip => clip.id)).size !== timeline.clips.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate clip id' });
  if (timeline.clips.reduce((sum, clip) => sum + clip.outSeconds - clip.inSeconds, 0) > 180) context.addIssue({ code: z.ZodIssueCode.custom, message: 'timeline duration exceeds limit' });
});
const exportInputSchema = z.object({ expectedRevision: revisionSchema, operationId: idSchema }).strict();
const exportStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']);
const exportJobShape = {
  id: idSchema,
  boardId: idSchema,
  timelineRevision: revisionSchema,
  operationId: idSchema,
  status: exportStatusSchema,
  startedAt: isoDateSchema,
  finishedAt: isoDateSchema.optional(),
  error: z.string().max(1000).optional(),
  snapshot: timelineSchema,
  artifact: savedVideoArtifactSchema.optional(),
};
const exportJobSchema = z.object(exportJobShape).strict().superRefine((job, context) => {
  if (job.snapshot.boardId !== job.boardId || job.snapshot.revision !== job.timelineRevision) context.addIssue({ code: z.ZodIssueCode.custom, message: 'export snapshot identity mismatch' });
  if (job.status === 'succeeded' && !job.artifact) context.addIssue({ code: z.ZodIssueCode.custom, message: 'successful export requires artifact' });
  if (job.artifact && job.artifact.mimeType !== 'video/mp4') context.addIssue({ code: z.ZodIssueCode.custom, message: 'export must be MP4' });
});
const storedExportJobSchema = z.object({ ...exportJobShape, attemptNonce: z.string().uuid() }).strict().superRefine((job, context) => {
  if (job.snapshot.boardId !== job.boardId || job.snapshot.revision !== job.timelineRevision) context.addIssue({ code: z.ZodIssueCode.custom, message: 'export snapshot identity mismatch' });
  if (job.status === 'succeeded' && !job.artifact) context.addIssue({ code: z.ZodIssueCode.custom, message: 'successful export requires artifact' });
  if (job.artifact && job.artifact.mimeType !== 'video/mp4') context.addIssue({ code: z.ZodIssueCode.custom, message: 'export must be MP4' });
});
const capabilitiesSchema = z.object({
  available: z.boolean(), ffmpeg: z.boolean(), ffprobe: z.boolean(),
  formats: z.object({
    landscape: z.object({ width: z.literal(1280), height: z.literal(720) }).strict(),
    portrait: z.object({ width: z.literal(720), height: z.literal(1280) }).strict(),
  }).strict(),
  fps: z.literal(24),
  limits: z.object({
    maxClips: z.literal(12), maxClipSeconds: z.literal(60), maxTimelineSeconds: z.literal(180),
    maxSourceBytes: z.number().int().positive().max(64 * 1024 * 1024),
  }).strict(),
}).strict();

const statusSchema = z.enum(['pending', 'submitting', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'needs_review']);
const nodeResultSchema = z.object({
  nodeId: idSchema,
  status: statusSchema,
  text: z.string().max(64 * 1024).optional(),
  artifacts: z.array(artifactSchema).max(100),
  error: z.string().max(1000).optional(),
  attemptId: idSchema.optional(),
  remoteId: z.string().max(1000).optional(),
  referenceUrl: z.string().max(MAX_DATA_URL).optional(),
}).strict();
const runShape = {
  id: idSchema, boardId: idSchema, revision: revisionSchema, operationId: idSchema, status: statusSchema,
  startedAt: isoDateSchema, finishedAt: isoDateSchema.optional(), snapshot: boardSchema,
  providers: z.array(providerSchema).max(20), order: z.array(idSchema).max(100),
  results: z.record(idSchema, nodeResultSchema), error: z.string().max(1000).optional(),
};
const validateRunIdentity = (run: { boardId: string; revision: number; snapshot: Board; order: string[]; results: Record<string, { nodeId: string }> }, context: z.RefinementCtx) => {
  if (run.snapshot.id !== run.boardId || run.snapshot.revision !== run.revision) context.addIssue({ code: z.ZodIssueCode.custom, message: 'run snapshot identity mismatch' });
  if (new Set(run.order).size !== run.order.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate run order id' });
  for (const [key, result] of Object.entries(run.results)) if (key !== result.nodeId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'run result identity mismatch' });
};
const runSchema = z.object(runShape).strict().superRefine(validateRunIdentity);
const canonicalArtifactSchema = z.object({ kind: z.enum(['image', 'video']), url: z.string().min(1).max(MAX_DATA_URL), demo: z.boolean().optional() }).strict();
const canonicalNodeResultSchema = nodeResultSchema.omit({ artifacts: true }).extend({ artifacts: z.array(canonicalArtifactSchema).max(100) }).strict();
const canonicalRunSchema = z.object({ ...runShape,
  status: z.enum(['succeeded', 'failed', 'cancelled', 'interrupted', 'needs_review']),
  results: z.record(idSchema, canonicalNodeResultSchema),
}).strict().superRefine(validateRunIdentity);
const comparisonSchema = z.object({
  boardId: idSchema,
  left: canonicalRunSchema,
  right: canonicalRunSchema,
  differences: z.array(z.object({
    nodeId: idSchema,
    fields: z.array(z.enum(['presence', 'status', 'prompt', 'providerId', 'model', 'params', 'artifacts'])).max(7),
  }).strict()).max(200),
}).strict().superRefine((comparison, context) => {
  if (comparison.left.boardId !== comparison.boardId || comparison.right.boardId !== comparison.boardId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'comparison board mismatch' });
  if (comparison.left.id === comparison.right.id) context.addIssue({ code: z.ZodIssueCode.custom, message: 'comparison runs must differ' });
});
const storeDataSchema = z.object({
  schemaVersion: z.literal(1),
  boards: z.array(boardSchema).max(20),
  providers: z.array(providerSchema).max(20),
  runs: z.array(runSchema).max(200),
  timelines: z.array(timelineSchema).max(20).optional(),
  exports: z.array(storedExportJobSchema).max(100).optional(),
}).strict().superRefine((data, context) => {
  const boardIds = new Set(data.boards.map(board => board.id));
  if (boardIds.size !== data.boards.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate board id' });
  if (new Set(data.providers.map(provider => provider.id)).size !== data.providers.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate provider id' });
  if (new Set(data.runs.map(run => run.id)).size !== data.runs.length || new Set(data.runs.map(run => run.operationId)).size !== data.runs.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate run identity' });
  if (new Set((data.timelines ?? []).map(timeline => timeline.boardId)).size !== (data.timelines ?? []).length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate timeline board' });
  if (new Set((data.exports ?? []).map(job => job.id)).size !== (data.exports ?? []).length || new Set((data.exports ?? []).map(job => job.operationId)).size !== (data.exports ?? []).length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate export identity' });
  for (const timeline of data.timelines ?? []) if (!boardIds.has(timeline.boardId)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'timeline board missing' });
  for (const job of data.exports ?? []) if (!boardIds.has(job.boardId)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'export board missing' });
});

function parseSafe<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error('Invalid request');
  return result.data;
}

export function parseBoard(value: unknown): Board {
  return parseSafe(boardSchema, value);
}

export function parseProviders(value: unknown): Provider[] {
  const providers = parseSafe(z.array(providerSchema).max(20), value);
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length) throw new Error('Invalid request');
  return providers;
}

export function parseOperations(value: unknown): Operation[] {
  return parseSafe(z.array(operationSchema).max(200), value);
}

export function parseGenerationParams(value: unknown): Record<string, unknown> {
  return parseSafe(paramsSchema, value);
}

const videosParamsSchema = z.object({
  seconds: z.enum(['4', '8', '12']).optional(),
  size: z.enum(['720x1280', '1280x720', '1024x1792', '1792x1024']).optional(),
}).strict();

export function parseVideosParams(value: unknown): { seconds?: '4' | '8' | '12'; size?: '720x1280' | '1280x720' | '1024x1792' | '1792x1024' } {
  return parseSafe(videosParamsSchema, value);
}

export interface RunInput {
  boardId: string;
  expectedRevision: number;
  operationId: string;
  nodeId?: string;
  confirmExternal?: boolean;
}

export function parseRunInput(value: unknown): RunInput {
  return parseSafe(runInputSchema, value);
}

export function parseTimeline(value: unknown): Timeline { return parseSafe(timelineSchema, value); }
export function parseTimelineInput(value: unknown): TimelineInput { return parseSafe(timelineInputSchema, value); }
export function parseMediaInfo(value: unknown): MediaInfo { return parseSafe(mediaInfoSchema, value); }
export function parseArtifact(value: unknown): Artifact { return parseSafe(artifactSchema, value); }
export function parseExportInput(value: unknown): ExportInput { return parseSafe(exportInputSchema, value); }
export function parseExportJob(value: unknown): ExportJob { return parseSafe(exportJobSchema, value); }
export function parseStoredExportJob(value: unknown): StoredExportJob { return parseSafe(storedExportJobSchema, value); }
export function parseEditorCapabilities(value: unknown): EditorCapabilities { return parseSafe(capabilitiesSchema, value); }
export function parseCanonicalRun(value: unknown): CanonicalRun { return parseSafe(canonicalRunSchema, value); }
export function parseRunComparison(value: unknown): RunComparison { return parseSafe(comparisonSchema, value); }
export function parseStoreData(value: unknown): StoreData { return parseSafe(storeDataSchema, value); }

export const schemaLimits = Object.freeze({
  maxBoards: 20,
  maxNodes: 100,
  maxEdges: 200,
  maxTimelines: 20,
  maxTimelineClips: 12,
  maxExports: 100,
  maxTimelineSeconds: 180,
  maxRequestBytes: 6 * 1024 * 1024,
});
