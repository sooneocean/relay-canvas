import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CanvasService } from './service.js';
import { AppError } from './graph.js';
import { Store } from './store.js';
import type { Board, Operation } from '../src/shared/types.js';

export type GraphBenchmarkCategory = 'mutation' | 'guardrail' | 'planning';
export interface GraphBenchmarkCase {
  id: string;
  category: GraphBenchmarkCategory;
  instruction: string;
  setup?: Operation[];
  challenge:
    | { kind: 'patch'; reference: { operations: Operation[]; revisionOffset?: number };
        expected: { kind: 'commit'; nodesPresent?: string[]; nodesAbsent?: string[];
          edgesPresent?: string[]; edgesAbsent?: string[];
          fields?: Array<{ nodeId: string; field: 'label' | 'prompt' | 'model'; value: string }>;
          positions?: Array<{ nodeId: string; x: number; y: number }> } | { kind: 'reject'; code: string } }
    | { kind: 'plan'; selected?: string; expectedOrder: string[]; generations: number; errorsContain?: string[] };
}
export interface GraphCandidateProposal { expectedRevision: number; operations: Operation[] }
export interface GraphBenchmarkResult { caseId: string; category: GraphBenchmarkCategory; passed: boolean; reason: string }
export interface GraphBenchmarkReport { suiteVersion: 1; total: number; passed: number; failed: number; cases: GraphBenchmarkResult[] }
export interface GraphCandidateResult { caseId: string; passed: boolean; reason: string }
export interface GraphPairwiseReport {
  total: number; baselinePassed: number; candidatePassed: number;
  repaired: number; regressed: number; bothPassed: number; bothFailed: number;
}

const policy = { remoteEnabled: false, providerOrigins: [], mediaOrigins: [] };
type PatchOutcome =
  | { kind: 'commit'; board: Board; before: Board }
  | { kind: 'reject'; code: string; unchanged: boolean };

function rejectionCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (error instanceof Error && error.name === 'ZodError') return 'INVALID_SCHEMA';
  return 'UNEXPECTED_ERROR';
}

function withService<T>(testCase: GraphBenchmarkCase, apply: (service: CanvasService) => T): T {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-graph-benchmark-'));
  try {
    const store = new Store(directory);
    const service = new CanvasService(store, policy, async () => {
      throw new Error('Graph benchmark must never call a generation provider');
    });
    if (testCase.setup?.length) service.patch('welcome', 0, structuredClone(testCase.setup));
    return apply(service);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function executePatch(testCase: GraphBenchmarkCase, proposal: GraphCandidateProposal): PatchOutcome {
  return withService(testCase, service => {
    const before = service.board('welcome');
    try {
      const board = service.patch('welcome', proposal.expectedRevision, structuredClone(proposal.operations));
      return { kind: 'commit', board, before };
    } catch (error) {
      return { kind: 'reject', code: rejectionCode(error),
        unchanged: isDeepStrictEqual(before, service.board('welcome')) };
    }
  });
}

function expectedState(board: Board, expected: Extract<Extract<GraphBenchmarkCase['challenge'], { kind: 'patch' }>['expected'], { kind: 'commit' }>): boolean {
  const nodes = new Set(board.nodes.map(node => node.id));
  const edges = new Set(board.edges.map(edge => edge.id));
  if (expected.nodesPresent?.some(id => !nodes.has(id)) ||
      expected.nodesAbsent?.some(id => nodes.has(id)) ||
      expected.edgesPresent?.some(id => !edges.has(id)) ||
      expected.edgesAbsent?.some(id => edges.has(id))) return false;
  if (expected.fields?.some(field => {
    const node = board.nodes.find(item => item.id === field.nodeId);
    return !node || node.data[field.field] !== field.value;
  })) return false;
  if (expected.positions?.some(position => {
    const node = board.nodes.find(item => item.id === position.nodeId);
    return !node || node.position.x !== position.x || node.position.y !== position.y;
  })) return false;
  return true;
}
function canonical(board: Board): Board {
  const copy = structuredClone(board);
  copy.nodes.sort((a, b) => a.id.localeCompare(b.id));
  copy.edges.sort((a, b) => a.id.localeCompare(b.id));
  return copy;
}

/**
 * Tests the real CanvasService.patch and CanvasService.validate paths using
 * synthetic in-memory fixtures only. It never starts a generation or writes
 * to the user's workspace.
 */
export function replayGraphBenchmark(cases: readonly GraphBenchmarkCase[]): GraphBenchmarkReport {
  const results: GraphBenchmarkResult[] = [];
  const ids = new Set<string>();
  for (const testCase of cases) {
    let passed = false, reason = 'UNEXPECTED_ERROR';
    try {
      if (ids.has(testCase.id)) throw new Error('DUPLICATE_CASE_ID');
      ids.add(testCase.id);
      if (testCase.challenge.kind === 'plan') {
        const actual = withService(testCase, service => service.validate('welcome', testCase.challenge.kind === 'plan' ? testCase.challenge.selected : undefined));
        passed = isDeepStrictEqual(actual.order, testCase.challenge.expectedOrder) &&
          actual.generations.length === testCase.challenge.generations &&
          (testCase.challenge.errorsContain ?? []).every(fragment => actual.errors.some(error => error.includes(fragment))) &&
          (testCase.challenge.errorsContain?.length ? actual.errors.length === testCase.challenge.errorsContain.length : actual.errors.length === 0);
        reason = passed ? 'PASS' : 'PLAN_MISMATCH';
      } else {
        const beforeRevision = withService(testCase, service => service.board('welcome').revision);
        const reference = testCase.challenge.reference;
        const actual = executePatch(testCase, {
          expectedRevision: beforeRevision + (reference.revisionOffset ?? 0),
          operations: reference.operations
        });
        if (testCase.challenge.expected.kind === 'reject') {
          passed = actual.kind === 'reject' && actual.code === testCase.challenge.expected.code && actual.unchanged;
          reason = passed ? 'PASS' : 'REJECTION_OR_ROLLBACK_MISMATCH';
        } else {
          passed = actual.kind === 'commit' && actual.board.revision === actual.before.revision + 1 &&
            expectedState(actual.board, testCase.challenge.expected);
          reason = passed ? 'PASS' : 'COMMIT_OR_TARGET_MISMATCH';
        }
      }
    } catch {
      passed = false;
      reason = 'HARNESS_ERROR';
    }
    results.push({ caseId: testCase.id, category: testCase.category, passed, reason });
  }
  return { suiteVersion: 1, total: results.length, passed: results.filter(result => result.passed).length,
    failed: results.filter(result => !result.passed).length, cases: results };
}

/**
 * Candidate assessment is exact-goal equivalence, not mere schema validity.
 * This prevents no-op or unrelated valid patches from receiving credit.
 * A rejected gold patch is scored by the matching fail-closed error code.
 */
export function scoreGraphCandidate(testCase: GraphBenchmarkCase, proposal: GraphCandidateProposal): GraphCandidateResult {
  if (testCase.challenge.kind !== 'patch') return { caseId: testCase.id, passed: false, reason: 'PLAN_CANDIDATE_UNSUPPORTED' };
  const gold = testCase.challenge.reference;
  const revision = withService(testCase, service => service.board('welcome').revision);
  const reference = executePatch(testCase, { expectedRevision: revision + (gold.revisionOffset ?? 0), operations: gold.operations });
  const expectation = testCase.challenge.expected;
  const oracleValid = expectation.kind === 'reject'
    ? reference.kind === 'reject' && reference.unchanged && reference.code === expectation.code
    : reference.kind === 'commit' && expectedState(reference.board, expectation);
  if (!oracleValid) return { caseId: testCase.id, passed: false, reason: 'INVALID_ORACLE' };
  const actual = executePatch(testCase, proposal);
  const passed = reference.kind === 'reject'
    ? actual.kind === 'reject' && actual.unchanged && actual.code === reference.code
    : actual.kind === 'commit' && isDeepStrictEqual(canonical(actual.board), canonical(reference.board));
  return { caseId: testCase.id, passed, reason: passed ? 'PASS' : 'GOAL_OR_SAFETY_MISMATCH' };
}

export function compareGraphPolicies(
  cases: readonly GraphBenchmarkCase[],
  baseline: Readonly<Record<string, GraphCandidateProposal>>,
  candidate: Readonly<Record<string, GraphCandidateProposal>>
): GraphPairwiseReport {
  const patchCases = cases.filter(item => item.challenge.kind === 'patch');
  let baselinePassed = 0, candidatePassed = 0, repaired = 0, regressed = 0, bothPassed = 0, bothFailed = 0;
  for (const testCase of patchCases) {
    const a = baseline[testCase.id] ? scoreGraphCandidate(testCase, baseline[testCase.id]).passed : false;
    const b = candidate[testCase.id] ? scoreGraphCandidate(testCase, candidate[testCase.id]).passed : false;
    if (a) baselinePassed++;
    if (b) candidatePassed++;
    if (!a && b) repaired++;
    else if (a && !b) regressed++;
    else if (a && b) bothPassed++;
    else bothFailed++;
  }
  return { total: patchCases.length, baselinePassed, candidatePassed, repaired, regressed, bothPassed, bothFailed };
}
