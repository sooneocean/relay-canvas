import type { Artifact, Board, Run } from '../shared/types.js';

export interface ProjectCard {
  boardId: string;
  name: string;
  board: Board;
  latestRun?: Run;
  latestRunId?: string;
  latestRunAt?: string;
  thumbnail?: Artifact;
  thumbnailRunId?: string;
  thumbnailRunAt?: string;
  hasSuccessfulRun: boolean;
  nodeCount: number;
  edgeCount: number;
}

export interface AssetItem {
  id: string;
  boardId: string;
  boardName: string;
  nodeId: string;
  runId: string;
  startedAt: string;
  artifact: Artifact;
  kind: Artifact['kind'];
  url: string;
}

function startedAtValue(run: Run): number {
  const value = Date.parse(run.startedAt);
  return Number.isFinite(value) ? value : 0;
}

function latestRunForBoard(runs: Run[], boardId: string): Run | undefined {
  return runs
    .filter((run) => run.boardId === boardId)
    .sort((left, right) => startedAtValue(right) - startedAtValue(left))[0];
}

function firstSuccessfulArtifact(run: Run | undefined): Artifact | undefined {
  if (!run || run.status !== 'succeeded') return undefined;
  const orderedNodeIds = run.order.length ? run.order : Object.keys(run.results);
  for (const nodeId of orderedNodeIds) {
    const result = run.results[nodeId];
    if (result?.status !== 'succeeded') continue;
    const artifact = result.artifacts[0];
    if (artifact) return artifact;
  }
  return undefined;
}

export function deriveProjects(boards: Board[], runs: Run[]): ProjectCard[] {
  const boardRuns = new Map(boards.map((board) => [board.id, latestRunForBoard(runs, board.id)]));
  return boards
    .map((board, originalIndex) => {
      const latestRun = boardRuns.get(board.id);
      const thumbnailRun = runs
        .filter((run) => run.boardId === board.id && run.status === 'succeeded')
        .sort((left, right) => startedAtValue(right) - startedAtValue(left))[0];
      const thumbnail = firstSuccessfulArtifact(thumbnailRun);
      return {
        boardId: board.id,
        name: board.name,
        board,
        latestRun,
        latestRunId: latestRun?.id,
        latestRunAt: latestRun?.startedAt,
        thumbnail,
        thumbnailRunId: thumbnailRun?.id,
        thumbnailRunAt: thumbnailRun?.startedAt,
        hasSuccessfulRun: Boolean(thumbnail),
        nodeCount: board.nodes.length,
        edgeCount: board.edges.length,
        originalIndex,
      };
    })
    .sort((left, right) => {
      if (left.latestRun && right.latestRun) return startedAtValue(right.latestRun) - startedAtValue(left.latestRun);
      if (left.latestRun) return -1;
      if (right.latestRun) return 1;
      return left.originalIndex - right.originalIndex;
    })
    .map(({ originalIndex: _originalIndex, ...card }) => card);
}

export function deriveAssets(boards: Board[], runs: Run[]): AssetItem[] {
  const boardNames = new Map(boards.map((board) => [board.id, board.name]));
  return runs
    .filter((run) => run.status === 'succeeded' && boardNames.has(run.boardId))
    .sort((left, right) => startedAtValue(right) - startedAtValue(left))
    .flatMap((run) => {
      const nodeIds = run.order.length ? run.order : Object.keys(run.results);
      return nodeIds.flatMap((nodeId) => {
        const result = run.results[nodeId];
        if (result?.status !== 'succeeded') return [];
        return result.artifacts.map((artifact, index) => ({
          id: `${run.id}:${nodeId}:${index}`,
          boardId: run.boardId,
          boardName: boardNames.get(run.boardId) ?? '',
          nodeId,
          runId: run.id,
          startedAt: run.startedAt,
          artifact,
          kind: artifact.kind,
          url: artifact.url,
        }));
      });
    });
}
