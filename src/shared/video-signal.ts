/**
 * Read-only video signal evidence. This is NOT an identity, geometry or semantic
 * drift detector. Scene cuts, stationary shots and intentional flashes may be
 * flagged. No score here is approved for automatic verification.
 */
export interface VideoSignalFrame {
  index: number;
  timeMs: number;
  yAverage: number;
  yDifference: number;
}
export type SignalObservationKind =
  | 'brightness_jump' | 'sustained_low_change' | 'luma_oscillation';
export interface VideoSignalObservation {
  kind: SignalObservationKind;
  startMs: number;
  endMs: number;
  strength: number;
  interpretation: 'review_only';
}
export interface VideoSignalEvidence {
  schemaVersion: 1;
  scorerVersion: 'ffmpeg-signalstats-v1';
  sampleRateHz: 2;
  width: 64;
  height: 36;
  durationMs: number;
  coverageFraction: number;
  totalFrames: number;
  meanYDifference: number;
  peakYDifference: number;
  observations: VideoSignalObservation[];
  frames: VideoSignalFrame[];
  autoApprovalEligible: false;
  limitations: string[];
}
const MAX_FRAMES = 120;
const MAX_METADATA_LENGTH = 256 * 1024;
const MAX_Y = 255;

function valid(value: unknown, lower: number, upper: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= lower && value <= upper;
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error('Invalid video signal evidence: ' + message);
}

/** Strict, bounded parser for FFmpeg metadata=print output (YAVG/YDIF). */
export function parseSignalstats(text: string): VideoSignalFrame[] {
  requireValue(typeof text === 'string' && text.length <= MAX_METADATA_LENGTH, 'metadata length');
  const blocks = text.split(/(?=^frame:\d+\s+pts:)/m).filter(s => s.trim());
  requireValue(blocks.length >= 2 && blocks.length <= MAX_FRAMES, 'frame count');
  const frames = blocks.map((block, index) => {
    const header = /^frame:(\d+)\s+pts:\S+\s+pts_time:([0-9]+(?:\.[0-9]+)?)/m.exec(block);
    const mean = /^lavfi\.signalstats\.YAVG=([0-9]+(?:\.[0-9]+)?)$/m.exec(block);
    const diff = /^lavfi\.signalstats\.YDIF=([0-9]+(?:\.[0-9]+)?)$/m.exec(block);
    requireValue(header && mean && diff && Number(header[1]) === index, 'frame metadata');
    const timeMs = Math.round(Number(header[2]) * 1000);
    const yAverage = Number(mean[1]), yDifference = Number(diff[1]);
    requireValue(Number.isSafeInteger(timeMs) && valid(timeMs, 0, 60_500), 'time');
    requireValue(valid(yAverage, 0, MAX_Y) && valid(yDifference, 0, MAX_Y), 'luminance');
    if (index > 0) {
      const prior = Number(/^frame:\d+\s+pts:\S+\s+pts_time:([0-9]+(?:\.[0-9]+)?)/m.exec(blocks[index - 1])?.[1]);
      requireValue(Number.isFinite(prior) && timeMs > Math.round(prior * 1000), 'non-monotonic timestamp');
    }
    return { index, timeMs, yAverage, yDifference };
  });
  requireValue(frames[0].timeMs <= 500, 'missing first sample');
  return frames;
}

/**
 * A deterministic screening report from decoded frame metadata.
 * Thresholds are tentative and intentionally return observations, not failures.
 */
export function buildVideoSignalEvidence(
  frames: readonly VideoSignalFrame[],
  durationMs: number,
): VideoSignalEvidence {
  requireValue(Number.isSafeInteger(durationMs) && valid(durationMs, 1000, 60_000), 'duration');
  requireValue(Array.isArray(frames) && frames.length >= 2 && frames.length <= MAX_FRAMES, 'frames');
  let totalYDifference = 0, peakYDifference = 0;
  for (const [index, frame] of frames.entries()) {
    requireValue(frame.index === index &&
      Number.isSafeInteger(frame.timeMs) && valid(frame.timeMs, 0, 60_500) &&
      valid(frame.yAverage, 0, MAX_Y) && valid(frame.yDifference, 0, MAX_Y), 'frame');
    if (index > 0) requireValue(frame.timeMs > frames[index - 1].timeMs &&
      frame.timeMs - frames[index - 1].timeMs >= 300 &&
      frame.timeMs - frames[index - 1].timeMs <= 750, 'sample cadence');
    if (index > 0) {
      totalYDifference += frame.yDifference;
      peakYDifference = Math.max(peakYDifference, frame.yDifference);
    }
  }
  const coverageFraction = Math.min(1, (frames[frames.length - 1].timeMs + 500) / durationMs);
  requireValue(coverageFraction >= 0.90, 'incomplete decoder coverage');
  const observations: VideoSignalObservation[] = [];

  let lowStart = -1;
  for (let index = 1; index < frames.length; index++) {
    const frame = frames[index], prev = frames[index - 1];
    const lumaJump = Math.abs(frame.yAverage - prev.yAverage) / MAX_Y;
    const pixelChange = frame.yDifference / MAX_Y;
    if (lumaJump >= 0.28 && pixelChange >= 0.24) {
      observations.push({
        kind: 'brightness_jump', startMs: prev.timeMs, endMs: frame.timeMs,
        strength: Math.max(lumaJump, pixelChange), interpretation: 'review_only',
      });
    }
    if (pixelChange <= 0.004) {
      if (lowStart < 0) lowStart = index - 1;
    } else if (lowStart >= 0) {
      if (index - lowStart >= 5) observations.push({
        kind: 'sustained_low_change', startMs: frames[lowStart].timeMs,
        endMs: frames[index - 1].timeMs,
        strength: 1 - Math.max(...frames.slice(lowStart + 1, index).map(f => f.yDifference / MAX_Y)),
        interpretation: 'review_only',
      });
      lowStart = -1;
    }
  }
  if (lowStart >= 0 && frames.length - lowStart >= 5) observations.push({
    kind: 'sustained_low_change', startMs: frames[lowStart].timeMs,
    endMs: frames[frames.length - 1].timeMs,
    strength: 1 - Math.max(...frames.slice(lowStart + 1).map(f => f.yDifference / MAX_Y)),
    interpretation: 'review_only',
  });

  // Detect high-amplitude alternating global luminance: possible flicker,
  // but camera cuts and flashing lights can create the same evidence.
  for (let index = 4; index < frames.length; index++) {
    const deltas = Array.from({ length: 4 }, (_, i) =>
      frames[index - 3 + i].yAverage - frames[index - 4 + i].yAverage);
    if (deltas.every(delta => Math.abs(delta) >= 36) &&
      deltas.every((delta, i) => i === 0 || delta * deltas[i - 1] < 0)) {
      observations.push({
        kind: 'luma_oscillation', startMs: frames[index - 4].timeMs,
        endMs: frames[index].timeMs, strength: Math.min(1, Math.min(...deltas.map(Math.abs)) / 128),
        interpretation: 'review_only',
      });
    }
  }

  return {
    schemaVersion: 1, scorerVersion: 'ffmpeg-signalstats-v1',
    sampleRateHz: 2, width: 64, height: 36, durationMs,
    coverageFraction: Number(coverageFraction.toFixed(4)),
    totalFrames: frames.length,
    meanYDifference: Number((totalYDifference / (frames.length - 1)).toFixed(5)),
    peakYDifference: Number(peakYDifference.toFixed(5)),
    observations, frames: frames.map(frame => ({ ...frame })),
    autoApprovalEligible: false,
    limitations: [
      'Frame-sampling signal only; not identity, optical-flow, semantic, or 3D consistency validation.',
      'Brightness changes, cuts, static scenes, and intended flashing may trigger observations.',
      'Cannot certify that candidate footage is consistent with an anchor or human intent.',
    ],
  };
}
