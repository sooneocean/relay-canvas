import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Read-only prerequisites. Publication commands belong after this command's
// successful exit; this module never creates tags, releases or uploads.
export function releaseGate(state) {
  const errors = [];
  if (!['tag', 'release'].includes(state.stage)) errors.push('Unknown release stage');
  if (!/^[a-f0-9]{40}$/.test(state.commit ?? '')) errors.push('Invalid commit');
  if (!/^\d+\.\d+\.\d+$/.test(state.version ?? '')) errors.push('A stable package version is required');
  if (!state.clean) errors.push('Working tree must be clean');
  if (state.head !== state.commit || state.main !== state.commit) errors.push('HEAD and remote main must match the candidate');
  if (!state.archiveValid) errors.push('Release archive and SHA-256 must agree');
  const green = (run, branch) => run?.headSha === state.commit && run.headBranch === branch && run.workflowName === 'CI' && run.event === 'push' && run.status === 'completed' && run.conclusion === 'success';
  if (!green(state.mainRun, 'main')) errors.push('Exact-commit main CI must succeed');
  if (state.stage === 'tag' && state.tagExists) errors.push('Tag already exists; never move a published tag');
  if (state.stage === 'release') {
    if (!state.tagExists || state.tagType !== 'tag' || state.tagCommit !== state.commit) errors.push('An annotated tag must point to the candidate');
    if (!green(state.tagRun, `v${state.version}`)) errors.push('Exact-commit tag CI must succeed');
    if (state.releaseExists !== false) errors.push('Release absence must be verified; never replace an existing release');
  }
  return errors;
}

function command(name, args) {
  const result = spawnSync(name, args, { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30000, shell: false });
  if (result.error || result.status !== 0) throw new Error('Could not verify release prerequisites');
  return result.stdout.trim();
}
function optionalApi(endpoint) {
  const result = spawnSync('gh', ['api', endpoint], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30000, shell: false });
  if (!result.error && result.status === 0) return JSON.parse(result.stdout);
  if (!result.error && /HTTP 404/.test(result.stderr ?? '')) return null;
  throw new Error('Could not verify remote release state');
}
async function main() {
  const [stage, commit] = process.argv.slice(2);
  if (!['tag', 'release'].includes(stage) || !/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Usage: node scripts/release-gate.mjs tag|release <40-hex-commit>');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? '') || pkg.name !== 'relay-canvas') throw new Error('Invalid package identity');
  const archiveName = `${pkg.name}-${pkg.version}.tar.gz`;
  const digest = createHash('sha256').update(readFileSync(path.join('release', archiveName))).digest('hex');
  const checksum = readFileSync(path.join('release', `${archiveName}.sha256`), 'utf8');
  const repo = command('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  if (repo !== 'sooneocean/relay-canvas') throw new Error('Unexpected release repository');
  const tag = `v${pkg.version}`;
  const tagRef = optionalApi(`repos/${repo}/git/ref/tags/${tag}`);
  const tagObject = tagRef?.object?.type === 'tag' ? optionalApi(`repos/${repo}/git/tags/${tagRef.object.sha}`) : null;
  const runs = JSON.parse(command('gh', ['run', 'list', '--repo', repo, '--commit', commit, '--limit', '100', '--json', 'databaseId,headSha,headBranch,workflowName,event,status,conclusion']));
  const latest = branch => runs.filter(run => run.headBranch === branch && run.workflowName === 'CI' && run.event === 'push').sort((a, b) => b.databaseId - a.databaseId)[0];
  const state = {
    stage, commit, version: pkg.version,
    head: command('git', ['rev-parse', 'HEAD']),
    main: JSON.parse(command('gh', ['api', `repos/${repo}/git/ref/heads/main`])).object?.sha,
    clean: command('git', ['status', '--porcelain']) === '',
    archiveValid: checksum === `${digest}  ${archiveName}\n`,
    mainRun: latest('main'), tagRun: latest(tag),
    tagExists: tagRef !== null, tagType: tagRef?.object?.type,
    tagCommit: tagObject?.object?.type === 'commit' ? tagObject.object.sha : null,
    releaseExists: stage === 'release' ? optionalApi(`repos/${repo}/releases/tags/${tag}`) !== null : undefined,
  };
  const errors = releaseGate(state);
  if (errors.length) throw new Error(errors.join('; '));
  console.log(JSON.stringify({ ready: true, stage, commit, version: pkg.version, archiveSha256: digest }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
