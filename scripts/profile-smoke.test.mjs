import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProcessList, summarizeProcessTree } from './profile-smoke.mjs';

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
