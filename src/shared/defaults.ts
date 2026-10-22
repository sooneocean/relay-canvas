import type { Board, Provider } from './types.js';
export function recommendedReferenceField(model: string): string {
  if (model.startsWith('fal-ai/kling-video/v3/')) return 'start_image_url';
  if (model === 'minimax/video-01') return 'first_frame_image';
  return 'image_url';
}
export const providers: Provider[] = [
  { id: 'demo', name: 'Demo Studio', protocol: 'demo', baseUrl: '', keyEnv: '', imageModel: 'demo-image', videoModel: 'demo-video' },
  { id: 'openai', name: 'OpenAI compatible', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', keyEnv: 'RELAY_KEY_OPENAI', imageModel: 'gpt-image-1', videoModel: '' },
  { id: 'newapi', name: 'New API / One API', protocol: 'openai', baseUrl: '', keyEnv: 'RELAY_KEY_NEWAPI', imageModel: 'gpt-image-1', videoModel: '' },
  { id: 'fal', name: 'fal.ai', protocol: 'fal', baseUrl: 'https://queue.fal.run', keyEnv: 'RELAY_KEY_FAL', imageModel: 'fal-ai/flux/schnell', videoModel: 'fal-ai/kling-video/v3/standard/image-to-video' },
  { id: 'replicate', name: 'Replicate', protocol: 'replicate', baseUrl: 'https://api.replicate.com/v1', keyEnv: 'RELAY_KEY_REPLICATE', imageModel: 'black-forest-labs/flux-schnell', videoModel: 'minimax/video-01' },
];
export function starterBoard(id = 'welcome', name = '光的旅行 · First light'): Board {
  return { schemaVersion: 1, id, name, revision: 0, viewport: { x: 60, y: 70, zoom: 0.8 }, nodes: [
    { id: 'brief', type: 'canvas', position: { x: 0, y: 50 }, data: { kind: 'prompt', label: '01 / Creative brief', prompt: '一座安靜的沙漠建築，溫暖晨光穿過拱門，細緻的沙色石材，電影感構圖。' } },
    { id: 'frame', type: 'canvas', position: { x: 380, y: 40 }, data: { kind: 'image', label: '02 / Establishing frame', providerId: 'demo', model: 'demo-image', prompt: '柔和陰影，極簡，35mm。', params: {} } },
    { id: 'motion', type: 'canvas', position: { x: 790, y: 40 }, data: { kind: 'video', label: '03 / Bring it to life', providerId: 'demo', model: 'demo-video', prompt: '鏡頭緩慢向前，光線微微流動。', referenceField: 'image_url', params: {} } },
    { id: 'direction', type: 'canvas', position: { x: 0, y: 360 }, data: { kind: 'note', label: 'Director’s note', prompt: '從一個想法開始。\n連接圖片，再讓它動起來。\n\n這是離線 Demo，沒有使用 AI 額度。' } },
  ], edges: [{ id: 'brief-frame', source: 'brief', target: 'frame' }, { id: 'frame-motion', source: 'frame', target: 'motion' }] };
}
