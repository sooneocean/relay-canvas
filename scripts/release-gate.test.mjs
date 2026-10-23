import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseGate } from './release-gate.mjs';

const commit = 'a'.repeat(40);
const run = branch => ({ headSha: commit, headBranch: branch, workflowName: 'CI', event: 'push', status: 'completed', conclusion: 'success' });
const base = { stage: 'release', commit, head: commit, main: commit, version: '0.4.0', clean: true, archiveValid: true, mainRun: run('main'), tagExists: true, tagType: 'tag', tagCommit: commit, tagRun: run('v0.4.0'), releaseExists: false };

test('release prerequisites accept only the exact successful main and annotated-tag candidate', () => {
  assert.deepEqual(releaseGate(base), []);
  assert.deepEqual(releaseGate({ ...base, stage: 'tag', tagExists: false }), []);
  const failures = [
    { stage: 'invalid' }, { commit: 'invalid' }, { version: '0.4.0-rc.1' },
    { clean: false }, { head: 'b'.repeat(40) }, { main: 'b'.repeat(40) },
    { archiveValid: false }, { mainRun: undefined },
    { mainRun: { ...run('main'), conclusion: 'failure' } },
    { mainRun: { ...run('main'), status: 'in_progress', conclusion: '' } },
    { mainRun: { ...run('main'), headSha: 'b'.repeat(40) } },
    { mainRun: { ...run('main'), workflowName: 'Unrelated workflow' } },
    { mainRun: { ...run('main'), event: 'pull_request' } },
    { mainRun: run('other') }, { tagExists: false }, { tagType: 'commit' },
    { tagCommit: 'b'.repeat(40) }, { tagRun: undefined },
    { tagRun: { ...run('v0.4.0'), conclusion: 'failure' } },
    { tagRun: { ...run('v0.4.0'), headSha: 'b'.repeat(40) } },
    { tagRun: { ...run('v0.4.0'), status: 'queued' } },
    { tagRun: run('main') }, { releaseExists: true }, { releaseExists: undefined },
    { stage: 'tag', tagExists: true },
  ];
  for (const patch of failures) {
    const state = structuredClone({ ...base, ...patch });
    const before = structuredClone(state);
    assert.ok(releaseGate(state).length > 0, JSON.stringify(patch));
    assert.deepEqual(state, before, 'gate is read-only even on rejection');
  }
});
