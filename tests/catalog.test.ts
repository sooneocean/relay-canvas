import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAssets, deriveProjects } from '../src/ui/catalog.js';
import type { Artifact, Board, NodeResult, Run } from '../src/shared/types.js';

const artifact = (kind: Artifact['kind'], url: string): Artifact => ({ kind, url });

function board(id: string, name = id): Board {
  return {
    schemaVersion: 1,
    id,
    name,
    revision: 1,
    nodes: [
      { id: `${id}-input`, type: 'canvas', position: { x: 0, y: 0 }, data: { kind: 'prompt', label: 'Input' } },
      { id: `${id}-output`, type: 'canvas', position: { x: 1, y: 1 }, data: { kind: 'image', label: 'Output' } },
    ],
    edges: [{ id: `${id}-edge`, source: `${id}-input`, target: `${id}-output` }],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function run(
  id: string,
  boardId: string,
  startedAt: string,
  status: Run['status'],
  order: string[],
  results: Record<string, NodeResult>,
  revision = 1,
): Run {
  return {
    id,
    boardId,
    revision,
    operationId: `${id}-operation`,
    status,
    startedAt,
    snapshot: board(boardId),
    providers: [],
    order,
    results,
  };
}

function result(nodeId: string, status: NodeResult['status'], artifacts: Artifact[]): NodeResult {
  return { nodeId, status, artifacts };
}

test('projects sort run boards by latest run, keep no-run order, and retain older successful thumbnails', () => {
  const boards = [board('no-run', 'No run'), board('alpha', 'Alpha'), board('failed-only', 'Failed only'), board('beta', 'Beta')];
  const oldThumbnail = artifact('image', 'https://media.example.com/alpha-old.png');
  const alphaRuns = [
    run('alpha-success', 'alpha', '2026-10-20T09:00:00.000Z', 'succeeded', ['alpha-input', 'alpha-output'], {
      'alpha-input': result('alpha-input', 'succeeded', [oldThumbnail, artifact('image', 'https://media.example.com/alpha-second.png')]),
      'alpha-output': result('alpha-output', 'succeeded', [artifact('video', 'https://media.example.com/alpha-video.mp4')]),
    }, 1),
    run('alpha-failed', 'alpha', '2026-10-23T09:00:00.000Z', 'failed', ['alpha-input'], {
      'alpha-input': result('alpha-input', 'failed', []),
    }, 2),
  ];
  const betaThumbnail = artifact('video', 'https://media.example.com/beta.mp4');
  const runs = [
    ...alphaRuns,
    run('failed-only-run', 'failed-only', '2026-10-22T09:00:00.000Z', 'failed', ['failed-only-input'], {
      'failed-only-input': result('failed-only-input', 'failed', []),
    }),
    run('beta-success', 'beta', '2026-10-24T09:00:00.000Z', 'succeeded', ['beta-input', 'beta-output'], {
      'beta-input': result('beta-input', 'failed', []),
      'beta-output': result('beta-output', 'succeeded', [betaThumbnail]),
    }),
  ];

  const projects = deriveProjects(boards, runs);

  assert.deepEqual(projects.map(project => project.boardId), ['beta', 'alpha', 'failed-only', 'no-run']);
  assert.equal(projects[0].latestRunId, 'beta-success');
  assert.equal(projects[0].thumbnail, betaThumbnail);
  assert.equal(projects[0].hasSuccessfulRun, true);
  assert.equal(projects[1].latestRunId, 'alpha-failed');
  assert.equal(projects[1].thumbnail, oldThumbnail);
  assert.equal(projects[1].hasSuccessfulRun, true);
  assert.equal(projects[2].latestRunId, 'failed-only-run');
  assert.equal(projects[2].thumbnail, undefined);
  assert.equal(projects[2].hasSuccessfulRun, false);
  assert.equal(projects[3].latestRun, undefined);
  assert.equal(projects[3].thumbnail, undefined);
  assert.equal(projects[3].hasSuccessfulRun, false);
});

test('assets include only existing boards and succeeded results, preserving run, node, and artifact order', () => {
  const boards = [board('alpha', 'Alpha'), board('beta', 'Beta')];
  const alphaArtifact = artifact('image', 'https://media.example.com/alpha.png');
  const betaFirst = artifact('video', 'https://media.example.com/beta-first.mp4');
  const betaSecond = artifact('image', 'https://media.example.com/beta-second.png');
  const runs = [
    run('orphan-success', 'deleted-board', '2026-10-25T09:00:00.000Z', 'succeeded', ['orphan-node'], {
      'orphan-node': result('orphan-node', 'succeeded', [artifact('image', 'https://media.example.com/orphan.png')]),
    }),
    run('alpha-failed', 'alpha', '2026-10-24T09:00:00.000Z', 'failed', ['alpha-node'], {
      'alpha-node': result('alpha-node', 'succeeded', [artifact('image', 'https://media.example.com/failed-run.png')]),
    }),
    run('beta-success', 'beta', '2026-10-23T09:00:00.000Z', 'succeeded', ['beta-second', 'beta-first'], {
      'beta-first': result('beta-first', 'succeeded', [betaFirst, betaSecond]),
      'beta-second': result('beta-second', 'succeeded', [artifact('image', 'https://media.example.com/beta-node.png')]),
    }),
    run('alpha-success', 'alpha', '2026-10-22T09:00:00.000Z', 'succeeded', ['alpha-node', 'ignored-node'], {
      'alpha-node': result('alpha-node', 'succeeded', [alphaArtifact]),
      'ignored-node': result('ignored-node', 'failed', [artifact('image', 'https://media.example.com/ignored.png')]),
    }),
  ];

  const assets = deriveAssets(boards, runs);

  assert.deepEqual(assets.map(asset => asset.id), [
    'beta-success:beta-second:0',
    'beta-success:beta-first:0',
    'beta-success:beta-first:1',
    'alpha-success:alpha-node:0',
  ]);
  assert.deepEqual(assets.map(asset => ({ boardId: asset.boardId, boardName: asset.boardName, nodeId: asset.nodeId, runId: asset.runId, startedAt: asset.startedAt, url: asset.url })), [
    { boardId: 'beta', boardName: 'Beta', nodeId: 'beta-second', runId: 'beta-success', startedAt: '2026-10-23T09:00:00.000Z', url: 'https://media.example.com/beta-node.png' },
    { boardId: 'beta', boardName: 'Beta', nodeId: 'beta-first', runId: 'beta-success', startedAt: '2026-10-23T09:00:00.000Z', url: 'https://media.example.com/beta-first.mp4' },
    { boardId: 'beta', boardName: 'Beta', nodeId: 'beta-first', runId: 'beta-success', startedAt: '2026-10-23T09:00:00.000Z', url: 'https://media.example.com/beta-second.png' },
    { boardId: 'alpha', boardName: 'Alpha', nodeId: 'alpha-node', runId: 'alpha-success', startedAt: '2026-10-22T09:00:00.000Z', url: 'https://media.example.com/alpha.png' },
  ]);
  assert.deepEqual(assets[0].artifact, { kind: 'image', url: 'https://media.example.com/beta-node.png' });
  assert.deepEqual(assets[1].artifact, betaFirst);
});

test('catalog derivation does not mutate boards or runs', () => {
  const boards = [board('alpha'), board('beta')];
  const runs = [run('beta-run', 'beta', '2026-10-23T09:00:00.000Z', 'succeeded', ['beta-output'], {
    'beta-output': result('beta-output', 'succeeded', [artifact('image', 'https://media.example.com/beta.png')]),
  })];
  const boardsBefore = structuredClone(boards);
  const runsBefore = structuredClone(runs);

  deriveProjects(boards, runs);
  deriveAssets(boards, runs);

  assert.deepEqual(boards, boardsBefore);
  assert.deepEqual(runs, runsBefore);
});
