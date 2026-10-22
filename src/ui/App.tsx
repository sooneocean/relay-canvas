import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import {
  Activity,
  AlertCircle,
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Code2,
  Copy,
  Download,
  Film,
  FolderPlus,
  GitBranch,
  Image as ImageIcon,
  Info,
  Layers3,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Maximize2,
  MessageSquareText,
  PanelRight,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  StickyNote,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import {
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { providers as defaultProviders, recommendedReferenceField, starterBoard } from '../shared/defaults.js';
import type {
  AppState,
  Artifact,
  Board,
  CanvasData,
  CanvasEdge,
  CanvasNode,
  ExecutionPlan,
  NodeResult,
  Provider,
  Run,
  Status,
} from '../shared/types.js';
import { parseBoard } from '../shared/schema.js';

type FlowNode = Node<CanvasData & { previewUrl?: string; runStatus?: Status; runError?: string }, 'canvas'>;
type FlowEdge = Edge;
type Panel = 'inspector' | 'history' | 'providers' | 'help';
type ApiState = 'loading' | 'ready' | 'offline';
type BoardConflict = { boardId: string; localRevision: number; remoteRevision: number };

const MAX_IMPORT_BYTES = 6 * 1024 * 1024;

const terminalStatuses = new Set<Status>(['succeeded', 'failed', 'cancelled', 'interrupted', 'needs_review']);

const nodeKindMeta: Record<CanvasData['kind'], { label: string; eyebrow: string; icon: typeof Sparkles; color: string }> = {
  prompt: { label: 'Prompt', eyebrow: 'TEXT / BRIEF', icon: MessageSquareText, color: '#c8ff5a' },
  image: { label: 'Image', eyebrow: 'GENERATE / FRAME', icon: ImageIcon, color: '#9ab7ff' },
  video: { label: 'Video', eyebrow: 'GENERATE / MOTION', icon: Film, color: '#e6a7ff' },
  asset: { label: 'Asset', eyebrow: 'INPUT / MEDIA', icon: Box, color: '#ffbc7d' },
  note: { label: 'Note', eyebrow: 'DIRECTION / NOTE', icon: StickyNote, color: '#9ca7b8' },
};

const defaultData: Record<CanvasData['kind'], Partial<CanvasData>> = {
  prompt: { prompt: '描述你的畫面、氛圍與動作。' },
  image: { providerId: 'demo', model: 'demo-image', prompt: '清晰的主體，柔和光線。', params: {} },
  video: { providerId: 'demo', model: 'demo-video', prompt: '鏡頭緩慢移動，保持畫面穩定。', params: {}, referenceField: 'image_url' },
  asset: { assetKind: 'image' },
  note: { prompt: '記下方向、限制或審稿意見。' },
};

function makeId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${random ?? Math.random().toString(36).slice(2, 10)}`;
}

function makeOperationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? makeId('operation');
}

function cleanData(data: CanvasData): CanvasData {
  const allowed: CanvasData = {
    kind: data.kind,
    label: data.label,
  };
  for (const key of ['prompt', 'providerId', 'model', 'params', 'referenceField', 'assetUrl', 'assetKind'] as const) {
    if (data[key] !== undefined) {
      allowed[key] = data[key] as never;
    }
  }
  return allowed;
}

function cleanBoard(board: Board): Board {
  return {
    schemaVersion: 1,
    id: board.id,
    name: board.name,
    revision: board.revision,
    nodes: board.nodes.map((node) => ({
      id: node.id,
      type: 'canvas',
      position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      data: cleanData(node.data),
    })),
    edges: board.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
    viewport: { x: board.viewport.x, y: board.viewport.y, zoom: board.viewport.zoom },
  };
}

function boardToFlowNodes(board: Board): FlowNode[] {
  return board.nodes.map((node) => ({
    id: node.id,
    type: 'canvas',
    position: node.position,
    data: { ...node.data },
  }));
}

function boardToFlowEdges(board: Board): FlowEdge[] {
  return board.edges.map((edge) => ({ ...edge, type: 'smoothstep', animated: false }));
}

function flowNodesToBoard(nodes: FlowNode[]): CanvasNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: 'canvas',
    position: { x: node.position.x, y: node.position.y },
    data: cleanData(node.data),
  }));
}

function flowEdgesToBoard(edges: FlowEdge[]): CanvasEdge[] {
  return edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target }));
}

function getNodeKind(nodes: FlowNode[], id: string | null | undefined): CanvasData['kind'] | undefined {
  return id ? nodes.find((node) => node.id === id)?.data.kind : undefined;
}

function outputKind(kind: CanvasData['kind']): 'text' | 'asset' | 'image' | 'video' | 'none' {
  if (kind === 'prompt') return 'text';
  if (kind === 'asset') return 'asset';
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'video';
  return 'none';
}

function canConnect(nodes: FlowNode[], edges: FlowEdge[], connection: Connection): boolean {
  if (!connection.source || !connection.target || connection.source === connection.target) return false;
  const sourceKind = getNodeKind(nodes, connection.source);
  const targetKind = getNodeKind(nodes, connection.target);
  if (!sourceKind || !targetKind) return false;
  const sourceOutput = outputKind(sourceKind);
  if (sourceOutput === 'none' || targetKind === 'prompt' || targetKind === 'asset' || targetKind === 'note') return false;
  const incoming = edges.filter((edge) => edge.target === connection.target);
  if (targetKind === 'image') {
    if (sourceOutput !== 'text' || incoming.length >= 1) return false;
  }
  if (targetKind === 'video') {
    if (sourceOutput !== 'text' && sourceOutput !== 'image') return false;
    if (incoming.some((edge) => outputKind(getNodeKind(nodes, edge.source) ?? 'note') === sourceOutput)) return false;
    if (incoming.length >= 2) return false;
  }
  if (edges.some((edge) => edge.source === connection.source && edge.target === connection.target)) return false;

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.source) ?? [];
    list.push(edge.target);
    adjacency.set(edge.source, list);
  }
  adjacency.set(connection.source, [...(adjacency.get(connection.source) ?? []), connection.target]);
  const visited = new Set<string>();
  const stack = [connection.target];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    if (current === connection.source) return false;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
  return true;
}

function statusLabel(status?: Status): string {
  switch (status) {
    case 'pending': return '待執行';
    case 'submitting': return '送出中';
    case 'running': return '執行中';
    case 'succeeded': return '已完成';
    case 'failed': return '失敗';
    case 'cancelled': return '已取消';
    case 'interrupted': return '已中斷';
    case 'needs_review': return '需要檢視';
    default: return '未執行';
  }
}

function statusClass(status?: Status): string {
  return status ? `status-${status}` : 'status-idle';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return '連線失敗，請稍後重試。';
}

function assetForResult(result?: NodeResult): Artifact | undefined {
  return result?.artifacts?.[0];
}

function CanvasNodeView({ data, selected }: NodeProps<FlowNode>) {
  const meta = nodeKindMeta[data.kind];
  const Icon = meta.icon;
  const mediaUrl = data.previewUrl ?? data.assetUrl;
  return (
    <div className={`canvas-node ${selected ? 'is-selected' : ''} kind-${data.kind}`} style={{ '--node-accent': meta.color } as CSSProperties}>
      {(data.kind === 'image' || data.kind === 'video') && <Handle type="target" position={Position.Left} id="input" />}
      <div className="node-topline">
        <span className="node-icon" aria-hidden="true"><Icon size={14} strokeWidth={1.8} /></span>
        <span>{meta.eyebrow}</span>
        {data.runStatus && <span className={`node-status ${statusClass(data.runStatus)}`}>{statusLabel(data.runStatus)}</span>}
      </div>
      <div className="node-heading">{data.label || meta.label}</div>
      {mediaUrl && data.kind === 'image' && <img className="node-media" src={mediaUrl} alt={data.label} referrerPolicy="no-referrer" crossOrigin="anonymous" />}
      {mediaUrl && data.kind === 'video' && <video className="node-media" src={mediaUrl} controls muted playsInline crossOrigin="anonymous" />}
      {!mediaUrl && <div className="node-copy">{data.prompt || (data.kind === 'asset' ? '拖曳或指定一個來源素材' : meta.label)}</div>}
      {mediaUrl && data.prompt && <div className="node-copy node-copy-trimmed">{data.prompt}</div>}
      {data.runError && <div className="node-error"><AlertCircle size={12} />{data.runError}</div>}
      {data.kind !== 'note' && data.kind !== 'video' && <Handle type="source" position={Position.Right} id="output" />}
    </div>
  );
}

const nodeTypes = { canvas: CanvasNodeView };

function AppShell() {
  const reactFlow = useReactFlow<FlowNode, FlowEdge>();
  const [apiState, setApiState] = useState<ApiState>('loading');
  const [apiError, setApiError] = useState('');
  const [token, setToken] = useState('');
  const [boards, setBoards] = useState<Board[]>([starterBoard()]);
  const [providers, setProviders] = useState<Provider[]>(defaultProviders);
  const [runs, setRuns] = useState<Run[]>([]);
  const [settings, setSettings] = useState<AppState['settings']>({ remoteEnabled: false, mediaOrigins: [], providerOrigins: [] });
  const [activeBoardId, setActiveBoardId] = useState('welcome');
  const [nodes, setNodes] = useState<FlowNode[]>(() => boardToFlowNodes(starterBoard()));
  const [edges, setEdges] = useState<FlowEdge[]>(() => boardToFlowEdges(starterBoard()));
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [panel, setPanel] = useState<Panel>('inspector');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ tone: 'info' | 'error' | 'success'; message: string }>();
  const [plan, setPlan] = useState<ExecutionPlan>();
  const [runBusy, setRunBusy] = useState(false);
  const [confirmRun, setConfirmRun] = useState<{ nodeId?: string; operationId: string; plan: ExecutionPlan }>();
  const [providerDraftId, setProviderDraftId] = useState('demo');
  const [providersDirty, setProvidersDirty] = useState(false);
  const [conflict, setConflict] = useState<BoardConflict>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef(token);
  const activeBoardIdRef = useRef(activeBoardId);
  const dirtyRef = useRef(dirty);
  const boardsRef = useRef(boards);
  const editVersionRef = useRef(0);
  const saveInFlightRef = useRef<Promise<Board | undefined> | null>(null);
  const statePollInFlightRef = useRef(false);
  const conflictNoticeRef = useRef<string | undefined>(undefined);
  const autosaveTimer = useRef<number | undefined>(undefined);
  const pollTimers = useRef<Map<string, number>>(new Map());

  const activeBoard = useMemo(() => boards.find((board) => board.id === activeBoardId) ?? boards[0], [activeBoardId, boards]);
  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedNodeId), [nodes, selectedNodeId]);
  const latestRun = useMemo(() => runs.find((run) => run.boardId === activeBoardId && run.revision === activeBoard?.revision), [activeBoard?.revision, activeBoardId, runs]);
  const latestRunSignature = useMemo(() => latestRun ? JSON.stringify({ id: latestRun.id, status: latestRun.status, results: latestRun.results }) : '', [latestRun]);
  const activeRun = useMemo(() => runs.find((run) => run.boardId === activeBoardId && !terminalStatuses.has(run.status)), [activeBoardId, runs]);

  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => { activeBoardIdRef.current = activeBoardId; }, [activeBoardId]);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => { boardsRef.current = boards; }, [boards]);

  const notify = useCallback((message: string, tone: 'info' | 'error' | 'success' = 'info') => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(undefined), 4200);
  }, []);

  const requestJson = useCallback(async <T,>(path: string, init: RequestInit = {}, requestToken = tokenRef.current): Promise<T> => {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (requestToken) headers.set('X-Canvas-Token', requestToken);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...init, headers });
    let payload: unknown;
    try { payload = await response.json(); } catch { payload = undefined; }
    if (!response.ok) {
      const details = payload && typeof payload === 'object' && 'error' in payload ? String((payload as { error: unknown }).error) : `HTTP ${response.status}`;
      throw new Error(details.slice(0, 180));
    }
    return payload as T;
  }, []);

  const paintBoard = useCallback((board: Board, options: { resetSelection?: boolean; restoreViewport?: boolean } = {}) => {
    setNodes(boardToFlowNodes(board));
    setEdges(boardToFlowEdges(board));
    if (options.resetSelection ?? true) setSelectedNodeId(undefined);
    setPlan(undefined);
    if (options.restoreViewport ?? true) reactFlow.setViewport(board.viewport, { duration: 0 });
  }, [reactFlow]);

  const hydrate = useCallback(async () => {
    setApiState('loading');
    try {
      const session = await requestJson<{ token: string }>('/api/session', { headers: { 'X-Canvas-Client': 'ui' } }, '');
      if (!session.token) throw new Error('Session token missing');
      setToken(session.token);
      tokenRef.current = session.token;
      const state = await requestJson<AppState>('/api/state', {}, session.token);
      if (state.boards?.length) {
        setBoards(state.boards);
        const nextBoard = state.boards.find((board) => board.id === activeBoardIdRef.current) ?? state.boards[0];
        setActiveBoardId(nextBoard.id);
        paintBoard(nextBoard);
      }
      if (state.providers?.length) setProviders(state.providers);
      setProvidersDirty(false);
      if (state.runs) setRuns(state.runs);
      if (state.settings) setSettings(state.settings);
      dirtyRef.current = false;
      setDirty(false);
      editVersionRef.current += 1;
      setConflict(undefined);
      setApiState('ready');
      setApiError('');
    } catch (error) {
      setApiState('offline');
      setApiError(errorMessage(error));
      notify('尚未連上 Relay Canvas 服務；目前可編輯 Demo 畫布，但保存與執行需要後端。', 'error');
    }
  }, [notify, paintBoard, requestJson]);

  useEffect(() => { void hydrate(); }, [hydrate]);

  const syncFromServer = useCallback(async () => {
    if (apiState !== 'ready' || !tokenRef.current || statePollInFlightRef.current) return;
    statePollInFlightRef.current = true;
    try {
      const state = await requestJson<AppState>('/api/state');
      if (state.runs) setRuns(state.runs);
      if (state.settings) setSettings(state.settings);
      if (state.providers && !providersDirty) setProviders(state.providers);
      if (state.boards?.length) {
        const currentBoards = boardsRef.current;
        const activeId = activeBoardIdRef.current;
        const localActive = currentBoards.find((board) => board.id === activeId);
        const remoteActive = state.boards.find((board) => board.id === activeId);
        const activeRevisionChanged = Boolean(localActive && remoteActive && remoteActive.revision !== localActive.revision);
        if (activeRevisionChanged && dirtyRef.current && localActive && remoteActive) {
          const signature = `${remoteActive.id}:${remoteActive.revision}`;
          setConflict({ boardId: remoteActive.id, localRevision: localActive.revision, remoteRevision: remoteActive.revision });
          if (conflictNoticeRef.current !== signature) {
            conflictNoticeRef.current = signature;
            notify('Codex 或 Agent 已更新這張畫布；本機變更仍保留，請重新載入或先處理衝突。', 'error');
          }
        } else if (activeRevisionChanged && remoteActive) {
          setConflict(undefined);
          conflictNoticeRef.current = undefined;
          paintBoard(remoteActive, { resetSelection: false, restoreViewport: false });
        } else if (conflict && localActive && remoteActive && localActive.revision === remoteActive.revision && !dirtyRef.current) {
          setConflict(undefined);
          conflictNoticeRef.current = undefined;
        }

        const mergedBoards = state.boards.map((remoteBoard) => {
          const localBoard = currentBoards.find((board) => board.id === remoteBoard.id);
          if (!localBoard || localBoard.revision !== remoteBoard.revision) {
            if (remoteBoard.id === activeId && dirtyRef.current && localBoard) return localBoard;
            return remoteBoard;
          }
          return localBoard;
        });
        if (mergedBoards.length !== currentBoards.length || mergedBoards.some((board, index) => board !== currentBoards[index])) {
          boardsRef.current = mergedBoards;
          setBoards(mergedBoards);
        }
      }
      setApiError('');
    } catch (error) {
      setApiError(errorMessage(error));
    } finally {
      statePollInFlightRef.current = false;
    }
  }, [apiState, conflict, notify, paintBoard, providersDirty, requestJson]);

  useEffect(() => {
    if (apiState !== 'ready' || !token) return;
    void syncFromServer();
    const timer = window.setInterval(() => { void syncFromServer(); }, 1000);
    return () => window.clearInterval(timer);
  }, [apiState, syncFromServer, token]);

  const reloadCurrentBoard = useCallback(async () => {
    if (apiState !== 'ready' || !tokenRef.current) {
      notify('服務尚未連線，無法載入最新畫布。', 'error');
      return;
    }
    try {
      const state = await requestJson<AppState>('/api/state');
      const remoteBoard = state.boards.find((board) => board.id === activeBoardIdRef.current);
      if (!remoteBoard) throw new Error('找不到目前畫布');
      boardsRef.current = state.boards;
      setBoards(state.boards);
      if (state.runs) setRuns(state.runs);
      if (state.providers) setProviders(state.providers);
      if (state.settings) setSettings(state.settings);
      setProvidersDirty(false);
      paintBoard(remoteBoard);
      editVersionRef.current += 1;
      dirtyRef.current = false;
      setDirty(false);
      setConflict(undefined);
      conflictNoticeRef.current = undefined;
      notify('已載入服務上的最新畫布。', 'success');
    } catch (error) {
      notify(`載入最新畫布失敗：${errorMessage(error)}`, 'error');
    }
  }, [apiState, notify, paintBoard, requestJson]);

  useEffect(() => {
    if (!activeBoard) return;
    paintBoard(activeBoard);
    dirtyRef.current = false;
    setDirty(false);
    editVersionRef.current += 1;
    setConflict(undefined);
  }, [activeBoardId, paintBoard]);

  useEffect(() => () => {
    if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
    for (const timer of pollTimers.current.values()) window.clearTimeout(timer);
  }, []);

  const updateBoardState = useCallback((nextNodes: FlowNode[], nextEdges: FlowEdge[], markDirty = true) => {
    setBoards((current) => current.map((board) => board.id === activeBoardIdRef.current ? {
      ...board,
      nodes: flowNodesToBoard(nextNodes),
      edges: flowEdgesToBoard(nextEdges),
      viewport: { ...board.viewport },
    } : board));
    if (markDirty) {
      editVersionRef.current += 1;
      dirtyRef.current = true;
      setDirty(true);
    }
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    setNodes((current) => {
      const next = applyNodeChanges(changes, current) as FlowNode[];
      const removedIds = new Set(changes.filter((change) => change.type === 'remove').map((change) => change.id));
      const nextEdges = removedIds.size ? edges.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target)) : edges;
      if (removedIds.size) setEdges(nextEdges);
      const changedGraph = changes.some((change) => change.type === 'add' || change.type === 'replace' || change.type === 'remove' || (change.type === 'position' && change.dragging !== true));
      if (changedGraph) updateBoardState(next, nextEdges);
      return next;
    });
  }, [edges, updateBoardState]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => {
      const next = applyEdgeChanges(changes, current) as FlowEdge[];
      const changedGraph = changes.some((change) => change.type === 'add' || change.type === 'replace' || change.type === 'remove');
      if (changedGraph) updateBoardState(nodes, next);
      return next;
    });
  }, [nodes, updateBoardState]);

  const onConnect = useCallback((connection: Connection) => {
    if (!canConnect(nodes, edges, connection)) {
      notify('這條連線不符合節點資料流規則。', 'error');
      return;
    }
    const next = addEdge({ ...connection, id: makeId('edge'), type: 'smoothstep' }, edges);
    setEdges(next);
    updateBoardState(nodes, next);
  }, [edges, nodes, notify, updateBoardState]);

  const updateSelectedNode = useCallback((patch: Partial<CanvasData>) => {
    if (!selectedNodeId) return;
    setNodes((current) => {
      const next = current.map((node) => node.id === selectedNodeId ? { ...node, data: { ...node.data, ...patch } } : node);
      updateBoardState(next, edges);
      return next;
    });
  }, [edges, selectedNodeId, updateBoardState]);

  const addNode = useCallback((kind: CanvasData['kind'], position?: { x: number; y: number }) => {
    const meta = nodeKindMeta[kind];
    const node: FlowNode = {
      id: makeId(kind),
      type: 'canvas',
      position: position ?? { x: 240 + (nodes.length % 3) * 300, y: 140 + Math.floor(nodes.length / 3) * 210 },
      data: { kind, label: `${String(nodes.length + 1).padStart(2, '0')} / ${meta.label}`, ...defaultData[kind] },
    };
    const next = [...nodes, node];
    setNodes(next);
    updateBoardState(next, edges);
    setSelectedNodeId(node.id);
    setPanel('inspector');
  }, [edges, nodes, updateBoardState]);

  const deleteSelectedNode = useCallback(() => {
    if (!selectedNodeId) return;
    const nextNodes = nodes.filter((node) => node.id !== selectedNodeId);
    const nextEdges = edges.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId);
    setNodes(nextNodes);
    setEdges(nextEdges);
    updateBoardState(nextNodes, nextEdges);
    setSelectedNodeId(undefined);
  }, [edges, nodes, selectedNodeId, updateBoardState]);

  const saveBoard = useCallback((silent = false): Promise<Board | undefined> => {
    if (saveInFlightRef.current) return saveInFlightRef.current;
    const operation = (async (): Promise<Board | undefined> => {
      const board = boardsRef.current.find((candidate) => candidate.id === activeBoardIdRef.current);
      if (!board || apiState !== 'ready' || !tokenRef.current) {
        if (!silent) notify('服務尚未連線，無法保存。', 'error');
        return undefined;
      }
      const editVersionAtStart = editVersionRef.current;
      setSaving(true);
      try {
        const saved = await requestJson<Board | { board: Board }>(`/api/boards/${encodeURIComponent(board.id)}`, {
          method: 'PUT',
          body: JSON.stringify({ expectedRevision: board.revision, board: cleanBoard(board) }),
        });
        const savedBoard = 'board' in saved ? saved.board : saved;
        const editedWhileSaving = editVersionRef.current !== editVersionAtStart;
        setBoards((current) => current.map((candidate) => {
          if (candidate.id !== savedBoard.id) return candidate;
          return editedWhileSaving ? { ...candidate, revision: savedBoard.revision } : savedBoard;
        }));
        if (editedWhileSaving) {
          dirtyRef.current = true;
          setDirty(true);
          if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
          autosaveTimer.current = window.setTimeout(() => { void saveBoard(true); }, 1500);
          if (!silent) notify('已保存較早版本；保存期間的新編輯仍保留，請再次保存。', 'info');
          return undefined;
        }
        dirtyRef.current = false;
        setDirty(false);
        setConflict(undefined);
        conflictNoticeRef.current = undefined;
        if (!silent) notify('畫布已保存。', 'success');
        return savedBoard;
      } catch (error) {
        if (!silent) notify(`保存失敗：${errorMessage(error)}`, 'error');
        else setApiError(errorMessage(error));
        return undefined;
      } finally {
        setSaving(false);
      }
    })();
    saveInFlightRef.current = operation;
    void operation.finally(() => {
      if (saveInFlightRef.current === operation) saveInFlightRef.current = null;
    }).catch(() => undefined);
    return operation;
  }, [apiState, notify, requestJson]);

  useEffect(() => {
    if (!dirty || apiState !== 'ready' || conflict) return;
    if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => { void saveBoard(true); }, 1500);
    return () => { if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current); };
  }, [apiState, conflict, dirty, saveBoard]);

  const createBoard = useCallback(async () => {
    const name = window.prompt('新畫布名稱', 'Untitled direction');
    if (!name?.trim()) return;
    if (apiState !== 'ready') {
      notify('服務尚未連線，無法建立畫布。', 'error');
      return;
    }
    try {
      const created = await requestJson<Board | { board: Board }>('/api/boards', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      const board = 'board' in created ? created.board : created;
      setBoards((current) => [...current, board]);
      setActiveBoardId(board.id);
      notify('新畫布已建立。', 'success');
    } catch (error) {
      notify(`建立畫布失敗：${errorMessage(error)}`, 'error');
    }
  }, [apiState, notify, requestJson]);

  const exportBoard = useCallback(() => {
    if (!activeBoard) return;
    const blob = new Blob([JSON.stringify(cleanBoard(activeBoard), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${activeBoard.name.replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 60) || 'relay-board'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    notify('畫布 JSON 已匯出。', 'success');
  }, [activeBoard, notify]);

  const importBoard = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('匯入檔案不可超過 6 MiB');
      const parsed = parseBoard(JSON.parse(await file.text()));
      const imported: Board = {
        ...parsed,
        id: activeBoard?.id ?? parsed.id,
        revision: activeBoard?.revision ?? parsed.revision,
      };
      setBoards((current) => current.map((board) => board.id === activeBoardIdRef.current ? imported : board));
      setNodes(boardToFlowNodes(imported));
      setEdges(boardToFlowEdges(imported));
      editVersionRef.current += 1;
      dirtyRef.current = true;
      setDirty(true);
      notify('畫布已匯入，保存後才會同步到服務。', 'success');
    } catch (error) {
      notify(`匯入失敗：${errorMessage(error)}`, 'error');
    }
  }, [activeBoard, notify]);

  const validateBoard = useCallback(async (nodeId?: string) => {
    const board = boardsRef.current.find((candidate) => candidate.id === activeBoardIdRef.current);
    if (!board || apiState !== 'ready') {
      notify('服務尚未連線，無法驗證。', 'error');
      return undefined;
    }
    try {
      const response = await requestJson<ExecutionPlan>(`/api/boards/${encodeURIComponent(board.id)}/validate`, {
        method: 'POST',
        body: JSON.stringify(nodeId ? { nodeId } : {}),
      });
      setPlan(response);
      if (response.errors.length) notify(response.errors[0], 'error');
      else notify('資料流驗證通過。', 'success');
      return response;
    } catch (error) {
      notify(`驗證失敗：${errorMessage(error)}`, 'error');
      return undefined;
    }
  }, [apiState, notify, requestJson]);

  const startRun = useCallback(async (nodeId?: string, confirmed = false, operationId = makeOperationId()) => {
    let board = boardsRef.current.find((candidate) => candidate.id === activeBoardIdRef.current);
    if (!board || apiState !== 'ready') {
      notify('服務尚未連線，無法執行。', 'error');
      return;
    }
    if (dirtyRef.current) {
      const savedBoard = await saveBoard();
      if (!savedBoard) return;
      board = savedBoard;
    }
    if (!confirmed) {
      const nextPlan = await validateBoard(nodeId);
      if (!nextPlan || nextPlan.errors.length) return;
      const remoteGenerations = nextPlan.generations.filter((generation) => providers.find((provider) => provider.id === generation.providerId)?.protocol !== 'demo');
      if (remoteGenerations.length) {
        if (!settings.remoteEnabled) {
          notify('遠端生成已由伺服器停用。請先在伺服器設定中開啟。', 'error');
          return;
        }
        setConfirmRun({ nodeId, operationId, plan: nextPlan });
        return;
      }
    }
    setRunBusy(true);
    try {
      const created = await requestJson<Run | { run: Run }>('/api/runs', {
        method: 'POST',
        body: JSON.stringify({ boardId: board.id, expectedRevision: board.revision, operationId, ...(nodeId ? { nodeId } : {}), confirmExternal: confirmed }),
      });
      const run = 'run' in created ? created.run : created;
      setRuns((current) => [run, ...current.filter((candidate) => candidate.id !== run.id)]);
      setConfirmRun(undefined);
      notify(`已開始${nodeId ? '選取節點' : '整張畫布'}執行。`, 'success');
      const poll = async () => {
        try {
          const latest = await requestJson<Run>(`/api/runs/${encodeURIComponent(run.id)}`);
          setRuns((current) => [latest, ...current.filter((candidate) => candidate.id !== latest.id)]);
          if (!terminalStatuses.has(latest.status)) {
            const timer = window.setTimeout(() => { void poll(); }, 1000);
            pollTimers.current.set(latest.id, timer);
          } else {
            setRunBusy(false);
            if (latest.status === 'succeeded') notify('執行完成，產物已回到畫布。', 'success');
            else notify(`執行${statusLabel(latest.status)}。`, latest.status === 'failed' ? 'error' : 'info');
          }
        } catch (error) {
          setRunBusy(false);
          notify(`讀取執行狀態失敗：${errorMessage(error)}`, 'error');
        }
      };
      void poll();
    } catch (error) {
      setRunBusy(false);
      notify(`啟動執行失敗：${errorMessage(error)}`, 'error');
    }
  }, [apiState, notify, providers, requestJson, saveBoard, settings.remoteEnabled, validateBoard]);

  const cancelRun = useCallback(async () => {
    if (!activeRun || apiState !== 'ready') return;
    try {
      const cancelled = await requestJson<Run>(`/api/runs/${encodeURIComponent(activeRun.id)}/cancel`, { method: 'POST', body: '{}' });
      setRuns((current) => [cancelled, ...current.filter((candidate) => candidate.id !== cancelled.id)]);
      notify('已取消本機輪詢；遠端供應商可能仍在處理。', 'info');
      setRunBusy(false);
    } catch (error) {
      notify(`取消失敗：${errorMessage(error)}`, 'error');
    }
  }, [activeRun, apiState, notify, requestJson]);

  useEffect(() => {
    if (!latestRun) return;
    const resultByNode = latestRun.results ?? {};
    setNodes((current) => current.map((node) => {
      const result = resultByNode[node.id];
      const artifact = assetForResult(result);
      return result ? { ...node, data: { ...node.data, runStatus: result.status, runError: result.error, previewUrl: artifact?.url } } : node;
    }));
  }, [latestRunSignature]);

  const changeBoard = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    if (dirtyRef.current && !window.confirm('目前畫布有尚未保存的變更，要切換嗎？')) return;
    setActiveBoardId(event.target.value);
  }, []);

  const updateProviderDraft = useCallback((patch: Partial<Provider>) => {
    setProviders((current) => current.map((provider) => provider.id === providerDraftId ? { ...provider, ...patch } : provider));
    setProvidersDirty(true);
  }, [providerDraftId]);

  const addProvider = useCallback(() => {
    if (providers.length >= 20) {
      notify('供應商最多 20 個。', 'error');
      return;
    }
    const id = makeId('provider');
    const envSuffix = id.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
    const provider: Provider = {
      id,
      name: 'New provider',
      protocol: 'openai',
      baseUrl: '',
      keyEnv: `RELAY_KEY_${envSuffix}`.slice(0, 74),
      imageModel: 'model-name',
      videoModel: '',
    };
    setProviders((current) => [...current, provider]);
    setProvidersDirty(true);
    setProviderDraftId(id);
    notify('已新增供應商設定，請填入協定與環境變數名稱。', 'info');
  }, [notify, providers.length]);

  const saveProviders = useCallback(async () => {
    if (apiState !== 'ready') {
      notify('服務尚未連線，無法保存供應商設定。', 'error');
      return;
    }
    try {
      const response = await requestJson<Provider[] | { providers: Provider[] }>('/api/providers', { method: 'PUT', body: JSON.stringify({ providers }) });
      setProviders('providers' in response ? response.providers : response);
      setProvidersDirty(false);
      notify('供應商設定已保存。', 'success');
    } catch (error) {
      notify(`供應商設定保存失敗：${errorMessage(error)}`, 'error');
    }
  }, [apiState, notify, providers, requestJson]);

  const onDrop = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const kind = event.dataTransfer.getData('application/relay-node') as CanvasData['kind'];
    if (!kind || !nodeKindMeta[kind]) return;
    const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    addNode(kind, position);
  }, [addNode, reactFlow]);

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const selectedResult = selectedNodeId && latestRun ? latestRun.results[selectedNodeId] : undefined;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /></div>
          <div>
            <div className="brand-name">Relay Canvas</div>
            <div className="brand-kicker">IDEAS, CONNECTED.</div>
          </div>
          <span className="version-tag">v0.1.0</span>
        </div>
        <div className="board-switcher">
          <Layers3 size={15} />
          <select aria-label="board-name" value={activeBoard?.id ?? ''} onChange={changeBoard}>
            {boards.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}
          </select>
          <button className="icon-button subdued" aria-label="new-board" onClick={() => void createBoard()} title="新增畫布"><Plus size={17} /></button>
        </div>
        <div className="topbar-actions">
          <div className={`connection-pill ${apiState}`} title={apiState === 'ready' ? 'Local API connected' : apiError}>
            <span className="connection-dot" />
            {apiState === 'ready' ? 'LOCAL API' : apiState === 'loading' ? 'CONNECTING' : 'OFFLINE'}
          </div>
          <button className="ghost-button" onClick={() => setPanel('help')}><CircleHelp size={15} />MCP help</button>
          <button className="primary-button" aria-label="save" onClick={() => void saveBoard()} disabled={saving || !dirty}>
            {saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} {saving ? '保存中' : '保存'}
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="left-rail">
          <div className="rail-section rail-section-main">
            <div className="rail-label">BUILD</div>
            {(Object.keys(nodeKindMeta) as CanvasData['kind'][]).map((kind) => {
              const meta = nodeKindMeta[kind];
              const Icon = meta.icon;
              return (
                <button key={kind} className="rail-tool" draggable onDragStart={(event) => event.dataTransfer.setData('application/relay-node', kind)} onClick={() => addNode(kind)} aria-label={`add-node-${kind}`} title={`加入 ${meta.label}`}>
                  <span className="rail-tool-icon" style={{ color: meta.color }}><Icon size={17} /></span>
                  <span>{meta.label}</span>
                </button>
              );
            })}
          </div>
          <div className="rail-section rail-section-run">
            <div className="rail-label">RUN</div>
            <button className="rail-tool run-tool" aria-label="run-selected" disabled={!selectedNodeId || runBusy} onClick={() => void startRun(selectedNodeId)} title="執行選取節點及其依賴"><span className="rail-tool-icon"><Play size={16} fill="currentColor" /></span><span>Selected</span></button>
            <button className="rail-tool run-tool" aria-label="run-all" disabled={runBusy} onClick={() => void startRun()} title="執行整張畫布"><span className="rail-tool-icon"><Zap size={16} fill="currentColor" /></span><span>Run all</span></button>
            <button className="rail-tool" aria-label="cancel-run" disabled={!activeRun} onClick={() => void cancelRun()} title="取消目前執行"><span className="rail-tool-icon"><Square size={15} fill="currentColor" /></span><span>Cancel</span></button>
          </div>
          <div className="rail-spacer" />
          <div className="rail-section">
            <button className={`rail-tool ${panel === 'history' ? 'is-active' : ''}`} onClick={() => setPanel('history')}><span className="rail-tool-icon"><Clock3 size={17} /></span><span>History</span></button>
            <button className={`rail-tool ${panel === 'providers' ? 'is-active' : ''}`} aria-label="provider-settings" onClick={() => setPanel('providers')}><span className="rail-tool-icon"><Settings2 size={17} /></span><span>Providers</span></button>
            <button className={`rail-tool ${panel === 'help' ? 'is-active' : ''}`} onClick={() => setPanel('help')}><span className="rail-tool-icon"><CircleHelp size={17} /></span><span>Guide</span></button>
          </div>
          <div className="rail-footnote"><span className="demo-chip">DEMO</span><span>Local-first</span></div>
        </aside>

        <main className="canvas-stage" onDrop={onDrop} onDragOver={onDragOver}>
          <div className="canvas-toolbar">
            <div className="canvas-toolbar-copy">
              <div className="canvas-title-row"><h1>{activeBoard?.name ?? 'Untitled board'}</h1>{dirty && <span className="unsaved-dot" title="有尚未保存的變更" />}</div>
              <span className="canvas-subtitle"><GitBranch size={13} /> {nodes.length} nodes <span className="dot-separator">·</span> {edges.length} connections <span className="dot-separator">·</span> rev {activeBoard?.revision ?? 0}</span>
            </div>
            <div className="canvas-toolbar-actions">
              <button className="toolbar-button" onClick={() => void validateBoard(selectedNodeId)}><Check size={14} />Validate</button>
              <button className="toolbar-button" aria-label="export-board" onClick={exportBoard}><Download size={14} />Export</button>
              <button className="toolbar-button" aria-label="import-board" onClick={() => fileInputRef.current?.click()}><Upload size={14} />Import</button>
              <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={(event) => void importBoard(event)} hidden />
            </div>
          </div>
          {conflict && <div className="conflict-banner" role="alert"><AlertCircle size={15} /><div><strong>畫布有新的遠端 revision</strong><span>本機 rev {conflict.localRevision} · server rev {conflict.remoteRevision}；你的編輯仍保留。</span></div><button className="conflict-reload" aria-label="reload-board" onClick={() => void reloadCurrentBoard()}><RefreshCw size={13} />載入最新版本</button></div>}
          <div className="canvas-wrap">
            <ReactFlow<FlowNode, FlowEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, node) => { setSelectedNodeId(node.id); setPanel('inspector'); }}
              onPaneClick={() => setSelectedNodeId(undefined)}
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1.05 }}
              deleteKeyCode={['Backspace', 'Delete']}
              snapToGrid
              snapGrid={[16, 16]}
              connectionLineStyle={{ stroke: '#c8ff5a', strokeWidth: 1.5 }}
              defaultEdgeOptions={{ type: 'smoothstep', style: { stroke: '#64705b', strokeWidth: 1.4 } }}
              proOptions={{ hideAttribution: true }}
              colorMode="dark"
            >
              <Background color="#263028" gap={24} size={1} />
              <Controls showInteractive={false} position="bottom-left" />
              <MiniMap position="bottom-right" nodeColor={(node) => nodeKindMeta[(node.data as CanvasData).kind]?.color ?? '#59645b'} maskColor="rgba(9, 13, 11, 0.72)" />
            </ReactFlow>
            <div className="canvas-watermark"><span className="watermark-pulse" />{apiState === 'ready' ? 'Connected to local runtime' : 'Demo canvas · local preview'}</div>
          </div>
          {plan && <div className={`validation-toast ${plan.errors.length ? 'has-errors' : ''}`}><span>{plan.errors.length ? <AlertCircle size={14} /> : <Check size={14} />}</span><div><strong>{plan.errors.length ? 'Validation needs attention' : 'Ready to run'}</strong><small>{plan.errors.length ? plan.errors[0] : `${plan.order.length} node${plan.order.length === 1 ? '' : 's'} in execution order`}</small></div><button aria-label="close-validation" onClick={() => setPlan(undefined)}><X size={14} /></button></div>}
        </main>

        <aside className={`right-panel ${panel === 'inspector' ? '' : 'panel-mode'}`}>
          <div className="panel-tabs">
            <button className={panel === 'inspector' ? 'is-active' : ''} onClick={() => setPanel('inspector')}><PanelRight size={15} />Inspector</button>
            <button className={panel === 'history' ? 'is-active' : ''} onClick={() => setPanel('history')}><Clock3 size={15} />History{runs.length > 0 && <span className="tab-count">{runs.length}</span>}</button>
          </div>
          {panel === 'inspector' && <InspectorPanel node={selectedNode} providers={providers} selectedResult={selectedResult} onChange={updateSelectedNode} onDelete={deleteSelectedNode} onOpenProviders={() => { setProviderDraftId(selectedNode?.data.providerId ?? 'demo'); setPanel('providers'); }} />}
          {panel === 'history' && <HistoryPanel runs={runs.filter((run) => run.boardId === activeBoardId)} activeRunId={activeRun?.id} currentRevision={activeBoard?.revision} onSelect={(run) => { if (run.revision !== activeBoard?.revision) { notify('這筆執行來自較舊 revision，保留在 history，不覆蓋目前畫布。', 'info'); return; } setNodes((current) => current.map((node) => { const result = run.results[node.id]; const artifact = assetForResult(result); return result ? { ...node, data: { ...node.data, runStatus: result.status, runError: result.error, previewUrl: artifact?.url } } : node; })); }} />}
          {panel === 'providers' && <ProvidersPanel providers={providers} selectedId={providerDraftId} settings={settings} dirty={providersDirty} onSelect={setProviderDraftId} onChange={updateProviderDraft} onAdd={addProvider} onSave={() => void saveProviders()} />}
          {panel === 'help' && <HelpPanel />}
        </aside>
      </div>

      <footer className="statusbar">
        <div className="statusbar-left"><span className="statusbar-item"><LockKeyhole size={12} /> Your workspace stays local</span><span className="statusbar-divider" /><span className="statusbar-item"><Code2 size={12} /> Adapter contract tested · live unverified</span></div>
        <div className="statusbar-right"><span className="statusbar-item"><Activity size={12} /> {activeRun ? `Run ${statusLabel(activeRun.status)}` : 'Ready'}</span><span className="statusbar-item rev-chip">REV {activeBoard?.revision ?? 0}</span></div>
      </footer>

      {toast && <div className={`toast toast-${toast.tone}`} role="status"><span className="toast-icon">{toast.tone === 'success' ? <Check size={15} /> : toast.tone === 'error' ? <AlertCircle size={15} /> : <Info size={15} />}</span>{toast.message}<button onClick={() => setToast(undefined)} aria-label="close-message"><X size={14} /></button></div>}

      {confirmRun && <RunConfirmDialog confirm={confirmRun} providers={providers} onCancel={() => setConfirmRun(undefined)} onConfirm={() => void startRun(confirmRun.nodeId, true, confirmRun.operationId)} />}
    </div>
  );
}

function InspectorPanel({ node, providers, selectedResult, onChange, onDelete, onOpenProviders }: { node?: FlowNode; providers: Provider[]; selectedResult?: NodeResult; onChange: (patch: Partial<CanvasData>) => void; onDelete: () => void; onOpenProviders: () => void }) {
  if (!node) {
    return <div className="empty-panel"><div className="empty-icon"><Maximize2 size={20} /></div><h2>Select a node</h2><p>從畫布選一個節點，開始編輯提示詞、模型與輸出設定。</p><div className="empty-hint"><Link2 size={14} />拖曳節點右側連接點建立資料流</div></div>;
  }
  const meta = nodeKindMeta[node.data.kind];
  const Icon = meta.icon;
  const provider = providers.find((candidate) => candidate.id === node.data.providerId);
  const isGenerator = node.data.kind === 'image' || node.data.kind === 'video';
  const handleProviderChange = (providerId: string) => {
    const nextProvider = providers.find((candidate) => candidate.id === providerId);
    const model = node.data.kind === 'video' ? nextProvider?.videoModel : nextProvider?.imageModel;
    onChange({
      providerId,
      model,
      ...(node.data.kind === 'video' ? { referenceField: recommendedReferenceField(model ?? '') } : {}),
    });
  };
  const handleModelChange = (model: string) => {
    onChange(node.data.kind === 'video' ? { model, referenceField: recommendedReferenceField(model) } : { model });
  };
  return (
    <div className="inspector-content">
      <div className="panel-heading"><div><span className="panel-eyebrow">NODE INSPECTOR</span><h2>{meta.label} settings</h2></div><button className="icon-button" onClick={onDelete} aria-label="delete-node" title="刪除節點"><Trash2 size={15} /></button></div>
      <div className="node-identity"><span className="identity-icon" style={{ color: meta.color }}><Icon size={17} /></span><div><strong>{node.data.label}</strong><span>{node.id}</span></div><span className={`identity-status ${statusClass(selectedResult?.status ?? node.data.runStatus)}`}>{statusLabel(selectedResult?.status ?? node.data.runStatus)}</span></div>
      <Field label="Label"><input value={node.data.label} onChange={(event) => onChange({ label: event.target.value })} /></Field>
      {(node.data.kind === 'prompt' || node.data.kind === 'note' || isGenerator) && <Field label={node.data.kind === 'note' ? 'Direction' : 'Prompt'} hint={node.data.kind === 'prompt' ? '上游文字會在執行時接到下游提示詞前。' : undefined}><textarea aria-label="prompt-editor" value={node.data.prompt ?? ''} onChange={(event) => onChange({ prompt: event.target.value })} rows={node.data.kind === 'note' ? 8 : 7} placeholder="寫下畫面、動作或方向…" /></Field>}
      {node.data.kind === 'asset' && <><Field label="Asset URL" hint="使用受允許的 media origin；瀏覽器不會帶 cookies。"><input value={node.data.assetUrl ?? ''} onChange={(event) => onChange({ assetUrl: event.target.value })} placeholder="https://…" /></Field><Field label="Asset kind"><select value={node.data.assetKind ?? 'image'} onChange={(event) => onChange({ assetKind: event.target.value as 'image' | 'video' })}><option value="image">Image</option><option value="video">Video</option></select></Field></>}
      {isGenerator && <>
        <div className="section-divider"><span>GENERATION</span></div>
        <Field label="Provider"><div className="select-with-action"><select value={node.data.providerId ?? 'demo'} onChange={(event) => handleProviderChange(event.target.value)}><option value="">Select provider</option>{providers.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}{candidate.protocol === 'demo' ? ' · DEMO' : ''}</option>)}</select><button className="mini-icon-button" onClick={onOpenProviders} aria-label="provider-settings" title="編輯供應商"><Settings2 size={14} /></button></div></Field>
        <Field label="Model" hint={provider?.protocol === 'demo' ? '離線 Demo，不消耗 AI 額度。' : '自訂模型／協定驗證，未做 live 驗證。'}><input value={node.data.model ?? ''} onChange={(event) => handleModelChange(event.target.value)} placeholder="model-name" /></Field>
        {node.data.kind === 'video' && <Field label="Reference field"><input value={node.data.referenceField ?? 'image_url'} onChange={(event) => onChange({ referenceField: event.target.value })} /></Field>}
        <div className="params-box"><div className="params-heading"><span>PARAMETERS</span><SlidersHorizontal size={13} /></div><div className="params-grid"><ParamField label="Aspect" value={String(node.data.params?.aspect_ratio ?? '16:9')} onChange={(value) => onChange({ params: { ...(node.data.params ?? {}), aspect_ratio: value } })} /><ParamField label="Quality" value={String(node.data.params?.quality ?? 'standard')} onChange={(value) => onChange({ params: { ...(node.data.params ?? {}), quality: value } })} /></div></div>
      </>}
      {selectedResult && <ResultBlock result={selectedResult} />}
      <div className="inspector-footer"><span><Info size={12} /> Changes autosave when connected</span></div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}

function ParamField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="param-field"><span>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function ResultBlock({ result }: { result: NodeResult }) {
  const artifact = assetForResult(result);
  return <div className="result-block"><div className="result-heading"><span>LAST RESULT</span><span className={`result-status ${statusClass(result.status)}`}>{statusLabel(result.status)}</span></div>{artifact?.url && <div className="result-asset"><span>{artifact.demo ? 'DEMO OUTPUT' : 'OUTPUT'}</span>{artifact.kind === 'image' ? <img src={artifact.url} alt="Generated output" referrerPolicy="no-referrer" crossOrigin="anonymous" /> : <video src={artifact.url} controls muted playsInline crossOrigin="anonymous" />}</div>}{result.error && <p className="result-error"><AlertCircle size={13} />{result.error}</p>}{result.referenceUrl && <p className="result-reference">Reference bound from this run</p>}</div>;
}

function HistoryPanel({ runs, activeRunId, currentRevision, onSelect }: { runs: Run[]; activeRunId?: string; currentRevision?: number; onSelect: (run: Run) => void }) {
  return <div className="history-content"><div className="panel-heading"><div><span className="panel-eyebrow">EXECUTION LOG</span><h2>Run history</h2></div><span className="history-count">{runs.length.toString().padStart(2, '0')}</span></div>{runs.length === 0 ? <div className="empty-panel compact"><div className="empty-icon"><Clock3 size={19} /></div><h2>No runs yet</h2><p>執行節點後，這裡會保留狀態與產物。</p></div> : <div className="run-list">{runs.map((run) => <button key={run.id} className={`run-card ${run.id === activeRunId ? 'is-active' : ''} ${run.revision !== currentRevision ? 'is-stale' : ''}`} onClick={() => onSelect(run)}><div className="run-card-top"><span className={`run-status-mark ${statusClass(run.status)}`} /> <strong>Canvas execution</strong><span className={`run-status-label ${statusClass(run.status)}`}>{statusLabel(run.status)}</span></div><div className="run-card-meta"><span>{new Date(run.startedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</span><span>{run.order.length} nodes</span><span>rev {run.revision}{run.revision !== currentRevision ? ' · archived' : ''}</span></div></button>)}</div>}</div>;
}

function ProvidersPanel({ providers, selectedId, settings, dirty, onSelect, onChange, onAdd, onSave }: { providers: Provider[]; selectedId: string; settings: AppState['settings']; dirty: boolean; onSelect: (id: string) => void; onChange: (patch: Partial<Provider>) => void; onAdd: () => void; onSave: () => void }) {
  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];
  if (!selected) return null;
  return <div className="providers-content"><div className="panel-heading"><div><span className="panel-eyebrow">RUNTIME CONFIG</span><h2>Providers</h2></div><div className="provider-heading-actions"><button className="icon-button" aria-label="add-provider" onClick={onAdd} title="新增供應商"><Plus size={15} /></button><button className="primary-button compact-button" onClick={onSave} disabled={!dirty}><Save size={14} />Save</button></div></div><div className="provider-list">{providers.map((provider) => <button key={provider.id} className={`provider-row ${provider.id === selected.id ? 'is-selected' : ''}`} onClick={() => onSelect(provider.id)}><span className="provider-orb" data-protocol={provider.protocol}>{provider.protocol === 'demo' ? <Sparkles size={14} /> : <Zap size={14} />}</span><span><strong>{provider.name}</strong><small>{provider.protocol === 'demo' ? 'Offline preview' : provider.protocol.toUpperCase()}</small></span><ChevronDown className="provider-chevron" size={14} /></button>)}</div><div className="provider-detail"><Field label="Provider ID"><input value={selected.id} readOnly /></Field><Field label="Display name"><input value={selected.name} onChange={(event) => onChange({ name: event.target.value })} /></Field><Field label="Protocol"><select value={selected.protocol} onChange={(event) => onChange({ protocol: event.target.value as Provider['protocol'] })}><option value="demo">Demo</option><option value="openai">OpenAI compatible</option><option value="fal">fal.ai</option><option value="replicate">Replicate</option></select></Field><Field label="Base URL" hint="只允許伺服器設定的 exact HTTPS origin。"><input value={selected.baseUrl} onChange={(event) => onChange({ baseUrl: event.target.value })} placeholder="https://api.example.com" /></Field><Field label="Key env name" hint="只填環境變數名稱，不要填入金鑰值。"><input value={selected.keyEnv} onChange={(event) => onChange({ keyEnv: event.target.value })} placeholder="RELAY_KEY_PROVIDER" /></Field><Field label="Image model"><input value={selected.imageModel} onChange={(event) => onChange({ imageModel: event.target.value })} /></Field><Field label="Video model"><input value={selected.videoModel} onChange={(event) => onChange({ videoModel: event.target.value })} placeholder="Not supported" /></Field><div className="key-env"><LockKeyhole size={13} /><span>Runtime reads the secret from server env</span><code>{selected.keyEnv || 'No key required'}</code></div></div><div className="remote-banner"><div className="remote-banner-icon"><Activity size={15} /></div><div><strong>{settings.remoteEnabled ? 'Remote generation enabled' : 'Remote generation disabled'}</strong><p>{settings.remoteEnabled ? '每次外部生成仍需在執行前確認。' : 'Demo 可離線執行；遠端 provider 目前由伺服器停用。'}</p></div></div></div>;
}

function HelpPanel() {
  const [copied, setCopied] = useState(false);
  const mcpConfig = `codex mcp add relay-canvas \\
  --env RELAY_DATA_DIR=/absolute/path/to/relay-canvas/.relay-canvas \\
  -- node /absolute/path/to/relay-canvas/build/server/mcp.js`;
  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(mcpConfig);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      setCopied(false);
    }
  };
  return <div className="help-content"><div className="panel-heading"><div><span className="panel-eyebrow">CONTROL SURFACE</span><h2>Codex MCP</h2></div><span className="live-badge">LIVE API</span></div><div className="help-lead"><div className="help-orb"><Code2 size={21} /></div><p>Relay Canvas 提供 stdio MCP 控制面，讓 Codex 讀取畫布、套用原子 patch、驗證資料流、啟動執行並查看結果。</p></div><div className="help-list"><HelpRow number="01" title="Read" copy="列出畫布、節點、連線與最近執行。" /><HelpRow number="02" title="Apply" copy="以 revision 條件原子修改節點與連線。" /><HelpRow number="03" title="Validate" copy="在送出前檢查 DAG、輸入型別與 provider。" /><HelpRow number="04" title="Run" copy="Demo 可直接執行；遠端需要明確確認。" /></div><div className="mcp-config"><div className="mcp-config-heading"><span>CONNECT CONFIG</span><button className="mini-icon-button" aria-label="copy-mcp-config" onClick={() => void copyConfig()} title="複製 MCP 設定"><Copy size={13} /></button></div><pre>{mcpConfig}</pre><div className="mcp-config-hint">建置後執行 <code>node /absolute/path/to/relay-canvas/build/server/mcp.js</code>；若資料目錄不同，設定 <code>RELAY_DATA_DIR=/absolute/path/to/.relay-canvas</code>。必須先啟動本機 server。</div>{copied && <span className="copy-confirm"><Check size={12} />已複製</span>}</div><div className="help-callout"><Info size={15} /><span>MCP 會讀取已啟動 server 的本機 session，並透過同一組 revision checked API 工作。</span></div><div className="help-footer"><span className="demo-chip">DEMO</span><span>Protocol tested · live unverified</span></div></div>;
}

function HelpRow({ number, title, copy }: { number: string; title: string; copy: string }) {
  return <div className="help-row"><span>{number}</span><div><strong>{title}</strong><p>{copy}</p></div><ArrowRight size={14} /></div>;
}

function RunConfirmDialog({ confirm, providers, onCancel, onConfirm }: { confirm: { nodeId?: string; operationId: string; plan: ExecutionPlan }; providers: Provider[]; onCancel: () => void; onConfirm: () => void }) {
  const remote = confirm.plan.generations.filter((generation) => providers.find((provider) => provider.id === generation.providerId)?.protocol !== 'demo');
  const remoteModels = [...new Set(remote.map((generation) => `${providers.find((provider) => provider.id === generation.providerId)?.name ?? generation.providerId} · ${generation.model}`))];
  return <div className="dialog-scrim" role="presentation"><div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-run-title"><div className="dialog-icon"><Activity size={21} /></div><div className="panel-eyebrow">EXTERNAL ACTION</div><h2 id="confirm-run-title">Run remote generation?</h2><p>這次執行會呼叫外部 provider，可能產生費用。確認前請檢查 provider、model 與節點數。</p><div className="confirm-summary"><div><span>PROVIDERS</span><strong>{[...new Set(remote.map((generation) => providers.find((provider) => provider.id === generation.providerId)?.name ?? generation.providerId))].join(', ')}</strong></div><div><span>GENERATIONS</span><strong>{remote.length}</strong></div><div><span>MODELS</span><strong>{remoteModels.join(', ')}</strong></div><div><span>MODE</span><strong>{confirm.nodeId ? 'Selected + ancestors' : 'Entire board'}</strong></div></div><div className="dialog-warning"><AlertCircle size={14} />未知 POST 結果不會自動重送；取消只停止本機輪詢。</div><div className="dialog-actions"><button className="ghost-button" onClick={onCancel}>Back</button><button className="primary-button" onClick={onConfirm}><Play size={14} fill="currentColor" />Confirm run</button></div></div></div>;
}

export default function App() {
  return <ReactFlowProvider><AppShell /></ReactFlowProvider>;
}
