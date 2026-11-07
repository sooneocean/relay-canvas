import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';

type PatchType = 'add_node' | 'update_node' | 'remove_node' | 'connect' | 'remove_edge';
export type TerminalRunStatus = 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'needs_review';

/**
 * An allowlisted, local-only observation event. Deliberately excludes prompts,
 * provider configurations, media URLs, arbitrary properties and secret values.
 */
export type LearningEventInput =
  | { type: 'board.revision_committed'; boardId: string; revision: number; nodes: number; edges: number }
  | { type: 'board.patch_committed'; boardId: string; revision: number; operationTypes: PatchType[] }
  | { type: 'run.started'; boardId: string; revision: number; runId: string; generations: number; remote: boolean }
  | { type: 'run.finished'; boardId: string; revision: number; runId: string; status: TerminalRunStatus; succeededNodes: number; artifactCount: number };

const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const patchTypes = new Set<PatchType>(['add_node', 'update_node', 'remove_node', 'connect', 'remove_edge']);
const statuses = new Set<TerminalRunStatus>(['succeeded', 'failed', 'cancelled', 'interrupted', 'needs_review']);

function safeId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error('Invalid event identity');
  return value;
}
function safeCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid event count');
  return value;
}
function safeFields(input: LearningEventInput): Record<string, unknown> {
  const common = { type: input.type, boardId: safeId(input.boardId), revision: safeCount(input.revision) };
  switch (input.type) {
    case 'board.revision_committed':
      return { ...common, nodes: safeCount(input.nodes), edges: safeCount(input.edges) };
    case 'board.patch_committed':
      if (!Array.isArray(input.operationTypes) || input.operationTypes.length > 200 ||
          !input.operationTypes.every(type => patchTypes.has(type))) throw new Error('Invalid patch summary');
      return { ...common, operationTypes: input.operationTypes.slice() };
    case 'run.started':
      if (typeof input.remote !== 'boolean') throw new Error('Invalid run summary');
      return { ...common, runId: safeId(input.runId), generations: safeCount(input.generations), remote: input.remote };
    case 'run.finished':
      if (!statuses.has(input.status)) throw new Error('Invalid run status');
      return { ...common, runId: safeId(input.runId), status: input.status,
        succeededNodes: safeCount(input.succeededNodes), artifactCount: safeCount(input.artifactCount) };
  }
}

/**
 * Best-effort v0.1 journal: opt-in only, never blocks a successful canvas mutation
 * or paid generation. Not a transactional outbox or an automatic learning/training feed.
 */
export class LocalLearningJournal {
  readonly file: string;
  private warned = false;
  constructor(directory: string) {
    this.file = path.join(directory, 'learning-events.v1.jsonl');
  }
  record(input: LearningEventInput): void {
    try {
      const sanitized = safeFields(input);
      const event = { schemaVersion: 1, eventId: randomUUID(), occurredAt: new Date().toISOString(),
        episodeId: 'runId' in sanitized ? sanitized.runId : `${sanitized.boardId}:${sanitized.revision}`, ...sanitized };
      const bytes = Buffer.from(JSON.stringify(event) + '\n');
      const fd = openSync(this.file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size + bytes.length > MAX_JOURNAL_BYTES) {
          throw new Error('Learning journal unavailable');
        }
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset);
          if (written <= 0) throw new Error('Learning journal write failed');
          offset += written;
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      if (!this.warned) console.warn('Local learning event could not be recorded; primary operation is unaffected.');
      this.warned = true;
    }
  }
}
