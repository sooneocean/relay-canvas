/**
 * Offline-only Seedance 2.5 extension request planner, based on official
 * BytePlus/Volcano Engine reference_video + reference_image contracts.
 *
 * This module NEVER sends requests and MUST NOT be called a verified paid
 * provider adapter. A real dispatcher must securely host/verify input media,
 * check official account availability, explicitly confirm payment and ensure
 * output artifacts (especially MOV) are ingested without lossy transcodes.
 */
export type SeedanceRegion = 'byteplus-ap-southeast' | 'volcengine-cn';
export interface SeedanceExtensionOptions {
  region: SeedanceRegion;
  previousVideoUrl: string;
  originalReferenceImages: readonly string[];
  additionalReferenceVideos?: readonly string[];
  instruction: string;
  durationSeconds: number;
  generateAudio?: boolean;
}
type VideoRef = { type: 'video_url'; role: 'reference_video'; video_url: { url: string } };
type ImageRef = { type: 'image_url'; role: 'reference_image'; image_url: { url: string } };
export interface SeedanceExtensionPlan {
  endpoint: string;
  request: {
    model: 'dreamina-seedance-2-5-260628' | 'doubao-seedance-2-5-260628';
    content: Array<{ type: 'text'; text: string } | VideoRef | ImageRef>;
    ratio: 'adaptive';
    duration: number;
    omni_reference_task_type: 'extend';
    output_format: 'mov';
    return_last_frame: true;
    generate_audio: boolean;
  };
  purpose: 'extension_request_fixture_only';
  limits: { maxReferenceImages: 30; maxReferenceVideos: 10 };
}

function safeUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length < 9 || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname.length > 0 &&
      !parsed.username && !parsed.password && !parsed.hash;
  } catch { return false; }
}

/**
 * Always include the actual video context and independently authored original
 * images. Do NOT replace the whole video with a repeatedly transcoded JPEG
 * of the previous clip's last frame.
 */
export function buildSeedance25ExtensionPlan(options: SeedanceExtensionOptions): SeedanceExtensionPlan {
  if (!options || !['byteplus-ap-southeast', 'volcengine-cn'].includes(options.region)) {
    throw new Error('Unsupported Seedance region');
  }
  const images = options.originalReferenceImages;
  const otherVideos = options.additionalReferenceVideos ?? [];
  if (!Array.isArray(images) || images.length < 1 || images.length > 30 ||
      !Array.isArray(otherVideos) || otherVideos.length > 9 ||
      !safeUrl(options.previousVideoUrl) ||
      [...images, ...otherVideos].some(url => !safeUrl(url))) {
    throw new Error('Seedance references must be bounded HTTPS URLs');
  }
  if (new Set([options.previousVideoUrl, ...otherVideos]).size !== otherVideos.length + 1) {
    throw new Error('Duplicate Seedance video reference');
  }
  if (typeof options.instruction !== 'string' || options.instruction.trim().length < 3 ||
      options.instruction.length > 2000 ||
      !Number.isSafeInteger(options.durationSeconds) ||
      options.durationSeconds < 4 || options.durationSeconds > 30) {
    throw new Error('Invalid Seedance extension instruction or duration');
  }
  if (options.generateAudio !== undefined && typeof options.generateAudio !== 'boolean') {
    throw new Error('Invalid Seedance audio flag');
  }
  const isByteplus = options.region === 'byteplus-ap-southeast';
  const endpoint = isByteplus
    ? 'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks'
    : 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks';
  const prompt = [
    'Continue @Video 1 forward. Maintain the same character identity, costume, scene geometry,',
    'lighting color temperature, movement direction, camera continuity, and intended visual style.',
    'Use the original @Image references only as persistent appearance anchors, not as new scenes.',
    options.instruction.trim(),
  ].join(' ');
  const videos: VideoRef[] = [options.previousVideoUrl, ...otherVideos].map(url => ({
    type: 'video_url', video_url: { url }, role: 'reference_video',
  }));
  const refs: ImageRef[] = images.map(url => ({
    type: 'image_url', image_url: { url }, role: 'reference_image',
  }));
  return {
    endpoint,
    request: {
      model: isByteplus ? 'dreamina-seedance-2-5-260628' : 'doubao-seedance-2-5-260628',
      content: [{ type: 'text', text: prompt }, ...videos, ...refs],
      ratio: 'adaptive', duration: options.durationSeconds,
      omni_reference_task_type: 'extend',
      output_format: 'mov',
      return_last_frame: true,
      generate_audio: options.generateAudio ?? false,
    },
    purpose: 'extension_request_fixture_only',
    limits: { maxReferenceImages: 30, maxReferenceVideos: 10 },
  };
}


/**
 * Official Seedance 2.5 Draft -> 1080p final task plan.
 * Reuses Draft task conditioning/model state server-side. Do not resend original
 * references, prompt, duration or seed when finalizing a Draft.
 */
export function buildSeedance25DraftFinalPlan(region: SeedanceRegion, draftTaskId: string): {
  endpoint: string;
  request: {
    model: 'dreamina-seedance-2-5-260628' | 'doubao-seedance-2-5-260628';
    content: [{ type: 'draft_task'; draft_task: { id: string } }];
    resolution: '1080p';
    output_format: 'mov';
    return_last_frame: true;
  };
  purpose: 'draft_final_fixture_only';
} {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(draftTaskId)) throw new Error('Invalid Seedance draft task ID');
  const seed = buildSeedance25ExtensionPlan({
    region,
    previousVideoUrl: 'https://example.com/draft-fixture.mov',
    originalReferenceImages: ['https://example.com/anchor-fixture.png'],
    instruction: 'Continue the scene.',
    durationSeconds: 4,
  });
  return {
    endpoint: seed.endpoint,
    request: {
      model: seed.request.model,
      content: [{ type: 'draft_task', draft_task: { id: draftTaskId } }],
      resolution: '1080p', output_format: 'mov', return_last_frame: true,
    },
    purpose: 'draft_final_fixture_only',
  };
}
