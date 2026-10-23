import { randomUUID } from 'node:crypto';
import { AppError, modelFor, plan, topology } from './graph.js';
import { Store } from './store.js';
import { generate, preflightGeneration } from './providers.js';
import { providerDiagnostics, providerModels, type ProviderTransport } from './providers.js';
import { MediaStore } from './media.js';
import { EditorRuntime } from './editor.js';
import { readPolicy, validateBaseUrl, validateMediaUrl } from './security.js';
import { parseBoard, parseExportInput, parseOperations, parseProviders, parseRunInput, parseTimelineInput } from '../src/shared/schema.js';
import type {
  Artifact, ArtifactInfo, Board, CanonicalArtifact, CanonicalRun, ClipSource, ExportJob, GenerationOutput,
  GenerationRequest, Provider, Run, RunComparison, RunComparisonField, StoredExportJob, Timeline,
} from '../src/shared/types.js';
import { recommendedReferenceField } from '../src/shared/defaults.js';

type Generator = (provider: Provider, request: GenerationRequest) => Promise<GenerationOutput>;
export class CanvasService {
  private active?: { id: string; controller: AbortController };
  private tasks = new Map<string, Promise<void>>();
  private artifactSaves = new Map<string, Promise<Artifact>>();
  private activeExport?: { id: string; attemptNonce: string; controller: AbortController };
  private exportTasks = new Map<string, Promise<void>>();
  readonly media: MediaStore;
  readonly editor: EditorRuntime;
  constructor(
    readonly store: Store,
    readonly policy = readPolicy(),
    private generator: Generator = (p, r) => generate(p, r, { policy }),
    media?: MediaStore,
    editor?: EditorRuntime,
  ) {
    this.media = media ?? new MediaStore(store.directory, policy);
    this.editor = editor ?? new EditorRuntime(store.directory, this.media);
  }
  state() {
    const data = this.store.read();
    const exports = data.exports?.map(({ attemptNonce: _attemptNonce, ...job }) => job);
    return { ...data, exports, settings: this.policy };
  }
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
  diagnostics(env: NodeJS.ProcessEnv = process.env) { return providerDiagnostics(this.store.read().providers, this.policy, env); }
  async models(id: string, env: NodeJS.ProcessEnv = process.env, transport?: ProviderTransport) {
    const provider = this.store.read().providers.find(candidate => candidate.id === id);
    if (!provider) throw new AppError('NOT_FOUND', '找不到供應商。', 404);
    try { return await providerModels(provider, { policy: this.policy, env, transport }); }
    catch { throw new AppError('MODEL_DISCOVERY_FAILED', '模型清單無法讀取；請手動輸入模型。', 400); }
  }
  validate(id: string, selected?: string) { return plan(this.board(id), this.store.read().providers, selected); }
  getRun(id: string) { const run = this.store.read().runs.find(r => r.id === id); if (!run) throw new AppError('NOT_FOUND', '找不到執行紀錄。', 404); return run; }
  private source(boardId: string, source: ClipSource): Artifact {
    const run = this.getRun(source.runId);
    if (run.boardId !== boardId) throw new AppError('SOURCE_BOARD_MISMATCH', '素材不屬於此畫布。', 400);
    const result = run.results[source.nodeId];
    if (run.status !== 'succeeded' || result?.status !== 'succeeded') throw new AppError('SOURCE_NOT_SUCCEEDED', '只有成功且已保存的影片可以加入時間軸。', 409);
    const artifact = result.artifacts[source.artifactIndex];
    if (!artifact || artifact.kind !== 'video' || !artifact.localId || artifact.localId !== artifact.sha256 || !artifact.localUrl || !artifact.bytes || !['video/mp4', 'video/webm'].includes(artifact.mimeType ?? '')) {
      throw new AppError('SOURCE_NOT_SAVED', '請先將影片保存到本機，再加入時間軸。', 409);
    }
    return artifact;
  }
  async artifactInfo(runId: string, nodeId: string, artifactIndex: number): Promise<ArtifactInfo> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId) || !/^[A-Za-z0-9_-]{1,64}$/.test(nodeId) || !Number.isSafeInteger(artifactIndex) || artifactIndex < 0 || artifactIndex > 99) throw new AppError('INVALID_INPUT', '素材識別無效。', 400);
    const run = this.getRun(runId), source = { runId, nodeId, artifactIndex };
    const artifact = this.source(run.boardId, source);
    try { return { source, artifact, media: await this.editor.probe(artifact) }; }
    catch (error) { if (error instanceof AppError) throw error; throw new AppError('PROBE_FAILED', '無法讀取影片資訊；請確認 FFmpeg 可用且檔案有效。', 400); }
  }
  timeline(boardId: string): Timeline {
    this.board(boardId);
    return this.store.read().timelines?.find(candidate => candidate.boardId === boardId) ?? { boardId, revision: 0, format: 'landscape', clips: [] };
  }
  async saveTimeline(boardId: string, input: unknown): Promise<Timeline> {
    this.board(boardId);
    const request = parseTimelineInput(input), initial = this.timeline(boardId);
    if (initial.revision !== request.expectedRevision) throw new AppError('REVISION_CONFLICT', '時間軸已被其他視窗或 Agent 更新。', 409);
    const clips = [] as Timeline['clips'];
    for (const clip of request.clips) {
      const artifact = this.source(boardId, clip.source);
      let media;
      try { media = await this.editor.probe(artifact); }
      catch { throw new AppError('PROBE_FAILED', '無法驗證時間軸影片。', 400); }
      if (clip.outSeconds > media.duration + 1e-6) throw new AppError('INVALID_TRIM', '裁切終點超過影片長度。', 400);
      clips.push({ ...clip, artifact, media });
    }
    return this.store.transaction(data => {
      const current = data.timelines?.find(candidate => candidate.boardId === boardId);
      if ((current?.revision ?? 0) !== request.expectedRevision) throw new AppError('REVISION_CONFLICT', '時間軸已被其他視窗或 Agent 更新。', 409);
      for (const clip of clips) {
        const run = data.runs.find(candidate => candidate.id === clip.source.runId);
        const artifact = run?.results[clip.source.nodeId]?.artifacts[clip.source.artifactIndex];
        if (run?.boardId !== boardId || !artifact || artifact.localId !== clip.artifact.localId || artifact.sha256 !== clip.artifact.sha256) throw new AppError('REVISION_CONFLICT', '來源素材已變更，請重新載入。', 409);
      }
      const saved: Timeline = { boardId, revision: request.expectedRevision + 1, format: request.format, clips };
      data.timelines ??= [];
      const index = data.timelines.findIndex(candidate => candidate.boardId === boardId);
      if (index < 0) data.timelines.push(saved); else data.timelines[index] = saved;
      return saved;
    });
  }
  private publicExport(job: StoredExportJob): ExportJob { const { attemptNonce: _attemptNonce, ...result } = job; return result; }
  getExport(id: string): ExportJob {
    const job = this.store.read().exports?.find(candidate => candidate.id === id);
    if (!job) throw new AppError('NOT_FOUND', '找不到匯出工作。', 404);
    return this.publicExport(job);
  }
  startExport(boardId: string, input: unknown): ExportJob {
    this.board(boardId);
    const request = parseExportInput(input), data = this.store.read();
    const existing = data.exports?.find(candidate => candidate.operationId === request.operationId);
    if (existing) {
      if (existing.boardId !== boardId || existing.timelineRevision !== request.expectedRevision) throw new AppError('OPERATION_CONFLICT', 'operationId 已用於另一個匯出請求。', 409);
      return this.publicExport(existing);
    }
    if (this.activeExport) throw new AppError('BUSY', '已有匯出工作進行中。', 409);
    if ((data.exports?.length ?? 0) >= 100) throw new AppError('LIMIT', '此工作區已達 100 個匯出工作上限。', 400);
    const timeline = this.timeline(boardId);
    if (timeline.revision !== request.expectedRevision) throw new AppError('REVISION_CONFLICT', '時間軸版本已改變。', 409);
    if (!timeline.clips.length) throw new AppError('EMPTY_TIMELINE', '時間軸沒有可匯出的片段。', 400);
    const id = randomUUID(), attemptNonce = randomUUID(), controller = new AbortController();
    const job: StoredExportJob = { id, boardId, timelineRevision: timeline.revision, operationId: request.operationId, status: 'pending', startedAt: new Date().toISOString(), snapshot: timeline, attemptNonce };
    this.store.transaction(next => { next.exports ??= []; next.exports.unshift(job); });
    this.activeExport = { id, attemptNonce, controller };
    const task = Promise.resolve().then(() => this.executeExport(job, controller.signal)).finally(() => {
      if (this.activeExport?.id === id && this.activeExport.attemptNonce === attemptNonce) this.activeExport = undefined;
      this.exportTasks.delete(id);
    });
    this.exportTasks.set(id, task); void task.catch(() => undefined);
    return this.publicExport(job);
  }
  private updateExport(id: string, attemptNonce: string, change: (job: StoredExportJob) => void): StoredExportJob {
    return this.store.transaction(data => {
      const job = data.exports?.find(candidate => candidate.id === id);
      if (!job || job.attemptNonce !== attemptNonce || !['pending', 'running'].includes(job.status)) throw new AppError('EXPORT_FENCED', '匯出工作已結束。', 409);
      change(job); return job;
    });
  }
  private async executeExport(initial: StoredExportJob, signal: AbortSignal): Promise<void> {
    try {
      this.updateExport(initial.id, initial.attemptNonce, job => { job.status = 'running'; });
      await this.editor.export(initial.snapshot, artifact => {
        this.updateExport(initial.id, initial.attemptNonce, job => { job.status = 'succeeded'; job.artifact = artifact; job.finishedAt = new Date().toISOString(); });
      }, localId => this.store.artifactReferenced(localId), signal);
    } catch {
      try { this.updateExport(initial.id, initial.attemptNonce, job => { job.status = signal.aborted ? 'cancelled' : 'failed'; job.finishedAt = new Date().toISOString(); job.error = signal.aborted ? '匯出已取消。' : '匯出失敗；請確認來源影片與 FFmpeg 設定。'; }); }
      catch { /* cancellation or durable fence already won */ }
    }
  }
  async cancelExport(id: string): Promise<ExportJob> {
    const data = this.store.read(), job = data.exports?.find(candidate => candidate.id === id);
    if (!job) throw new AppError('NOT_FOUND', '找不到匯出工作。', 404);
    if (!['pending', 'running'].includes(job.status)) return this.publicExport(job);
    const cancelled = this.updateExport(id, job.attemptNonce, current => { current.status = 'cancelled'; current.finishedAt = new Date().toISOString(); current.error = '匯出已取消。'; });
    if (this.activeExport?.id === id && this.activeExport.attemptNonce === job.attemptNonce) this.activeExport.controller.abort();
    await this.exportTasks.get(id);
    return this.publicExport(cancelled);
  }
  async settledExport(id: string): Promise<ExportJob> { await this.exportTasks.get(id); return this.getExport(id); }
  compare(boardId: string, leftId: string, rightId: string): RunComparison {
    this.board(boardId);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(leftId) || !/^[A-Za-z0-9_-]{1,64}$/.test(rightId) || leftId === rightId) throw new AppError('INVALID_INPUT', '比較執行識別無效。', 400);
    const leftRun = this.getRun(leftId), rightRun = this.getRun(rightId);
    if (leftRun.boardId !== boardId || rightRun.boardId !== boardId) throw new AppError('RUN_BOARD_MISMATCH', '執行紀錄不屬於此畫布。', 400);
    const active = new Set(['pending', 'submitting', 'running']);
    if (active.has(leftRun.status) || active.has(rightRun.status)) throw new AppError('RUN_NOT_TERMINAL', '執行仍在進行，完成後才能比較。', 409);
    const canonicalize = (run: Run): CanonicalRun => ({
      id: run.id, boardId: run.boardId, revision: run.revision, operationId: run.operationId,
      status: run.status as CanonicalRun['status'], startedAt: run.startedAt, finishedAt: run.finishedAt,
      snapshot: run.snapshot, providers: run.providers, order: run.order,
      results: Object.fromEntries(Object.entries(run.results).map(([id, result]) => [id, {
        nodeId: result.nodeId, status: result.status, text: result.text,
        artifacts: result.artifacts.map(({ kind, url, demo }): CanonicalArtifact => ({ kind, url, ...(demo === undefined ? {} : { demo }) })),
        error: result.error, attemptId: result.attemptId, remoteId: result.remoteId, referenceUrl: result.referenceUrl,
      }])), error: run.error,
    });
    const left = canonicalize(leftRun), right = canonicalize(rightRun);
    const nodeIds = [...new Set([...left.snapshot.nodes.map(node => node.id), ...right.snapshot.nodes.map(node => node.id)])].sort();
    const differences = nodeIds.flatMap(nodeId => {
      const a = left.snapshot.nodes.find(node => node.id === nodeId), b = right.snapshot.nodes.find(node => node.id === nodeId);
      const fields: RunComparisonField[] = [];
      if (!a || !b) fields.push('presence');
      else {
        if (a.data.prompt !== b.data.prompt) fields.push('prompt');
        if (a.data.providerId !== b.data.providerId) fields.push('providerId');
        if (a.data.model !== b.data.model) fields.push('model');
        if (JSON.stringify(a.data.params ?? {}) !== JSON.stringify(b.data.params ?? {})) fields.push('params');
      }
      if (left.results[nodeId]?.status !== right.results[nodeId]?.status) fields.push('status');
      if (JSON.stringify(left.results[nodeId]?.artifacts ?? []) !== JSON.stringify(right.results[nodeId]?.artifacts ?? [])) fields.push('artifacts');
      return fields.length ? [{ nodeId, fields }] : [];
    });
    return { boardId, left, right, differences };
  }
  async saveArtifact(runId: string, nodeId: string, index: number, signal?: AbortSignal): Promise<Artifact> {
    if (!Number.isSafeInteger(index) || index < 0) throw new AppError('INVALID_INPUT', '素材索引無效。', 400);
    const key = `${runId}\u0000${nodeId}\u0000${index}`;
    const existing = this.artifactSaves.get(key);
    if (existing) return await existing;
    if (this.artifactSaves.size >= 8) throw new AppError('MEDIA_SAVE_BUSY', '同時保存的素材過多，請稍後重試。', 429);
    const readSource = (): Artifact => {
      const run = this.getRun(runId); const result = run.results[nodeId];
      if (!result) throw new AppError('NOT_FOUND', '找不到節點結果。', 404);
      if (run.status !== 'succeeded' || result.status !== 'succeeded') throw new AppError('NOT_SUCCEEDED', '只有成功完成的素材可以保存。', 409);
      const source = result.artifacts[index];
      if (!source) throw new AppError('NOT_FOUND', '找不到素材。', 404);
      if (source.demo) {
        const snapshotNode = run.snapshot.nodes.find(node => node.id === nodeId);
        const provider = run.providers.find(candidate => candidate.id === snapshotNode?.data.providerId);
        if (!snapshotNode || provider?.protocol !== 'demo') throw new AppError('INVALID_INPUT', 'Demo 素材來源無效。', 400);
      }
      return source;
    };
    readSource();
    const operation = (async () => {
      try { return await this.media.save(readSource, artifact => {
        this.store.transaction(data => {
          const current = data.runs.find(candidate => candidate.id === runId);
          const currentResult = current?.results[nodeId];
          if (!current || current.status !== 'succeeded' || !currentResult || currentResult.status !== 'succeeded' || !currentResult.artifacts[index]) {
            throw new AppError('REVISION_CONFLICT', '素材狀態已改變。', 409);
          }
          currentResult.artifacts[index] = artifact;
        });
      }, { signal, isReferenced: localId => this.store.artifactReferenced(localId) }); }
      catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('MEDIA_SAVE_FAILED', '素材保存失敗；原始生成結果仍保留，可稍後重試。', 400);
      }
    })().finally(() => { if (this.artifactSaves.get(key) === operation) this.artifactSaves.delete(key); });
    this.artifactSaves.set(key, operation);
    return await operation;
  }
  mediaArtifact(localId: string): Artifact {
    if (!/^[a-f0-9]{64}$/.test(localId)) throw new AppError('INVALID_INPUT', '素材 ID 無效。', 400);
    for (const run of this.store.read().runs) for (const result of Object.values(run.results)) {
      if (run.status !== 'succeeded' || result.status !== 'succeeded') continue;
      const artifact = result.artifacts.find(candidate => candidate.localId === localId && candidate.sha256 === localId);
      if (artifact) return artifact;
    }
    const exported = this.store.read().exports?.find(job => job.status === 'succeeded' && job.artifact?.localId === localId && job.artifact.sha256 === localId)?.artifact;
    if (exported) return exported;
    throw new AppError('NOT_FOUND', '找不到素材。', 404);
  }
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
