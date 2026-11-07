import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSeamPixels, type VideoColorMetadata } from '../src/shared/video-seam.js';

const profile = (pix = 'yuv444p', fps = 24): VideoColorMetadata => ({
  codec: 'h264', pixelFormat: pix, width: 320, height: 240, durationSeconds: 2,
  fps: { numerator: fps, denominator: 1 }, colorPrimaries: 'bt709',
  colorTransfer: 'bt709', colorSpace: 'bt709', colorRange: 'tv',
});
const rgb = (r: number, g: number, b: number) =>
  Uint8Array.from({ length: 64 * 36 * 3 }, (_, i) => [r, g, b][i % 3]);

test('same boundary frame has zero photometric seam and never auto-approves continuity', () => {
  const a = rgb(120, 40, 20);
  const value = compareSeamPixels(a, a, profile(), profile());
  assert.equal(value.photometric.meanAbsoluteRgbDifference, 0);
  assert.equal(value.photometric.p95AbsoluteRgbDifference, 0);
  assert.equal(value.fpsChanged, false);
  assert.equal(value.colorMetadataStatus, 'comparable');
  assert.equal(value.autoApprovalEligible, false);
});
test('color and frame-rate changes are evidence, not a claim of generative drift', () => {
  const changed = compareSeamPixels(rgb(255, 0, 0), rgb(0, 0, 255),
    profile(), profile('yuv420p', 30));
  assert.ok(changed.photometric.meanAbsoluteRgbDifference > 0.6);
  assert.equal(changed.pixelFormatChanged, true);
  assert.equal(changed.fpsChanged, true);
  assert.equal(changed.colorMetadataStatus, 'comparable');
});
test('unspecified or mismatched color tags prevent unsupported color equivalence claims', () => {
  const base = profile();
  const unspecified = { ...base, colorPrimaries: null };
  const mismatch = { ...base, colorPrimaries: 'bt2020' };
  assert.equal(compareSeamPixels(rgb(0,0,0), rgb(0,0,0), base, unspecified).colorMetadataStatus, 'unspecified');
  assert.equal(compareSeamPixels(rgb(0,0,0), rgb(0,0,0), base, mismatch).colorMetadataStatus, 'mismatch');
});
test('truncated input and invalid metadata fail rather than produce artificial confidence', () => {
  assert.throws(() => compareSeamPixels(new Uint8Array(4), rgb(0,0,0), profile(), profile()));
  assert.throws(() => compareSeamPixels(rgb(0,0,0), rgb(0,0,0), { ...profile(), fps: { numerator: 0, denominator: 1 } }, profile()));
});
