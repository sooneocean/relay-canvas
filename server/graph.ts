import type { Board, CanvasNode, ExecutionPlan, Provider } from '../src/shared/types.js';
import { providerSupportsKind } from '../src/shared/provider-capabilities.js';

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export function topology(board: Board): string[] {
  const ids = new Set(board.nodes.map(n => n.id));
  if (ids.size !== board.nodes.length) throw new AppError('INVALID_GRAPH', '節點 ID 重複。');
  const byId = new Map(board.nodes.map(n => [n.id, n]));
  const incoming = new Map<string, string[]>();
  const edgeIds = new Set<string>();
  for (const e of board.edges) {
    if (edgeIds.has(e.id) || !ids.has(e.source) || !ids.has(e.target) || e.source === e.target)
      throw new AppError('INVALID_GRAPH', '連線 ID 重複、端點不存在或連向自己。');
    edgeIds.add(e.id);
    const s = byId.get(e.source)!, t = byId.get(e.target)!;
    const kind = s.data.kind === 'asset' ? (s.data.assetKind ?? 'image') : s.data.kind;
    const accepted = t.data.kind === 'image' ? ['prompt'] : t.data.kind === 'video' ? ['prompt', 'image'] : [];
    if (!accepted.includes(kind)) throw new AppError('INCOMPATIBLE_EDGE', '圖片只接收提示詞；影片接收提示詞與一張圖片。');
    const previous = incoming.get(t.id) ?? [];
    if (previous.includes(kind)) throw new AppError('MULTIPLE_INPUTS', '每個節點最多接收一條提示詞與一條圖片輸入。');
    incoming.set(t.id, [...previous, kind]);
  }
  const pending = new Map(board.nodes.map(n => [n.id, board.edges.filter(e => e.target === n.id).length]));
  const ready = board.nodes.filter(n => pending.get(n.id) === 0).map(n => n.id), order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!; order.push(id);
    for (const e of board.edges.filter(e => e.source === id)) {
      pending.set(e.target, pending.get(e.target)! - 1);
      if (pending.get(e.target) === 0) ready.push(e.target);
    }
  }
  if (order.length !== board.nodes.length) throw new AppError('CYCLE', '畫布不能包含循環連線。');
  return order;
}
export function modelFor(node: CanvasNode, provider: Provider): string {
  return node.data.model || (node.data.kind === 'video' ? provider.videoModel : provider.imageModel);
}
export function plan(board: Board, providers: Provider[], selected?: string): ExecutionPlan {
  const result: ExecutionPlan = { order: [], generations: [], errors: [] };
  try { result.order = topology(board); } catch (e) { result.errors.push((e as Error).message); return result; }
  if (selected) {
    if (!board.nodes.some(n => n.id === selected)) { result.errors.push('找不到選取的節點。'); return result; }
    const needed = new Set([selected]);
    for (let changed = true; changed;) {
      changed = false;
      for (const e of board.edges) if (needed.has(e.target) && !needed.has(e.source)) { needed.add(e.source); changed = true; }
    }
    result.order = result.order.filter(id => needed.has(id));
  }
  for (const id of result.order) {
    const node = board.nodes.find(n => n.id === id)!;
    if (node.data.kind === 'asset' && !node.data.assetUrl && !node.data.assetId) result.errors.push(`${node.data.label}：請加入素材。`);
    if (node.data.kind !== 'image' && node.data.kind !== 'video') continue;
    const provider = providers.find(p => p.id === node.data.providerId);
    if (!provider) { result.errors.push(`${node.data.label}：請選擇供應商。`); continue; }
    const model = modelFor(node, provider);
    if (!model) result.errors.push(`${node.data.label}：請設定模型。`);
    if (!providerSupportsKind(provider.protocol, node.data.kind)) result.errors.push(`${provider.name} 不支援${node.data.kind === 'image' ? '圖片' : '影片'}生成。`);
    if (provider.protocol !== 'demo' && !provider.baseUrl) result.errors.push(`${provider.name}：請設定 Base URL。`);
    const inputText = board.edges.some(e => e.target === id && board.nodes.find(n => n.id === e.source)?.data.kind === 'prompt');
    if (!node.data.prompt?.trim() && !inputText) result.errors.push(`${node.data.label}：缺少提示詞。`);
    result.generations.push({ nodeId: id, providerId: provider.id, model });
  }
  if (result.generations.length > 20) result.errors.push('每次最多執行 20 個生成節點。');
  return result;
}
