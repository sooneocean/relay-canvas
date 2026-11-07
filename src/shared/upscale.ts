import type { ClipSource, MediaInfo } from './types.js';

export const UPSCALE_PRESET = 'lanczos_1080p' as const;
export type UpscalePreset = typeof UPSCALE_PRESET;

export interface UpscaleDescriptor {
  preset: UpscalePreset;
  source: ClipSource;
  sourceSha256: string;
}

/**
 * Output FITS within a 1920x1080 landscape or 1080x1920 portrait box.
 * This is a non-generative resampling path, not detail reconstruction.
 */
export function upscaleBounds(media: Pick<MediaInfo, 'width' | 'height'>): { width: number; height: number; factor: number } {
  if (!Number.isInteger(media.width) || !Number.isInteger(media.height) ||
      media.width < 64 || media.height < 64 ||
      media.width > 3840 || media.height > 3840) throw new Error('Unsupported upscale dimensions');
  const portrait = media.height > media.width;
  const width = portrait ? 1080 : 1920;
  const height = portrait ? 1920 : 1080;
  const factor = Math.min(width / media.width, height / media.height);
  if (!Number.isFinite(factor) || factor <= 1.01) throw new Error('Source is already at or above target dimensions');
  if (factor > 8) throw new Error('Requested resize is too large for preservation mode');
  return { width, height, factor };
}
