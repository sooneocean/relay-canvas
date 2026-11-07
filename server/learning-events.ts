import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { LearningEventRecord, StoreData } from '../src/shared/types.js';
import type { Store } from './store.js';

type PatchType = 'add_node' | 'update_node' | 'remove_node' | 'connect' | 'remove_edge';
export type TerminalRunStatus = 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'needs_review';
export type LearningEventInput =
  | { type: 'board.revision_committed'; boardId: string; revision: number; nodes: number; edges: number }
  | { type: 'board.patch_committed'; boardId: string; revision: number; operationTypes: PatchType[] }
  | { type: 'run.started'; boardId: string; revision: number; runId: string; generations: number; remote: boolean }
  | { type: 'run.finished'; boardId: string; revision: number; runId: string; status: TerminalRunStatus; succeededNodes: number; artifactCount: number };

const MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_OUTBOX = 1024;
const patchTypes = new Set<PatchType>(['add_node', 'update_node', 'remove_node', 'connect', 'remove_edge']);
const statuses = new Set<TerminalRunStatus>(['succeeded', 'failed', 'cancelled', 'interrupted', 'needs_review']);
const isTerminal = (status: string): status is TerminalRunStatus => statuses.has(status as TerminalRunStatus);

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
      if (!isTerminal(input.status)) throw new Error('Invalid run status');
      return { ...common, runId: safeId(input.runId), status: input.status,
        succeededNodes: safeCount(input.succeededNodes), artifactCount: safeCount(input.artifactCount) };
  }
}

export function sealLearningEvent(input: LearningEventInput): LearningEventRecord {
  const sanitized = safeFields(input);
  return {
    schemaVersion: 1, eventId: randomUUID(), occurredAt: new Date().toISOString(),
    episodeId: 'runId' in sanitized ? sanitized.runId : `${sanitized.boardId}:${sanitized.revision}`,
    actor: 'unattributed', scope: 'local_only', ...sanitized
  } as unknown as LearningEventRecord;
}

/** Called only inside an existing Store.transaction so workspace and event commit together. */
export function enqueueLearningEvent(data: StoreData, input: LearningEventInput): boolean {
  data.learningOutbox ??= [];
  if (data.learningOutbox.length >= MAX_OUTBOX) {
    // A full observation queue must not block a creative edit or paid run.
    // For run.finished, the observed-run marker retains the recovery obligation.
    if (input.type !== 'run.finished') {
      data.learningDroppedEvents = Math.min(Number.MAX_SAFE_INTEGER, (data.learningDroppedEvents ?? 0) + 1);
    }
    return false;
  }
  data.learningOutbox.push(sealLearningEvent(input));
  return true;
}

/** Synchronous local-only append. Stable event IDs allow at-least-once replay. */
export class LocalLearningJournal {
  readonly file: string;
  private warned = false;
  constructor(directory: string) { this.file = path.join(directory, 'learning-events.v1.jsonl'); }

  append(event: LearningEventRecord): boolean {
    try {
      const { eventId, occurredAt, actor, scope, episodeId } = event;
      if (!/^[0-9a-f-]{36}$/i.test(eventId) || !Number.isFinite(Date.parse(occurredAt)) ||
          actor !== 'unattributed' || scope !== 'local_only') throw new Error('Invalid event envelope');
      const fields = safeFields(event as LearningEventInput);
      const expectedEpisode = 'runId' in fields ? fields.runId : `${fields.boardId}:${fields.revision}`;
      if (episodeId !== expectedEpisode) throw new Error('Invalid episode');
      const serialized = JSON.stringify({ schemaVersion: 1, eventId, occurredAt, episodeId, actor, scope, ...fields }) + '\n';
      const bytes = Buffer.from(serialized);
      const fd = openSync(this.file, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size + bytes.length > MAX_JOURNAL_BYTES)
          throw new Error('Learning journal unavailable');
        if (stat.size > 0) {
          const last = Buffer.alloc(1);
          if (readSync(fd, last, 0, 1, stat.size - 1) !== 1 || last[0] !== 10)
            throw new Error('Journal has an incomplete tail; manual reconciliation required');
        }
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset);
          if (written <= 0) throw new Error('Learning journal write failed');
          offset += written;
        }
        fsyncSync(fd);
        return true;
      } finally { closeSync(fd); }
    } catch {
      if (!this.warned) console.warn('Local learning delivery unavailable; primary canvas operation is unaffected.');
      this.warned = true;
      return false;
    }
  }

  /** v0.1 compatibility for direct callers. New service uses the durable outbox. */
  record(input: LearningEventInput): void { this.append(sealLearningEvent(input)); }
}

/** Bounded transactional outbox: local delivery is at least once, not exactly once. */
export class LocalLearningOutbox {
  constructor(private readonly store: Store, private readonly journal: LocalLearningJournal) {}

  enqueue(data: StoreData, input: LearningEventInput): boolean {
    return enqueueLearningEvent(data, input);
  }

  /** Idempotent terminal recovery after Store has marked in-flight runs interrupted. */
  recoverTerminals(): void {
    try {
      const snapshot = this.store.read();
      if (!(snapshot.learningObservedRuns ?? []).some(id => {
        const run = snapshot.runs.find(item => item.id === id);
        return !!run && isTerminal(run.status);
      })) return;
      this.store.transaction(data => {
        const remaining: string[] = [];
        for (const runId of data.learningObservedRuns ?? []) {
          const run = data.runs.find(item => item.id === runId);
          if (!run || !isTerminal(run.status)) { remaining.push(runId); continue; }
          const pending = (data.learningOutbox ?? []).some(event =>
            event.type === 'run.finished' && event.runId === runId);
          if (!pending && !this.enqueue(data, {
            type: 'run.finished', boardId: run.boardId, revision: run.revision, runId,
            status: run.status,
            succeededNodes: Object.values(run.results).filter(result => result.status === 'succeeded').length,
            artifactCount: Object.values(run.results).reduce((sum, result) => sum + result.artifacts.length, 0)
          })) { remaining.push(runId); }
        }
        data.learningObservedRuns = remaining;
      });
    } catch {
      // A failed recovery must never stop the primary app.
    }
  }

  flush(): void {
    for (const entry of this.store.read().learningOutbox ?? []) {
      if (!this.journal.append(entry)) break;
      try {
        this.store.transaction(data => {
          data.learningOutbox = (data.learningOutbox ?? []).filter(item => item.eventId !== entry.eventId);
        });
      } catch {
        // Crash here permits a duplicate stable eventId; the reader deduplicates it.
        break;
      }
    }
  }
}
