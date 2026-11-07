/**
 * World IR v0: a renderer- and provider-independent, read-only scene contract.
 *
 * Deliberately NOT wired into Board, Store, or API yet. A future sidecar service
 * must own revision checks and human approval before committing proposals.
 * Coordinate system: right-handed, +Y up, meters; time is measured in seconds.
 */
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite();
const positive = finite.positive();
const vector3 = z.tuple([finite, finite, finite]);
const quaternion = z.tuple([finite, finite, finite, finite]).refine(
  q => Math.abs(Math.hypot(...q) - 1) < 0.001,
  { message: 'rotation must be a unit quaternion' },
);
const authority = z.enum(['approved', 'proposed']);
const provenance = z.object({
  origin: z.enum(['human', 'imported', 'generated']),
  assetSha256: sha256.optional(),
  rightsRef: id.optional(),
}).strict();

export const worldTransformSchema = z.object({
  positionM: vector3,
  rotation: quaternion,
  scale: vector3.refine(v => v.every(x => x > 0), 'scale must be positive'),
}).strict();

const entity = z.object({
  id,
  label: z.string().min(1).max(120),
  kind: z.enum(['character', 'prop', 'environment', 'light', 'other']),
  transform: worldTransformSchema,
  authority,
  provenance: provenance.optional(),
}).strict();

const camera = z.object({
  id,
  label: z.string().min(1).max(120),
  transform: worldTransformSchema,
  lens: z.object({
    focalLengthMm: positive.max(2000),
    sensorWidthMm: positive.max(200),
    focusDistanceM: positive.max(100000),
    fStop: positive.max(128),
  }).strict(),
  authority,
}).strict();

const shot = z.object({
  id,
  label: z.string().min(1).max(120),
  cameraId: id,
  startSeconds: finite.nonnegative(),
  endSeconds: positive,
  intent: z.string().max(2000).optional(),
  authority,
}).strict();

const relation = z.object({
  fromId: id,
  toId: id,
  kind: z.enum(['parent', 'looks_at', 'interacts_with', 'near', 'custom']),
}).strict();

const event = z.object({
  id,
  subjectId: id,
  atSeconds: finite.nonnegative(),
  kind: z.enum(['enter', 'exit', 'move', 'speak', 'interact', 'custom']),
  description: z.string().max(1000),
  authority,
}).strict();

const constraint = z.object({
  id,
  kind: z.enum(['identity', 'spatial', 'temporal', 'camera_axis', 'style', 'other']),
  targetIds: z.array(id).max(32),
  severity: z.enum(['hard', 'soft']),
  description: z.string().min(1).max(1000),
}).strict();

/**
 * Only declared properties are accepted. No executable expression, shell command,
 * raw URI, or unbounded model-defined payload is allowed in the canonical IR.
 */
export const worldIRSchema = z.object({
  schemaVersion: z.literal(1),
  worldId: id,
  sceneId: id,
  revision: z.number().int().nonnegative(),
  coordinateFrame: z.literal('RH_Y_UP_METERS'),
  timebase: z.object({
    fpsNumerator: z.number().int().positive().max(120000),
    fpsDenominator: z.number().int().positive().max(1001),
  }).strict(),
  durationSeconds: positive.max(86400),
  entities: z.array(entity).max(256),
  cameras: z.array(camera).max(32),
  shots: z.array(shot).max(256),
  relations: z.array(relation).max(1024),
  events: z.array(event).max(2048),
  constraints: z.array(constraint).max(512),
}).strict().superRefine((world, ctx) => {
  const identityCollections = [
    world.entities, world.cameras, world.shots, world.events, world.constraints,
  ];
  const allIds = identityCollections.flatMap(items => items.map(item => item.id));
  if (new Set(allIds).size !== allIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate world id' });
  }
  const entityIds = new Set(world.entities.map(x => x.id));
  const objectIds = new Set([...entityIds, ...world.cameras.map(x => x.id)]);
  for (const s of world.shots) {
    if (!world.cameras.some(c => c.id === s.cameraId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'shot references missing camera' });
    }
    if (s.endSeconds <= s.startSeconds || s.endSeconds > world.durationSeconds) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'shot outside scene duration' });
    }
  }
  for (const e of world.events) {
    if (!objectIds.has(e.subjectId) || e.atSeconds > world.durationSeconds) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid event reference or time' });
    }
  }
  const relationKeys = new Set<string>();
  const parentOf = new Map<string, string>();
  for (const r of world.relations) {
    if (!objectIds.has(r.fromId) || !objectIds.has(r.toId) || r.fromId === r.toId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid relation reference' });
    }
    const key = `${r.fromId}:${r.kind}:${r.toId}`;
    if (relationKeys.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate relation' });
    relationKeys.add(key);
    if (r.kind === 'parent') {
      if (!entityIds.has(r.fromId) || !entityIds.has(r.toId) || parentOf.has(r.fromId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid parent relation' });
      } else {
        parentOf.set(r.fromId, r.toId);
      }
    }
  }
  // Traverse parent links; reject cycles without executing any user expressions.
  for (const start of parentOf.keys()) {
    const seen = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor) {
      if (seen.has(cursor)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'parent cycle' });
        break;
      }
      seen.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }
  for (const c of world.constraints) for (const targetId of c.targetIds) {
    if (!objectIds.has(targetId) && !world.shots.some(s => s.id === targetId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'constraint references missing target' });
    }
  }
});

export type WorldIR = z.infer<typeof worldIRSchema>;
export type WorldTransform = z.infer<typeof worldTransformSchema>;
export function parseWorldIR(input: unknown): WorldIR {
  return worldIRSchema.parse(input);
}
