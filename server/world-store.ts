/**
 * Versioned World Scene sidecar journal.
 *
 * This is intentionally separate from workspace.json / Board schema v1.
 * The local ReachFlow server owns one workspace lock and is the ONLY writer.
 * A clustered deployment must replace this journal with a transactional store.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from './graph.js';
import { atomicWrite } from './store.js';
import { worldIRSchema, type WorldIR } from '../src/shared/world-ir.js';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const id = z.string().regex(ID);
const hashValue = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const sceneWriteSchema = z.object({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  operationId: id,
  // Explicit intent only. PR-03 will add an authenticated human-review workflow.
  confirmApproved: z.literal(true),
  scene: worldIRSchema,
}).strict();

const commitSchema = z.object({
  operationId: id,
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sceneSha256: z.string().regex(/^[a-f0-9]{64}$/),
  committedAt: z.string().datetime({ offset: true }),
  scene: worldIRSchema,
}).strict();
const journalSchema = z.object({
  schemaVersion: z.literal(1),
  commits: z.array(commitSchema).max(10000),
}).strict();

type WorldJournal = z.infer<typeof journalSchema>;
type WorldCommit = WorldJournal['commits'][number];
export type WorldWriteResult = {
  scene: WorldIR;
  sha256: string;
  committedRevision: number;
  currentRevision: number;
  replayed: boolean;
};
export type WorldRevision = {
  revision: number;
  sha256: string;
  committedAt: string;
};

function ensureId(value: string): void {
  if (!ID.test(value)) throw new AppError('INVALID_WORLD_ID', 'Invalid world or scene identifier.', 400);
}

function ensureApproved(scene: WorldIR): void {
  const records = [...scene.entities, ...scene.cameras, ...scene.shots, ...scene.events];
  if (records.some(record => record.authority !== 'approved')) {
    throw new AppError('WORLD_REVIEW_REQUIRED', 'Proposed world changes cannot be committed as approved state.', 409);
  }
}

export class WorldSceneStore {
  readonly file: string;

  constructor(directory: string) {
    // Caller must pass the already-validated, single-writer workspace directory.
    this.file = path.join(directory, 'world-scenes.json');
  }

  private readJournal(): WorldJournal {
    if (!existsSync(this.file)) return { schemaVersion: 1, commits: [] };
    let raw: Buffer;
    try {
      const metadata = lstatSync(this.file);
      if (!metadata.isFile() || metadata.isSymbolicLink() ||
        (metadata.mode & 0o777) !== 0o600 || metadata.size > MAX_JOURNAL_BYTES) throw new Error('unsafe journal');
      const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.dev !== metadata.dev || stat.ino !== metadata.ino ||
          (stat.mode & 0o777) !== 0o600 || stat.size > MAX_JOURNAL_BYTES) throw new Error('journal changed');
        raw = readFileSync(fd);
      } finally { closeSync(fd); }
    } catch {
      throw new AppError('WORLD_STORE_INVALID', 'World scene journal is unsafe or unreadable.', 500);
    }
    let parsed: WorldJournal;
    try {
      parsed = journalSchema.parse(JSON.parse(raw.toString('utf8')));
      const seenOperations = new Set<string>();
      const lastRevision = new Map<string, number>();
      for (const commit of parsed.commits) {
        const scene = commit.scene;
        const key = `${scene.worldId}/${scene.sceneId}`;
        if (seenOperations.has(commit.operationId) || scene.revision !== (lastRevision.get(key) ?? 0) + 1 ||
          hashValue(scene) !== commit.sceneSha256) throw new Error('invalid journal invariant');
        seenOperations.add(commit.operationId);
        lastRevision.set(key, scene.revision);
      }
    } catch {
      throw new AppError('WORLD_STORE_INVALID', 'World scene journal failed validation.', 500);
    }
    return parsed;
  }

  private matching(journal: WorldJournal, worldId: string, sceneId: string): WorldCommit[] {
    return journal.commits.filter(c => c.scene.worldId === worldId && c.scene.sceneId === sceneId);
  }

  read(worldId: string, sceneId: string, revision?: number): WorldIR {
    ensureId(worldId);
    ensureId(sceneId);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) {
      throw new AppError('INVALID_WORLD_REVISION', 'Invalid scene revision.', 400);
    }
    const matches = this.matching(this.readJournal(), worldId, sceneId);
    const found = revision === undefined ? matches.at(-1) : matches.find(x => x.scene.revision === revision);
    if (!found) throw new AppError('WORLD_NOT_FOUND', 'World scene revision not found.', 404);
    return found.scene;
  }

  listRevisions(worldId: string, sceneId: string): {
    worldId: string; sceneId: string; currentRevision: number; revisions: WorldRevision[];
  } {
    ensureId(worldId);
    ensureId(sceneId);
    const matches = this.matching(this.readJournal(), worldId, sceneId);
    if (!matches.length) throw new AppError('WORLD_NOT_FOUND', 'World scene not found.', 404);
    return {
      worldId,
      sceneId,
      currentRevision: matches.at(-1)!.scene.revision,
      revisions: matches.map(c => ({
        revision: c.scene.revision,
        sha256: c.sceneSha256,
        committedAt: c.committedAt,
      })),
    };
  }

  save(worldId: string, sceneId: string, value: unknown): WorldWriteResult {
    ensureId(worldId);
    ensureId(sceneId);
    const parsed = sceneWriteSchema.safeParse(value);
    if (!parsed.success) throw new AppError('INVALID_WORLD_WRITE', 'Invalid world scene write request.', 400);
    const { scene, expectedRevision, operationId } = parsed.data;
    if (scene.worldId !== worldId || scene.sceneId !== sceneId) {
      throw new AppError('WORLD_IDENTITY_CONFLICT', 'World scene identity does not match the route.', 400);
    }
    if (scene.revision !== expectedRevision) {
      throw new AppError('WORLD_REVISION_MISMATCH', 'Scene input revision must equal expectedRevision.', 400);
    }
    ensureApproved(scene);
    const requestSha256 = hashValue({ expectedRevision, worldId, sceneId, scene });
    const journal = this.readJournal();
    const prior = journal.commits.find(c => c.operationId === operationId);
    const matches = this.matching(journal, worldId, sceneId);
    const latest = matches.at(-1);
    if (prior) {
      if (prior.requestSha256 !== requestSha256) {
        throw new AppError('WORLD_OPERATION_CONFLICT', 'Operation ID was already used for different input.', 409);
      }
      return {
        scene: prior.scene,
        sha256: prior.sceneSha256,
        committedRevision: prior.scene.revision,
        currentRevision: latest?.scene.revision ?? prior.scene.revision,
        replayed: true,
      };
    }
    if (expectedRevision !== (latest?.scene.revision ?? 0)) {
      throw new AppError('WORLD_REVISION_CONFLICT', 'World scene was updated; reload before writing.', 409);
    }
    const nextScene: WorldIR = { ...scene, revision: expectedRevision + 1 };
    const committed: WorldCommit = {
      operationId,
      requestSha256,
      sceneSha256: hashValue(nextScene),
      committedAt: new Date().toISOString(),
      scene: nextScene,
    };
    const next: WorldJournal = { schemaVersion: 1, commits: [...journal.commits, committed] };
    const serializedSize = Buffer.byteLength(JSON.stringify(next));
    if (next.commits.length > 10000 || serializedSize > MAX_JOURNAL_BYTES) {
      throw new AppError('WORLD_STORAGE_LIMIT', 'World journal capacity reached; migrate storage before more writes.', 409);
    }
    try { atomicWrite(this.file, next); }
    catch { throw new AppError('WORLD_STORAGE_FAILED', 'World scene could not be persisted.', 500); }
    return {
      scene: nextScene,
      sha256: committed.sceneSha256,
      committedRevision: nextScene.revision,
      currentRevision: nextScene.revision,
      replayed: false,
    };
  }
}
