/** Privacy-preserving metadata replay for LocalLearningJournal v0.1.
 * This cannot reconstruct patches or replay generation: journal entries have
 * no operation values, prompts, artifacts, or source actor attribution.
 */
export interface LearningReplaySummary {
  schemaVersion: 1;
  acceptedEvents: number;
  duplicateEvents: number;
  truncatedTail: boolean;
  boardRevisions: number;
  boardPatchSummaries: number;
  startedRuns: number;
  terminalRuns: number;
  incompleteRuns: number;
  orphanTerminals: number;
  terminalStatusCounts: Record<'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'needs_review', number>;
}

const statuses = ['succeeded', 'failed', 'cancelled', 'interrupted', 'needs_review'] as const;
const eventTypes = ['board.revision_committed', 'board.patch_committed', 'run.started', 'run.finished'] as const;
const id = /^[A-Za-z0-9_-]{1,64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validEvent(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
      typeof value.eventId !== 'string' || !uuid.test(value.eventId) ||
      typeof value.type !== 'string' || !eventTypes.some(type => type === value.type) ||
      typeof value.boardId !== 'string' || !id.test(value.boardId) ||
      typeof value.episodeId !== 'string' ||
      typeof value.occurredAt !== 'string' || !Number.isFinite(Date.parse(value.occurredAt)) ||
      typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) return false;
  if (value.type === 'run.started' || value.type === 'run.finished') {
    if (typeof value.runId !== 'string' || !id.test(value.runId) || value.episodeId !== value.runId) return false;
  } else if (value.episodeId !== value.boardId + ':' + value.revision) return false;
  if (value.type === 'run.finished' && !statuses.some(status => status === value.status)) return false;
  return true;
}

/** A complete but malformed line fails closed; a torn last line is counted, not silently used. */
export function summarizeLearningJournal(source: string): LearningReplaySummary {
  if (Buffer.byteLength(source, 'utf8') > 16 * 1024 * 1024) throw new Error('Learning journal exceeds size limit');
  const seen = new Map<string, string>();
  const started = new Set<string>(), terminals = new Map<string, string>();
  const terminalStatusCounts: LearningReplaySummary['terminalStatusCounts'] = {
    succeeded: 0, failed: 0, cancelled: 0, interrupted: 0, needs_review: 0
  };
  let acceptedEvents = 0, duplicateEvents = 0, boardRevisions = 0, boardPatchSummaries = 0, truncatedTail = false;
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (!raw) {
      if (index === lines.length - 1) continue;
      throw new Error('Empty journal line at ' + (index + 1));
    }
    let event: unknown;
    try { event = JSON.parse(raw); }
    catch {
      if (index === lines.length - 1 && !source.endsWith('\n')) { truncatedTail = true; break; }
      throw new Error('Invalid journal line at ' + (index + 1));
    }
    if (!validEvent(event)) throw new Error('Invalid event schema at line ' + (index + 1));
    const eventId = event.eventId as string;
    if (seen.has(eventId)) {
      if (seen.get(eventId) !== raw) throw new Error('Conflicting duplicate event at line ' + (index + 1));
      duplicateEvents++;
      continue;
    }
    seen.set(eventId, raw);
    acceptedEvents++;
    switch (event.type) {
      case 'board.revision_committed': boardRevisions++; break;
      case 'board.patch_committed': boardPatchSummaries++; break;
      case 'run.started':
        started.add(event.runId as string);
        break;
      case 'run.finished': {
        const runId = event.runId as string;
        if (terminals.has(runId)) throw new Error('Multiple terminal events for one run');
        terminals.set(runId, event.status as string);
        terminalStatusCounts[event.status as keyof typeof terminalStatusCounts]++;
        break;
      }
    }
  }
  return { schemaVersion: 1, acceptedEvents, duplicateEvents, truncatedTail,
    boardRevisions, boardPatchSummaries, startedRuns: started.size, terminalRuns: terminals.size,
    incompleteRuns: [...started].filter(runId => !terminals.has(runId)).length,
    orphanTerminals: [...terminals.keys()].filter(runId => !started.has(runId)).length,
    terminalStatusCounts };
}
