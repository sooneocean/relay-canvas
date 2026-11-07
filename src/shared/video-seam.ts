/**
 * Frame-boundary continuity evidence. Scores are photometric observations,
 * NOT identity, geometry, optical-flow, narrative or physical continuity proof.
 * Each RGB sample is decoded by FFmpeg into the same 64x36 working buffer.
 */
export interface VideoColorMetadata {
  codec: string;
  pixelFormat: string;
  colorPrimaries: string | null;
  colorTransfer: string | null;
  colorSpace: string | null;
  colorRange: string | null;
  fps: { numerator: number; denominator: number };
  width: number;
  height: number;
  durationSeconds: number;
}

export interface VideoSeamEvidence {
  schemaVersion: 1;
  scorerVersion: 'rgb64-boundary-v1';
  sample: { width: 64; height: 36 };
  source: VideoColorMetadata;
  continuation: VideoColorMetadata;
  photometric: {
    meanAbsoluteRgbDifference: number;
    p95AbsoluteRgbDifference: number;
    meanColorDelta: { red: number; green: number; blue: number };
  };
  fpsChanged: boolean;
  pixelFormatChanged: boolean;
  colorMetadataStatus: 'comparable' | 'mismatch' | 'unspecified';
  autoApprovalEligible: false;
  limitations: string[];
}
const WIDTH = 64, HEIGHT = 36, BYTES = WIDTH * HEIGHT * 3;
const round = (value: number) => Number(value.toFixed(6));

function consistentColorStatus(a: VideoColorMetadata, b: VideoColorMetadata): VideoSeamEvidence['colorMetadataStatus'] {
  const props = ['colorPrimaries', 'colorTransfer', 'colorSpace', 'colorRange'] as const;
  if (props.some(key => !a[key] || !b[key])) return 'unspecified';
  return props.every(key => a[key] === b[key]) ? 'comparable' : 'mismatch';
}
export function compareSeamPixels(
  previousRgb: Uint8Array,
  nextRgb: Uint8Array,
  previous: VideoColorMetadata,
  next: VideoColorMetadata,
): VideoSeamEvidence {
  if (!(previousRgb instanceof Uint8Array) || !(nextRgb instanceof Uint8Array) ||
      previousRgb.length !== BYTES || nextRgb.length !== BYTES) {
    throw new Error('Invalid 64x36 RGB video seam frame');
  }
  const fpsValid = (p: VideoColorMetadata) =>
    Number.isSafeInteger(p.fps.numerator) && Number.isSafeInteger(p.fps.denominator) &&
    p.fps.numerator > 0 && p.fps.denominator > 0 && p.width > 0 &&
    p.height > 0 && Number.isFinite(p.durationSeconds) && p.durationSeconds > 0;
  if (!fpsValid(previous) || !fpsValid(next)) throw new Error('Invalid video seam source metadata');
  let sum = 0; const differences = new Array<number>(BYTES), channelSums = [0, 0, 0];
  for (let i = 0; i < BYTES; i += 1) {
    const diff = Math.abs(previousRgb[i] - nextRgb[i]) / 255;
    differences[i] = diff; sum += diff;
    channelSums[i % 3] += (nextRgb[i] - previousRgb[i]) / 255;
  }
  differences.sort((a, b) => a - b);
  return {
    schemaVersion: 1, scorerVersion: 'rgb64-boundary-v1',
    sample: { width: WIDTH, height: HEIGHT },
    source: previous, continuation: next,
    photometric: {
      meanAbsoluteRgbDifference: round(sum / BYTES),
      p95AbsoluteRgbDifference: round(differences[Math.ceil(0.95 * BYTES) - 1]),
      meanColorDelta: {
        red: round(channelSums[0] / (BYTES / 3)),
        green: round(channelSums[1] / (BYTES / 3)),
        blue: round(channelSums[2] / (BYTES / 3)),
      },
    },
    fpsChanged: previous.fps.numerator * next.fps.denominator !== next.fps.numerator * previous.fps.denominator,
    pixelFormatChanged: previous.pixelFormat !== next.pixelFormat,
    colorMetadataStatus: consistentColorStatus(previous, next),
    autoApprovalEligible: false,
    limitations: [
      'First/last frame RGB pixel difference is not motion compensated; intentional camera movement and cuts may look discontinuous.',
      'Unknown color tags cannot establish accurate color-space equivalence; no color assumptions are invented.',
      'Sampling one frame on either side cannot prove identity, geometry, motion direction, or generative drift.',
    ],
  };
}
