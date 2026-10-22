import { randomUUID } from 'node:crypto';
import { AppError, modelFor, plan, topology } from './graph.js';
import { Store } from './store.js';
import { generate, preflightGeneration } from './providers.js';
import { readPolicy, validateBaseUrl, validateMediaUrl } from './security.js';
import { parseBoard, parseOperations, parseProviders, parseRunInput } from '../src/shared/schema.js';
import type { Board, GenerationOutput, GenerationRequest, Provider, Run } from '../src/shared/types.js';
import { recommendedReferenceField } from '../src/shared/defaults.js';

type Generator = (provider: Provider, request: GenerationRequest) => Promise<GenerationOutput>;
export class CanvasService {
  private active?: { id: string; controller: AbortController };
  private tasks = new Map<string, Promise<void>>();
  constructor(readonly store: Store, readonly policy = readPolicy(), private generator: Generator = (p, r) => generate(p, r, { policy })) {}
  state() { return { ...this.store.read(), settings: this.policy }; }
  board(id: string) { const board = this.store.read().boards.find(b => b.id === id); if (!board) throw new AppError('NOT_FOUND', '找不到畫布。', 404); return board; }
  create(name: string) {
    if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new AppError('INVALID_NAME', '畫布名稱需為 1–120 字。');
    return this.store.transaction(data => {
      if (data.boards.length >= 20) throw new AppError('LIMIT', '此工作區最多保存 20 張畫布。');
      const board: Board = { schemaVersion: 1, id: randomUUID(), name: name.trim(), revision: 0, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } };
      data.boards.push(board); return board;
    });
  }
  save(id: string, expectedRevision: number, input: unknown) {
    const board = parseBoard(input);
    if (board.id !== id) throw new AppError('IDENTITY', '畫布 ID 不符。');
    for (const node of board.nodes) if (node.data.assetUrl) validateMediaUrl(node.data.assetUrl, this.policy);
    topology(board);
    return this.store.transaction(data => {
      const index = data.boards.findIndex(b => b.id === id);
      if (index < 0) throw new AppError('NOT_FOUND', '找不到畫布。', 404);
      if (data.boards[index].revision !== expectedRevision) throw new AppError('REVISION_CONFLICT', '畫布已被其他視窗或 Agent 更新。請先載入最新版本。', 409);
      data.boards[index] = { ...board, revision: expectedRevision + 1 }; return data.boards[index];
    });
  }
  patch(id: string, expectedRevision: number, input: unknown) {
    const operations = parseOperations(input), board = this.board(id);
    if (board.revision !== expectedRevision) throw new AppError('REVISION_CONFLICT', '版本已更新。', 409);
    for (const op of operations) {
      if (op.type === 'add_node') board.nodes.push(op.node);
      if (op.type === 'update_node') {
        const node = board.nodes.find(n => n.id === op.id);
        if (!node) throw new AppError('NOT_FOUND', '找不到節點。', 404);
        if (op.data) node.data = { ...node.data, ...op.data };
        if (op.position) node.position = op.position;
      }
      if (op.type === 'remove_node') { board.nodes = board.nodes.filter(n => n.id !== op.id); board.edges = board.edges.filter(e => e.source !== op.id && e.target !== op.id); }
      if (op.type === 'connect') board.edges.push(op.edge);
      if (op.type === 'remove_edge') board.edges = board.edges.filter(e => e.id !== op.id);
    }
    return this.save(id, expectedRevision, board);
  }
  providers(input: unknown) {
    const providers = parseProviders(input);
    for (const p of providers) if (p.protocol !== 'demo' && p.baseUrl) validateBaseUrl(p.baseUrl, this.policy);
    if (this.active) throw new AppError('BUSY', '執行中無法變更供應商設定。', 409);
    return this.store.transaction(data => { data.providers = providers; return providers; });
  }
  validate(id: string, selected?: string) { return plan(this.board(id), this.store.read().providers, selected); }
  getRun(id: string) { const run = this.store.read().runs.find(r => r.id === id); if (!run) throw new AppError('NOT_FOUND', '找不到執行紀錄。', 404); return run; }
  private updateRun(id: string, change: (run: Run) => void) { return this.store.transaction(data => { const run = data.runs.find(r => r.id === id)!; change(run); return run; }); }
  start(input: unknown): Run {
    const request = parseRunInput(input), data = this.store.read();
    const existing = data.runs.find(r => r.operationId === request.operationId);
    if (existing) {
      if (existing.boardId !== request.boardId || existing.revision !== request.expectedRevision) throw new AppError('OPERATION_CONFLICT', 'operationId 已用於另一個請求。', 409);
      return existing;
    }
    if (this.active) throw new AppError('BUSY', '已有任務執行中。', 409);
    if (data.runs.length >= 200) throw new AppError('LIMIT', '此工作區已達 200 次執行上限；請封存資料並使用新工作區。');
    const board = this.board(request.boardId);
    if (board.revision !== request.expectedRevision) throw new AppError('REVISION_CONFLICT', '畫布版本已改變，請重新確認。', 409);
    const execution = plan(board, data.providers, request.nodeId);
    if (execution.errors.length) throw new AppError('INVALID_PLAN', execution.errors.join('\n'));
    const remote = execution.generations.some(g => data.providers.find(p => p.id === g.providerId)?.protocol !== 'demo');
    if (remote && (!this.policy.remoteEnabled || !request.confirmExternal)) throw new AppError('REMOTE_DISABLED', '遠端生成需要 RELAY_ENABLE_REMOTE=true 與本次費用確認。', 403);
    for (const generation of execution.generations) {
      const node = board.nodes.find(n => n.id === generation.nodeId)!;
      preflightGeneration(data.providers.find(p => p.id === generation.providerId)!, { kind: node.data.kind as 'image' | 'video', model: generation.model, params: node.data.params ?? {}, referenceField: node.data.referenceField ?? recommendedReferenceField(generation.model) }, { policy: this.policy });
    }
    for (const node of board.nodes.filter(n => execution.order.includes(n.id))) if (node.data.assetUrl) validateMediaUrl(node.data.assetUrl, this.policy);
    const id = randomUUID(), controller = new AbortController();
    const run: Run = { id, boardId: board.id, revision: board.revision, operationId: request.operationId, status: 'pending', startedAt: new Date().toISOString(), snapshot: board, providers: data.providers, order: execution.order, results: Object.fromEntries(execution.order.map(nodeId => [nodeId, { nodeId, status: 'pending', artifacts: [] }])) };
    this.store.transaction(data => { data.runs.unshift(run); });
    this.active = { id, controller };
    // Persist the run before scheduling any provider work.
    const task = Promise.resolve().then(() => this.execute(run, controller.signal)).finally(() => { if (this.active?.id === id) this.active = undefined; this.tasks.delete(id); });
    this.tasks.set(id, task); void task.catch(() => { /* durable interrupted state is preserved on disk failure */ });
    return run;
  }
  async settled(id: string) { await this.tasks.get(id); return this.getRun(id); }
  cancel(id: string) {
    const run = this.getRun(id);
    if (this.active?.id === id) this.active.controller.abort();
    if (!['pending', 'running', 'submitting'].includes(run.status)) return run;
    return this.updateRun(id, r => { r.status = 'cancelled'; r.finishedAt = new Date().toISOString(); r.error = '已停止本機執行。遠端任務可能仍在進行並計費。'; for (const n of Object.values(r.results)) if (['pending', 'running', 'submitting'].includes(n.status)) n.status = 'cancelled'; });
  }
  private async execute(initial: Run, signal: AbortSignal) {
    const snapshot = initial.snapshot;
    this.updateRun(initial.id, r => { if (r.status !== 'cancelled') r.status = 'running'; });
    for (const id of initial.order) {
      if (signal.aborted) return;
      const node = snapshot.nodes.find(n => n.id === id)!;
      const previous = this.getRun(initial.id).results;
      const inputs = snapshot.edges.filter(e => e.target === id).map(e => previous[e.source]);
      const prompt = [...inputs.map(x => x.text).filter(Boolean), node.data.prompt].filter(Boolean).join('\n');
      let submitting = false;
      try {
        if (inputs.some(i => i.status !== 'succeeded')) throw new AppError('UPSTREAM_FAILED', '上游未成功完成。');
        if (node.data.kind === 'prompt' || node.data.kind === 'note') {
          this.updateRun(initial.id, r => { r.results[id] = { nodeId: id, status: 'succeeded', text: prompt, artifacts: [] }; }); continue;
        }
        if (node.data.kind === 'asset') {
          this.updateRun(initial.id, r => { r.results[id] = { nodeId: id, status: 'succeeded', artifacts: [{ kind: node.data.assetKind ?? 'image', url: node.data.assetUrl! }] }; }); continue;
        }
        const provider = initial.providers.find(p => p.id === node.data.providerId)!;
        const referenceUrl = inputs.flatMap(x => x.artifacts).find(a => a.kind === 'image')?.url;
        const expectsImage = snapshot.edges.some(e => e.target === id && ['image', 'asset'].includes(snapshot.nodes.find(n => n.id === e.source)!.data.kind));
        if (expectsImage && !referenceUrl) throw new AppError('MISSING_IMAGE', '上游沒有可用圖片。');
        this.updateRun(initial.id, r => { r.results[id] = { nodeId: id, status: 'submitting', artifacts: [], attemptId: randomUUID(), referenceUrl }; });
        submitting = provider.protocol !== 'demo';
        const result = await this.generator(provider, { kind: node.data.kind, model: modelFor(node, provider), prompt, params: node.data.params ?? {}, referenceUrl, referenceField: node.data.referenceField ?? recommendedReferenceField(modelFor(node, provider)), signal, onSubmitted: remoteId => { this.updateRun(initial.id, r => { r.results[id].remoteId = remoteId; if (r.status !== 'cancelled') r.results[id].status = 'running'; }); } });
        if (signal.aborted) return;
        if (!result.artifacts.length || result.artifacts[0].kind !== node.data.kind) throw new AppError('INVALID_OUTPUT', '供應商未回傳預期的媒體。');
        this.updateRun(initial.id, r => { r.results[id] = { ...r.results[id], status: 'succeeded', artifacts: result.artifacts, remoteId: result.remoteId ?? r.results[id].remoteId }; });
      } catch {
        if (signal.aborted) return;
        const status = submitting ? 'needs_review' : 'failed';
        this.updateRun(initial.id, r => {
          r.status = status; r.finishedAt = new Date().toISOString();
          r.error = submitting ? '生成未確認完成；不會自動重送。請檢查供應商與 remoteId，重新執行可能重複計費。' : '節點執行失敗，請檢查設定與上游輸入。';
          r.results[id].status = status; r.results[id].error = r.error;
          for (const result of Object.values(r.results)) if (result.status === 'pending') result.status = 'cancelled';
        }); return;
      }
    }
    if (!signal.aborted) this.updateRun(initial.id, r => { r.status = 'succeeded'; r.finishedAt = new Date().toISOString(); });
  }
}
