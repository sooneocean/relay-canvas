import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProcessList, summarizeProcessTree } from './profile-smoke.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const sample = [
  '    100    1   1024 node',
  '    101  100   8192 chromium',
  '    102  101   4096 chrome',
  '    103  100   2048 ffmpeg',
  '    104    1 100000 random-job',
  '',
].join('\n');

test('ps parser reads portable PID/PPID/RSS/command rows', () => {
  const rows = parseProcessList(sample);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], { pid: 100, ppid: 1, rssKiB: 1024, command: 'node' });
});

test('tree RSS includes grandchildren, excludes unrelated processes', () => {
  const summary = summarizeProcessTree(parseProcessList(sample), 100);
  assert.equal(summary.processCount, 4);
  assert.equal(summary.rssKiB, 15360);
  assert.equal(summary.browserRssKiB, 12288);
  assert.equal(summary.ffmpegRssKiB, 2048);
  assert.equal(summary.top[0].pid, 101);
});

test('missing process has unavailable empty snapshot', () => {
  assert.deepEqual(summarizeProcessTree(parseProcessList(sample), 999), { processCount: 0, rssKiB: 0, browserRssKiB: 0, ffmpegRssKiB: 0, top: [] });
});

test('reparented and sibling processes are excluded', () => {
  const rows = parseProcessList(sample);
  rows.push({ pid: 200, ppid: 104, rssKiB: 4096, command: 'FFmpeg-other-job' });
  const summary = summarizeProcessTree(rows, 100);
  assert.equal(summary.rssKiB, 15360);
});

test('quick failing child during slow first ps sample exits nonzero and writes FAIL profile', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'relay-rss-regression-'));
  try {
    const ps = (process.env.PATH ?? '').split(path.delimiter)
      .map(entry => path.join(entry, 'ps')).find(existsSync);
    assert.ok(ps, 'ps executable is available on Linux/macOS');
    writeFileSync(path.join(directory, 'ps'), `#!/bin/sh\nsleep 1\nexec "${ps}" "$@"\n`, { mode: 0o755 });
    const wrapper = fileURLToPath(new URL('./profile-smoke.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [wrapper, 'early-exit', 'scripts/does-not-exist.ts'], {
      cwd: directory,
      env: { ...process.env, PATH: directory + path.delimiter + (process.env.PATH ?? '') },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.notEqual(result.status, 0, 'a failing smoke must not be reported as passing');
    const report = JSON.parse(readFileSync(path.join(directory, 'work', 'e2e-profile-early-exit.json'), 'utf8'));
    assert.equal(report.status, 'FAIL');
    assert.notEqual(report.exitCode, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
