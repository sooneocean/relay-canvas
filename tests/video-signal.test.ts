import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSignalstats, buildVideoSignalEvidence, type VideoSignalFrame,
} from '../src/shared/video-signal.js';

function frames(values: number[], diff = 12): VideoSignalFrame[] {
  return values.map((value, index) => ({
    index, timeMs: index * 500, yAverage: value, yDifference: index === 0 ? 0 : diff,
  }));
}
function metadata(values: number[], diff = 12) {
  return values.map((value, index) =>
    'frame:' + index + '    pts:' + index + '    pts_time:' + (index / 2) + '\n' +
    'lavfi.signalstats.YAVG=' + value + '\n' +
    'lavfi.signalstats.YDIF=' + (index === 0 ? 0 : diff) + '\n',
  ).join('');
}

test('parses bounded real FFmpeg signalstats format without arbitrary eval', () => {
  assert.deepEqual(parseSignalstats(metadata([16, 100, 235], 20)), frames([16, 100, 235], 20));
  assert.throws(() => parseSignalstats('not FFmpeg metadata'), /Invalid video signal evidence/);
  assert.throws(() => parseSignalstats(metadata([16, 100]) + 'frame:3 pts:3 pts_time:1.5\nlavfi.signalstats.YAVG=100\nlavfi.signalstats.YDIF=20\n'), /Invalid video signal evidence/);
  assert.throws(() => parseSignalstats(metadata([16, 300])), /Invalid video signal evidence/);
});

test('candidate with actual large brightness jump gets review observation, never auto approval', () => {
  const evidence = buildVideoSignalEvidence(frames([16, 16, 16, 235, 235, 235], 230), 3000);
  assert.ok(evidence.observations.some(o => o.kind === 'brightness_jump' && o.startMs === 1000 && o.endMs === 1500));
  assert.equal(evidence.autoApprovalEligible, false);
  assert.equal(evidence.scorerVersion, 'ffmpeg-signalstats-v1');
  assert.equal(evidence.coverageFraction, 1);
});

test('stationary shot gets only a tentative sustained-low-change observation', () => {
  const evidence = buildVideoSignalEvidence(frames([90, 90, 90, 90, 90, 90, 90], 0), 3500);
  assert.ok(evidence.observations.some(o => o.kind === 'sustained_low_change'));
  assert.equal(evidence.observations.every(o => o.interpretation === 'review_only'), true);
});

test('alternating bright/dark can be flagged as possible flicker but not classified as semantic drift', () => {
  const evidence = buildVideoSignalEvidence(frames([30, 220, 30, 220, 30, 220, 30], 180), 3500);
  assert.ok(evidence.observations.some(o => o.kind === 'luma_oscillation'));
  assert.equal(evidence.autoApprovalEligible, false);
});

test('incomplete decodes, malformed frame data and implausible cadence fail closed', () => {
  assert.throws(() => buildVideoSignalEvidence(frames([16, 20]), 5000), /incomplete decoder coverage/);
  assert.throws(() => buildVideoSignalEvidence(frames([16, 20]).map((v,i) => i ? { ...v, index: 0 } : v), 1000), /Invalid video signal evidence/);
  assert.throws(() => buildVideoSignalEvidence(frames([16, 20]).map((v,i) => i ? { ...v, yDifference: NaN } : v), 1000), /Invalid video signal evidence/);
  assert.throws(() => buildVideoSignalEvidence(frames([16, 20]).map((v,i) => i ? { ...v, timeMs: 2000 } : v), 3000), /Invalid video signal evidence/);
  assert.throws(() => buildVideoSignalEvidence(frames([16, 20]), 60001), /Invalid video signal evidence/);
});

test('screening reports do not mutate input and remain deterministic', () => {
  const frameList = frames([90, 95, 100, 105]);
  const before = structuredClone(frameList);
  const one = buildVideoSignalEvidence(frameList, 2000);
  const two = buildVideoSignalEvidence(frameList, 2000);
  assert.deepEqual(one, two);
  assert.deepEqual(frameList, before);
  assert.equal(one.observations.length, 0);
});
