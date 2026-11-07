import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSeedance25ExtensionPlan } from '../src/shared/seedance25-continuity.js';

const opts = {
  region: 'byteplus-ap-southeast' as const,
  previousVideoUrl: 'https://media.example.com/shot-0002.mov',
  originalReferenceImages: ['https://media.example.com/character-master.png'],
  instruction: 'The person gently turns left while camera follows without a cut.',
  durationSeconds: 8,
};

test('Seedance 2.5 plan preserves full video as extension reference and separate original image anchor', () => {
  const plan = buildSeedance25ExtensionPlan(opts);
  assert.equal(plan.purpose, 'extension_request_fixture_only');
  assert.equal(plan.request.model, 'dreamina-seedance-2-5-260628');
  assert.equal(plan.request.ratio, 'adaptive');
  assert.equal(plan.request.omni_reference_task_type, 'extend');
  assert.equal(plan.request.output_format, 'mov');
  assert.equal(plan.request.return_last_frame, true);
  assert.equal(plan.request.duration, 8);
  assert.deepEqual(plan.request.content.slice(1), [
    { type: 'video_url', video_url: { url: opts.previousVideoUrl }, role: 'reference_video' },
    { type: 'image_url', image_url: { url: opts.originalReferenceImages[0] }, role: 'reference_image' },
  ]);
  assert.match(plan.request.content[0].type === 'text' ? plan.request.content[0].text : '', /Continue @Video 1 forward/);
});

test('volcano region uses correct model and endpoint without duplicating images or extending by tail JPEG', () => {
  const plan = buildSeedance25ExtensionPlan({
    ...opts, region: 'volcengine-cn', additionalReferenceVideos: ['https://media.example.com/motion-reference.mov'],
  });
  assert.equal(plan.request.model, 'doubao-seedance-2-5-260628');
  assert.match(plan.endpoint, /^https:\/\/ark\.cn-beijing\.volces\.com\//);
  assert.deepEqual(plan.request.content.slice(1).map(item => item.type), ['video_url', 'video_url', 'image_url']);
  assert.equal(plan.request.content.filter(item => item.type === 'video_url').length, 2);
});

test('extension plan rejects unsafe URLs, illegal lengths, missing original anchor and excessive references', () => {
  const invalid = [
    { ...opts, previousVideoUrl: 'file:///etc/passwd' },
    { ...opts, previousVideoUrl: 'http://insecure.example.com/video.mp4' },
    { ...opts, originalReferenceImages: [] },
    { ...opts, originalReferenceImages: Array.from({ length: 31 }, () => opts.originalReferenceImages[0]) },
    { ...opts, additionalReferenceVideos: [opts.previousVideoUrl] },
    { ...opts, additionalReferenceVideos: Array.from({ length: 10 }, (_, i) => 'https://media.example.com/' + i + '.mov') },
    { ...opts, durationSeconds: 3 },
    { ...opts, durationSeconds: 31 },
    { ...opts, instruction: '' },
    { ...opts, generateAudio: 'yes' },
  ];
  for (const bad of invalid) assert.throws(() => buildSeedance25ExtensionPlan(bad as typeof opts), /Seedance|Invalid/);
});
