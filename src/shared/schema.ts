import { z } from 'zod';
import type { Board, Operation, Provider } from './types.js';

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
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
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
  protocol: z.enum(['demo', 'openai', 'videos', 'fal', 'replicate']),
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

export const schemaLimits = Object.freeze({
  maxBoards: 20,
  maxNodes: 100,
  maxEdges: 200,
  maxRequestBytes: 6 * 1024 * 1024,
});
