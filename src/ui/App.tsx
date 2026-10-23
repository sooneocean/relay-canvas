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
  ArrowLeft,
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
  GitCompareArrows,
  Home,
  Image as ImageIcon,
  ImagePlus,
  Info,
  LayoutGrid,
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
  Scissors,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  StickyNote,
  Trash2,
  Upload,
  Video,
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
  LocalAsset,
  ImportAssetResult,
  NodeResult,
  Provider,
  ProviderDiagnostic,
  ProviderModels,
  Run,
  Status,
  ExportJob,
} from '../shared/types.js';
import { parseBoard } from '../shared/schema.js';
import { deriveAssets, deriveProjects, type AssetItem, type ProjectCard } from './catalog.js';
import RunCompare from './RunCompare.js';
import TimelineEditor, { validateTimelineHandoff, type SaveArtifact, type TimelineHandoffIntent, type UiRequest } from './TimelineEditor.js';
import VideoThumbnail from './VideoThumbnail.js';

type FlowNode = Node<CanvasData & { previewUrl?: string; runStatus?: Status; runError?: string }, 'canvas'>;
type FlowEdge = Edge;
type Panel = 'inspector' | 'history' | 'providers' | 'help';
type View = 'home' | 'canvas' | 'assets';
type AssetFilter = 'all' | 'image' | 'video';
type ApiState = 'loading' | 'ready' | 'offline';
type BoardConflict = { boardId: string; localRevision: number; remoteRevision: number };

const MAX_IMPORT_BYTES = 6 * 1024 * 1024;
const MAX_MEDIA_IMPORT_BYTES = 64 * 1024 * 1024;
const MAX_LOCAL_REFERENCE_BYTES = 4 * 1024 * 1024;
const MEDIA_IMPORT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm']);
const MEDIA_IMPORT_ACCEPT = 'image/png,image/jpeg,image/webp,video/mp4,video/webm';
const BOARD_IMPORT_ACCEPT = 'application/json,.json';

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
  for (const key of ['prompt', 'providerId', 'model', 'params', 'referenceField', 'assetId', 'assetUrl', 'assetKind'] as const) {
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

function boardToFlowNodes(board: Board, localAssets: LocalAsset[] = []): FlowNode[] {
  const assetsById = new Map(localAssets.map((asset) => [asset.id, asset]));
  return board.nodes.map((node) => ({
    id: node.id,
    type: 'canvas',
    position: node.position,
    data: {
      ...node.data,
      ...(node.data.assetId && assetsById.has(node.data.assetId)
        ? { previewUrl: artifactUrl(assetsById.get(node.data.assetId)?.artifact) }
        : {}),
    },
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
    if (sourceOutput !== 'text' && sourceOutput !== 'image' && sourceOutput !== 'asset') return false;
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

function localImageReferenceInfo(nodes: FlowNode[], edges: FlowEdge[], generationIds: string[], localAssets: LocalAsset[]): LocalImageReferenceInfo {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, string[]>();
  for (const edge of edges) incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
  const assetsById = new Map(localAssets.map((asset) => [asset.id, asset]));
  const visited = new Set<string>();
  const matched = new Set<string>();
  const stack = [...generationIds];
  while (stack.length) {
    const id = stack.pop();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const node = nodesById.get(id);
    if (node?.data.kind === 'asset' && node.data.assetId) {
      const asset = assetsById.get(node.data.assetId);
      const kind = node.data.assetKind ?? asset?.artifact.kind;
      if (kind === 'image') matched.add(node.data.assetId);
    }
    stack.push(...(incoming.get(id) ?? []));
  }
  const oversized = [...matched].some((assetId) => (assetsById.get(assetId)?.artifact.bytes ?? 0) > MAX_LOCAL_REFERENCE_BYTES);
  return { count: matched.size, oversized };
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

function artifactUrl(artifact?: Artifact): string | undefined {
  return artifact?.localUrl ?? artifact?.url;
}

function mediaKindForFile(file: File): 'image' | 'video' | undefined {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return undefined;
}

function formatBytes(bytes?: number): string {
  if (!Number.isFinite(bytes)) return '大小未知';
  if (bytes! >= 1024 * 1024) return `${(bytes! / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes! >= 1024) return `${Math.round(bytes! / 1024)} KiB`;
  return `${bytes} B`;
}

type AssetSaveState = { status: 'saving' | 'saved' | 'failed'; message?: string };
type MediaImportState = {
  file: File;
  operationId: string;
  kind: 'image' | 'video';
  status: 'saving' | 'uploading' | 'failed';
  error?: string;
  boardId: string;
};
type LocalImageReferenceInfo = { count: number; oversized: boolean };
type RunConfirmState = {
  nodeId?: string;
  operationId: string;
  plan: ExecutionPlan;
  requestedImageCount: number;
  localImageReference: LocalImageReferenceInfo;
};
type ProviderTemplate = 'openai' | 'newapi' | 'videos' | 'relay' | 'fal' | 'replicate';

export type RelayFlowAppend = {
  nodes: FlowNode[];
  edges: FlowEdge[];
  imageNodeId: string;
  videoNodeId: string;
};

export function buildRelayFlow(
  nodes: FlowNode[],
  edges: FlowEdge[],
  provider: Provider,
  idFactory: (prefix: string) => string = makeId,
): RelayFlowAppend | undefined {
  if (provider.protocol !== 'relay' || !provider.imageModel.trim() || !provider.videoModel.trim()) return undefined;
  if (nodes.length + 2 > 100 || edges.length + 1 > 200) return undefined;

  const imageNodeId = idFactory('image');
  const videoNodeId = idFactory('video');
  const edgeId = idFactory('edge');
  const existingIds = new Set([...nodes.map((node) => node.id), ...edges.map((edge) => edge.id)]);
  if (
    !imageNodeId || !videoNodeId || !edgeId ||
    new Set([imageNodeId, videoNodeId, edgeId]).size !== 3 ||
    imageNodeId === videoNodeId || existingIds.has(imageNodeId) || existingIds.has(videoNodeId) || existingIds.has(edgeId)
  ) return undefined;

  // Creator nodes are roughly 340x300 in the canvas. Search a deterministic
  // grid for a horizontal pair with a 40px gap, while keeping a small safety
  // margin around existing nodes. This preserves every existing position and
  // keeps the newly-added image node selectable when imported/custom nodes are
  // already clustered near the usual insertion coordinates.
  const footprint = { width: 340, height: 300 } as const;
  const margin = 20;
  const pairGap = 40;
  const pairStepX = footprint.width + pairGap;
  const pairStepY = footprint.height + pairGap;
  const occupied = nodes.map((node) => ({
    x: node.position.x - margin,
    y: node.position.y - margin,
    width: footprint.width + margin * 2,
    height: footprint.height + margin * 2,
  }));
  const overlaps = (left: { x: number; y: number; width: number; height: number }, right: typeof left) =>
    left.x < right.x + right.width && left.x + left.width > right.x &&
    left.y < right.y + right.height && left.y + left.height > right.y;
  let position: { x: number; y: number } | undefined;
  for (let row = 0; row <= nodes.length + 1 && !position; row += 1) {
    for (let column = 0; column < 6; column += 1) {
      const image = { x: column * pairStepX, y: row * pairStepY, width: footprint.width, height: footprint.height };
      const video = { x: image.x + footprint.width + pairGap, y: image.y, width: footprint.width, height: footprint.height };
      if (occupied.some((node) => overlaps(image, node) || overlaps(video, node))) continue;
      position = { x: image.x, y: image.y };
      break;
    }
  }
  if (!position) return undefined;
  const imageNode: FlowNode = {
    id: imageNodeId,
    type: 'canvas',
    position,
    data: {
      kind: 'image',
      label: `${String(nodes.length + 1).padStart(2, '0')} / Relay image`,
      providerId: provider.id,
      model: provider.imageModel,
      prompt: '編輯圖片提示詞。',
      params: {},
    },
  };
  const videoNode: FlowNode = {
    id: videoNodeId,
    type: 'canvas',
    position: { x: imageNode.position.x + footprint.width + pairGap, y: imageNode.position.y },
    data: {
      kind: 'video',
      label: `${String(nodes.length + 2).padStart(2, '0')} / Relay video`,
      providerId: provider.id,
      model: provider.videoModel,
      prompt: '編輯影片提示詞。',
      params: {},
      referenceField: 'image_url',
    },
  };
  const edge: FlowEdge = { id: edgeId, source: imageNodeId, target: videoNodeId, type: 'smoothstep', animated: false };
  return { nodes: [...nodes, imageNode, videoNode], edges: [...edges, edge], imageNodeId, videoNodeId };
}

function createStarterNode(kind: CanvasData['kind']): FlowNode {
  const meta = nodeKindMeta[kind];
  return {
    id: makeId(kind),
    type: 'canvas',
    position: { x: 0, y: 0 },
    data: { kind, label: `01 / ${meta.label}`, ...defaultData[kind] },
  };
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
  const reactFlowRef = useRef(reactFlow);
  reactFlowRef.current = reactFlow;
  const [apiState, setApiState] = useState<ApiState>('loading');
  const [apiError, setApiError] = useState('');
  const [token, setToken] = useState('');
  const [view, setView] = useState<View>('home');
  const [projectQuery, setProjectQuery] = useState('');
  const [assetQuery, setAssetQuery] = useState('');
  const [assetFilter, setAssetFilter] = useState<AssetFilter>('all');
  const [assetPreview, setAssetPreview] = useState<AssetItem>();
  const [panelOpen, setPanelOpen] = useState(false);
  const [navigationPending, setNavigationPending] = useState(false);
  const [boards, setBoards] = useState<Board[]>([starterBoard()]);
  const [providers, setProviders] = useState<Provider[]>(defaultProviders);
  const [runs, setRuns] = useState<Run[]>([]);
  const [exports, setExports] = useState<ExportJob[]>([]);
  const [localAssets, setLocalAssets] = useState<LocalAsset[]>([]);
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
  const [confirmRun, setConfirmRun] = useState<RunConfirmState>();
  const [providerDraftId, setProviderDraftId] = useState('demo');
  const [providersDirty, setProvidersDirty] = useState(false);
  const [providerDiagnostics, setProviderDiagnostics] = useState<Record<string, ProviderDiagnostic>>({});
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [modelsLoading, setModelsLoading] = useState(false);
  const [providersSaving, setProvidersSaving] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [handoffIntent, setHandoffIntent] = useState<TimelineHandoffIntent>();
  const [assetSaveStates, setAssetSaveStates] = useState<Record<string, AssetSaveState>>({});
  const [conflict, setConflict] = useState<BoardConflict>();
  const [mediaImport, setMediaImport] = useState<MediaImportState>();
  const [mediaImportNotice, setMediaImportNotice] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileInputModeRef = useRef<'board' | 'media'>('board');
  const tokenRef = useRef(token);
  const activeBoardIdRef = useRef(activeBoardId);
  const selectedNodeIdRef = useRef(selectedNodeId);
  const dirtyRef = useRef(dirty);
  const boardsRef = useRef(boards);
  const localAssetsRef = useRef(localAssets);
  const editVersionRef = useRef(0);
  const saveInFlightRef = useRef<Promise<Board | undefined> | null>(null);
  const providersRef = useRef(providers);
  const providerDraftIdRef = useRef(providerDraftId);
  const providerEditVersionRef = useRef(0);
  const providerSaveInFlightRef = useRef<Promise<void> | null>(null);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const assetSaveInFlightRef = useRef<Map<string, Promise<Artifact | undefined>>>(new Map());
  const statePollInFlightRef = useRef(false);
  const conflictNoticeRef = useRef<string | undefined>(undefined);
  const autosaveTimer = useRef<number | undefined>(undefined);
  const pollTimers = useRef<Map<string, number>>(new Map());
  const pendingCreateKindRef = useRef<CanvasData['kind'] | undefined>(undefined);
  const pendingNodeIdRef = useRef<string | undefined>(undefined);
  const navigationGuardRef = useRef<Promise<boolean> | null>(null);
  const runsRef = useRef(runs);
  const timelineOpenRef = useRef(timelineOpen);
  const handoffIntentRef = useRef<TimelineHandoffIntent | undefined>(undefined);
  const handoffClaimRef = useRef<string | undefined>(undefined);
  const mediaImportRef = useRef<MediaImportState | undefined>(undefined);

  const activeBoard = useMemo(() => boards.find((board) => board.id === activeBoardId) ?? boards[0], [activeBoardId, boards]);
  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedNodeId), [nodes, selectedNodeId]);
  const latestRun = useMemo(() => runs.find((run) => run.boardId === activeBoardId && run.revision === activeBoard?.revision), [activeBoard?.revision, activeBoardId, runs]);
  const latestRunSignature = useMemo(() => latestRun ? JSON.stringify({ id: latestRun.id, status: latestRun.status, results: latestRun.results }) : '', [latestRun]);
  const activeRun = useMemo(() => runs.find((run) => run.boardId === activeBoardId && !terminalStatuses.has(run.status)), [activeBoardId, runs]);
  const projectCards = useMemo(() => deriveProjects(boards, runs), [boards, runs]);
  const filteredProjects = useMemo(() => {
    const query = projectQuery.trim().toLocaleLowerCase();
    if (!query) return projectCards;
    return projectCards.filter((project) => project.name.toLocaleLowerCase().includes(query));
  }, [projectCards, projectQuery]);
  const assets = useMemo(() => deriveAssets(boards, runs), [boards, runs]);
  const filteredAssets = useMemo(() => {
    const query = assetQuery.trim().toLocaleLowerCase();
    return assets.filter((asset) => (assetFilter === 'all' || asset.kind === assetFilter) && (!query || `${asset.boardName} ${asset.nodeId}`.toLocaleLowerCase().includes(query)));
  }, [assetFilter, assetQuery, assets]);

  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => { activeBoardIdRef.current = activeBoardId; }, [activeBoardId]);
  useEffect(() => { selectedNodeIdRef.current = selectedNodeId; }, [selectedNodeId]);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => { boardsRef.current = boards; }, [boards]);
  useEffect(() => { localAssetsRef.current = localAssets; }, [localAssets]);
  useEffect(() => { providersRef.current = providers; }, [providers]);
  useEffect(() => { providerDraftIdRef.current = providerDraftId; }, [providerDraftId]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);
  useEffect(() => { runsRef.current = runs; }, [runs]);
  useEffect(() => { timelineOpenRef.current = timelineOpen; }, [timelineOpen]);
  useEffect(() => { handoffIntentRef.current = handoffIntent; }, [handoffIntent]);
  useEffect(() => { mediaImportRef.current = mediaImport; }, [mediaImport]);

  const notify = useCallback((message: string, tone: 'info' | 'error' | 'success' = 'info') => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(undefined), 4200);
  }, []);

  const requestJson = useCallback(async <T,>(path: string, init: RequestInit = {}, requestToken = tokenRef.current): Promise<T> => {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (requestToken) headers.set('X-Canvas-Token', requestToken);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...init, headers, credentials: init.credentials ?? 'same-origin' });
    let payload: unknown;
    try { payload = await response.json(); } catch { payload = undefined; }
    if (!response.ok) {
      const details = payload && typeof payload === 'object' && 'error' in payload ? String((payload as { error: unknown }).error) : `HTTP ${response.status}`;
      const error = new Error(details.slice(0, 180)) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    return payload as T;
  }, []);

  const paintBoard = useCallback((board: Board, options: { resetSelection?: boolean; restoreViewport?: boolean } = {}) => {
    const nextNodes = boardToFlowNodes(board, localAssetsRef.current);
    const nextEdges = boardToFlowEdges(board);
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
    setNodes(nextNodes);
    setEdges(nextEdges);
    if (options.resetSelection ?? true) setSelectedNodeId(undefined);
    setPlan(undefined);
    if (options.restoreViewport ?? true) reactFlowRef.current.setViewport(board.viewport, { duration: 0 });
  }, []);

  const hydrate = useCallback(async () => {
    setApiState('loading');
    try {
      const session = await requestJson<{ token: string }>('/api/session', { headers: { 'X-Canvas-Client': 'ui' } }, '');
      if (!session.token) throw new Error('Session token missing');
      setToken(session.token);
      tokenRef.current = session.token;
      const state = await requestJson<AppState>('/api/state', {}, session.token);
      localAssetsRef.current = state.localAssets ?? [];
      setLocalAssets(state.localAssets ?? []);
      if (state.boards?.length) {
        setBoards(state.boards);
        const nextBoard = state.boards.find((board) => board.id === activeBoardIdRef.current) ?? state.boards[0];
        setActiveBoardId(nextBoard.id);
        paintBoard(nextBoard);
      }
      if (state.providers?.length) {
        providerEditVersionRef.current += 1;
        setProviders(state.providers);
      }
      setProvidersDirty(false);
      if (state.runs) setRuns(state.runs);
      if (state.exports) setExports(state.exports);
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
      if (state.exports) setExports(state.exports);
      if (state.settings) setSettings(state.settings);
      if (state.localAssets && JSON.stringify(state.localAssets) !== JSON.stringify(localAssetsRef.current)) {
        localAssetsRef.current = state.localAssets;
        setLocalAssets(state.localAssets);
        const assetsById = new Map(state.localAssets.map((asset) => [asset.id, asset]));
        setNodes((current) => current.map((node) => node.data.assetId && assetsById.has(node.data.assetId)
          ? { ...node, data: { ...node.data, previewUrl: artifactUrl(assetsById.get(node.data.assetId)?.artifact) } }
          : node));
      }
      if (state.providers && !providersDirty && JSON.stringify(state.providers) !== JSON.stringify(providersRef.current)) {
        providerEditVersionRef.current += 1;
        setProviders(state.providers);
      }
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
      if (state.providers) {
        providerEditVersionRef.current += 1;
        setProviders(state.providers);
      }
      if (state.settings) setSettings(state.settings);
      localAssetsRef.current = state.localAssets ?? [];
      setLocalAssets(state.localAssets ?? []);
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
    const pendingCreateKind = pendingCreateKindRef.current;
    pendingCreateKindRef.current = undefined;
    const pendingNodeId = pendingNodeIdRef.current;
    pendingNodeIdRef.current = undefined;
    paintBoard(activeBoard);
    if (pendingNodeId) {
      if (activeBoard.nodes.some((node) => node.id === pendingNodeId)) {
        setSelectedNodeId(pendingNodeId);
        setPanel('inspector');
      } else {
        notify('素材來源節點已不存在；已開啟專案畫布。', 'info');
      }
    }
    dirtyRef.current = Boolean(pendingCreateKind);
    setDirty(Boolean(pendingCreateKind));
    editVersionRef.current += 1;
    setConflict(undefined);
  }, [activeBoardId, notify, paintBoard]);

  useEffect(() => () => {
    if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
    for (const timer of pollTimers.current.values()) window.clearTimeout(timer);
  }, []);

  const updateBoardState = useCallback((nextNodes: FlowNode[], nextEdges: FlowEdge[], markDirty = true) => {
    nodesRef.current = nextNodes;
    edgesRef.current = nextEdges;
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

  const addRelayFlow = useCallback(() => {
    const provider = providersRef.current.find((candidate) => candidate.id === providerDraftIdRef.current);
    if (!provider || provider.protocol !== 'relay') {
      notify('請先選擇 Image + Video JSON 中轉站 provider。', 'error');
      return;
    }
    if (providersDirty || providersSaving || diagnosticsLoading || modelsLoading || runBusy || apiState !== 'ready') {
      notify('Relay flow 需要已保存且目前沒有忙碌中的 provider 或執行工作。', 'error');
      return;
    }
    const liveNodes = nodesRef.current;
    const liveEdges = edgesRef.current;
    if (liveNodes.length + 2 > 100 || liveEdges.length + 1 > 200) {
      notify('目前畫布容量不足，無法原子新增圖片與影片節點。', 'error');
      return;
    }
    const appended = buildRelayFlow(liveNodes, liveEdges, provider);
    if (!appended) {
      notify('Relay flow 設定不完整或容量已變更，未新增任何節點。', 'error');
      return;
    }
    nodesRef.current = appended.nodes;
    edgesRef.current = appended.edges;
    setNodes(appended.nodes);
    setEdges(appended.edges);
    updateBoardState(appended.nodes, appended.edges);
    setSelectedNodeId(appended.imageNodeId);
    setPanel('inspector');
    setPanelOpen(false);
    window.requestAnimationFrame(() => {
      void reactFlowRef.current.fitView({ nodes: [{ id: appended.imageNodeId }, { id: appended.videoNodeId }], padding: 0.28, duration: 260 });
    });
    notify('已新增圖→影流程；請編輯提示詞後再執行。', 'success');
  }, [apiState, diagnosticsLoading, modelsLoading, notify, providersDirty, providersSaving, reactFlowRef, runBusy, updateBoardState]);

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

  const guardNavigation = useCallback(async (action: () => void, destination: string): Promise<boolean> => {
    if (navigationGuardRef.current) return navigationGuardRef.current;
    const operation = (async () => {
      if (!dirtyRef.current) {
        action();
        return true;
      }
      setNavigationPending(true);
      const editVersionAtStart = editVersionRef.current;
      let savedBoard: Board | undefined;
      try {
        savedBoard = await saveBoard();
      } finally {
        setNavigationPending(false);
      }
      if (!savedBoard) {
        notify(`無法${destination}：畫布尚未成功保存，原畫面與編輯仍保留。`, 'error');
        return false;
      }
      if (editVersionRef.current !== editVersionAtStart || dirtyRef.current || conflict) {
        notify(`無法${destination}：保存期間有新的編輯，請先完成保存。`, 'error');
        return false;
      }
      action();
      return true;
    })();
    navigationGuardRef.current = operation;
    try {
      return await operation;
    } finally {
      if (navigationGuardRef.current === operation) navigationGuardRef.current = null;
    }
  }, [conflict, notify, saveBoard]);

  const clearHandoffIntent = useCallback((token?: string) => {
    if (token && handoffIntentRef.current?.token !== token) return;
    handoffIntentRef.current = undefined;
    setHandoffIntent(undefined);
  }, []);

  const handoffToTimeline = useCallback(async (intent: TimelineHandoffIntent): Promise<boolean> => {
    if (timelineOpenRef.current) {
      notify('時間軸已開啟；請先關閉目前的時間軸，再從 Compare 選擇來源。', 'error');
      return false;
    }
    if (navigationGuardRef.current || handoffClaimRef.current) {
      notify('目前正在保存或切換畫面，請稍候再選擇來源。', 'info');
      return false;
    }
    if (intent.originBoardId !== activeBoardIdRef.current) {
      notify('來源不屬於目前畫布，無法交接到時間軸。', 'error');
      return false;
    }
    const clickedValidation = validateTimelineHandoff(intent, activeBoardIdRef.current, runsRef.current);
    if (!clickedValidation.ok) {
      notify(`無法使用這份影片：${clickedValidation.reason}`, 'error');
      return false;
    }

    handoffClaimRef.current = intent.token;
    handoffIntentRef.current = intent;
    setHandoffIntent(intent);
    let committed = false;
    try {
      const guarded = await guardNavigation(() => {
        if (handoffClaimRef.current !== intent.token || handoffIntentRef.current?.token !== intent.token) return;
        if (timelineOpenRef.current) {
          notify('時間軸已開啟；這次來源交接已取消。', 'error');
          return;
        }
        const completedValidation = validateTimelineHandoff(intent, activeBoardIdRef.current, runsRef.current);
        if (intent.originBoardId !== activeBoardIdRef.current) {
          notify('來源不屬於目前畫布，無法交接到時間軸。', 'error');
          return;
        }
        if (!completedValidation.ok) notify(`來源在切換期間已無法使用：${completedValidation.reason}`, 'info');
        committed = true;
        setCompareOpen(false);
        setTimelineOpen(true);
      }, '開啟時間軸');
      if (!guarded || !committed) {
        clearHandoffIntent(intent.token);
        return false;
      }
      return true;
    } finally {
      if (handoffClaimRef.current === intent.token) handoffClaimRef.current = undefined;
      if (!committed) clearHandoffIntent(intent.token);
    }
  }, [clearHandoffIntent, guardNavigation, notify]);

  const openTimeline = useCallback(() => {
    if (compareOpen) {
      notify('Compare 已開啟；請先關閉 Compare，再開啟時間軸。', 'error');
      return;
    }
    setTimelineOpen(true);
  }, [compareOpen, notify]);

  const openCompare = useCallback(() => {
    if (timelineOpen) {
      notify('時間軸已開啟；請先關閉時間軸，再開啟 Compare。', 'error');
      return;
    }
    setCompareOpen(true);
  }, [notify, timelineOpen]);

  const createBoard = useCallback(async (kind?: CanvasData['kind']) => {
    if (!await guardNavigation(() => undefined, '建立新專案')) return;
    const name = window.prompt('新畫布名稱', 'Untitled direction');
    if (!name?.trim()) return;
    if (apiState !== 'ready') {
      notify('服務尚未連線，無法建立畫布。', 'error');
      return;
    }
    try {
      const created = await requestJson<Board | { board: Board }>('/api/boards', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      const board = 'board' in created ? created.board : created;
      const localBoard = kind ? { ...board, nodes: [createStarterNode(kind)] } : board;
      setBoards((current) => [...current, localBoard]);
      pendingCreateKindRef.current = kind;
      setActiveBoardId(localBoard.id);
      setView('canvas');
      setPanel('inspector');
      setPanelOpen(false);
      notify('新畫布已建立。', 'success');
    } catch (error) {
      notify(`建立畫布失敗：${errorMessage(error)}`, 'error');
    }
  }, [apiState, guardNavigation, notify, requestJson]);

  const openProject = useCallback((boardId: string, nodeId?: string) => {
    void guardNavigation(() => {
      pendingNodeIdRef.current = nodeId;
      setActiveBoardId(boardId);
      setView('canvas');
      setPanel('inspector');
      setPanelOpen(false);
      if (boardId === activeBoardIdRef.current) {
        if (nodeId && boardsRef.current.find((board) => board.id === boardId)?.nodes.some((node) => node.id === nodeId)) {
          setSelectedNodeId(nodeId);
        } else if (nodeId) {
          pendingNodeIdRef.current = undefined;
          notify('素材來源節點已不存在；已開啟專案畫布。', 'info');
        }
      }
    }, '開啟專案');
  }, [guardNavigation, notify]);

  const goHome = useCallback(() => {
    void guardNavigation(() => {
      setView('home');
      setPanelOpen(false);
      setAssetPreview(undefined);
    }, '返回首頁');
  }, [guardNavigation]);

  const openAssets = useCallback(() => {
    void guardNavigation(() => {
      setView('assets');
      setPanelOpen(false);
      setAssetPreview(undefined);
    }, '開啟素材');
  }, [guardNavigation]);

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
      const importedNodes = boardToFlowNodes(imported, localAssetsRef.current);
      const importedEdges = boardToFlowEdges(imported);
      nodesRef.current = importedNodes;
      edgesRef.current = importedEdges;
      setNodes(importedNodes);
      setEdges(importedEdges);
      editVersionRef.current += 1;
      dirtyRef.current = true;
      setDirty(true);
      notify('畫布已匯入，保存後才會同步到服務。', 'success');
    } catch (error) {
      notify(`匯入失敗：${errorMessage(error)}`, 'error');
    }
  }, [activeBoard, notify]);

  const setMediaImportState = useCallback((operationId: string, patch: Partial<MediaImportState> | undefined) => {
    setMediaImport((current) => {
      if (!current || current.operationId !== operationId) return current;
      if (!patch) return undefined;
      const next = { ...current, ...patch };
      mediaImportRef.current = next;
      return next;
    });
  }, []);

  const uploadMediaImport = useCallback(async (request: MediaImportState) => {
    const boardId = request.boardId;
    const boardAtStart = boardsRef.current.find((candidate) => candidate.id === boardId);
    if (!boardAtStart || apiState !== 'ready' || !tokenRef.current) {
      setMediaImportState(request.operationId, { status: 'failed', error: '服務尚未連線，素材已保留；請稍後重試。' });
      notify('服務尚未連線，素材已保留；請稍後重試。', 'error');
      return;
    }
    const selectedNodeAtStart = selectedNodeIdRef.current;
    const saveEditVersion = editVersionRef.current;
    setMediaImportState(request.operationId, { status: 'saving', error: undefined });
    let board = boardAtStart;
    try {
      if (dirtyRef.current) {
        const saved = await saveBoard();
        if (!saved) {
          setMediaImportState(request.operationId, { status: 'failed', error: '畫布尚未成功保存，素材已保留；請先處理保存或衝突。' });
          return;
        }
        board = saved;
        boardsRef.current = boardsRef.current.map((candidate) => candidate.id === saved.id ? saved : candidate);
      }
      const boardStillCurrent = boardsRef.current.find((candidate) => candidate.id === boardId)?.revision === board.revision;
      if (activeBoardIdRef.current !== boardId || editVersionRef.current !== saveEditVersion || !boardStillCurrent) {
        setMediaImportState(request.operationId, { status: 'failed', error: '保存期間畫布有新的編輯，素材已保留；請再次重試。' });
        notify('保存期間畫布有新的編輯，素材已保留；請再次重試。', 'error');
        return;
      }
      setMediaImportState(request.operationId, { status: 'uploading', error: undefined });
      const query = new URLSearchParams({
        expectedRevision: String(board.revision),
        operationId: request.operationId,
        kind: request.kind,
        name: request.file.name,
      });
      const result = await requestJson<ImportAssetResult>(`/api/boards/${encodeURIComponent(boardId)}/imports?${query.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': request.file.type },
        body: request.file,
      });
      const responseBoardIsCurrent = activeBoardIdRef.current === boardId
        && editVersionRef.current === saveEditVersion
        && boardsRef.current.find((candidate) => candidate.id === boardId)?.revision === board.revision;
      localAssetsRef.current = [
        ...localAssetsRef.current.filter((asset) => asset.id !== result.asset.id),
        result.asset,
      ];
      setLocalAssets(localAssetsRef.current);
      if (!responseBoardIsCurrent) {
        setMediaImportState(request.operationId, undefined);
        setMediaImportNotice('素材已匯入，但本機已有較新的編輯；已保留目前畫布，請處理遠端 revision。');
        notify('素材已匯入；本機較新的編輯仍保留，請處理遠端 revision。', 'info');
        return;
      }
      const nextBoards = boardsRef.current.map((candidate) => candidate.id === result.board.id ? result.board : candidate);
      boardsRef.current = nextBoards;
      setBoards(nextBoards);
      paintBoard(result.board, { resetSelection: false, restoreViewport: false });
      dirtyRef.current = false;
      setDirty(false);
      setConflict(undefined);
      conflictNoticeRef.current = undefined;
      if (result.nodePresent && selectedNodeIdRef.current === selectedNodeAtStart && result.board.nodes.some((node) => node.id === result.asset.nodeId)) {
        setSelectedNodeId(result.asset.nodeId);
        setPanel('inspector');
        setPanelOpen(false);
      }
      if (result.nodePresent) {
        setMediaImportNotice(`已匯入 ${result.asset.name}；來源節點已加入目前畫布。`);
        notify('素材已匯入並加入畫布。', 'success');
      } else {
        setMediaImportNotice('素材已保存，但來源節點已封存；未重新建立節點。');
        notify('素材已保存，但來源節點已封存；未重新建立節點。', 'info');
      }
      setMediaImportState(request.operationId, undefined);
    } catch (error) {
      const message = `素材匯入失敗：${errorMessage(error)}；檔案與 operation ID 已保留，可重試。`;
      setMediaImportState(request.operationId, { status: 'failed', error: message });
      notify(message, 'error');
    }
  }, [apiState, notify, paintBoard, requestJson, saveBoard, setMediaImportState]);

  const importMedia = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const kind = mediaKindForFile(file);
    const board = boardsRef.current.find((candidate) => candidate.id === activeBoardIdRef.current);
    if (!MEDIA_IMPORT_TYPES.has(file.type) || !kind) {
      notify('只支援 PNG、JPEG、WebP、MP4 或 WebM 素材。', 'error');
      return;
    }
    if (file.size > MAX_MEDIA_IMPORT_BYTES) {
      notify('素材不可超過 64 MiB。', 'error');
      return;
    }
    if (!board) {
      notify('找不到目前畫布；素材未上傳。', 'error');
      return;
    }
    const request: MediaImportState = { file, kind, operationId: makeOperationId(), status: 'saving', boardId: board.id };
    mediaImportRef.current = request;
    setMediaImport(request);
    setMediaImportNotice(undefined);
    void uploadMediaImport(request);
  }, [notify, uploadMediaImport]);

  const retryMediaImport = useCallback(() => {
    const request = mediaImportRef.current;
    if (!request || request.status === 'saving' || request.status === 'uploading') return;
    void uploadMediaImport({ ...request, status: 'saving', error: undefined });
  }, [uploadMediaImport]);

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
        const remoteImageNodes = remoteGenerations
          .map((generation) => nodesRef.current.find((candidate) => candidate.id === generation.nodeId))
          .filter((candidate): candidate is FlowNode => Boolean(candidate?.data.kind === 'image'));
        const requestedImageCount = remoteImageNodes.reduce((total, imageNode) => {
          const value = imageNode.data.params?.n;
          const count = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 1;
          return total + (Number.isInteger(count) && count >= 1 && count <= 4 ? count : 1);
        }, 0);
        const localImageReference = localImageReferenceInfo(
          nodesRef.current,
          edgesRef.current,
          remoteGenerations.map((generation) => generation.nodeId),
          localAssetsRef.current,
        );
        setConfirmRun({ nodeId, operationId, plan: nextPlan, requestedImageCount, localImageReference });
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
      return result ? { ...node, data: { ...node.data, runStatus: result.status, runError: result.error, previewUrl: artifactUrl(artifact) } } : node;
    }));
  }, [latestRunSignature]);

  const changeBoard = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const boardId = event.target.value;
    void guardNavigation(() => {
      setActiveBoardId(boardId);
      setView('canvas');
      setPanel('inspector');
      setPanelOpen(false);
    }, '切換專案');
  }, [guardNavigation]);

  const saveAsset = useCallback(async (runId: string, nodeId: string, artifactIndex: number): Promise<Artifact | undefined> => {
    const key = `${runId}:${nodeId}:${artifactIndex}`;
    const existing = assetSaveInFlightRef.current.get(key);
    if (existing) return existing;
    const localSaved = (artifact: Artifact | undefined): artifact is Artifact => Boolean(
      artifact?.localUrl && /^\/api\/media\/[a-f0-9]{64}$/.test(artifact.localUrl),
    );
    const readCurrent = () => {
      const run = runsRef.current.find((candidate) => candidate.id === runId);
      const result = run?.results[nodeId];
      return { run, result, artifact: result?.artifacts?.[artifactIndex] };
    };
    const initial = readCurrent();
    if (!initial.run || initial.run.status !== 'succeeded' || !initial.result || initial.result.status !== 'succeeded' || !initial.artifact) {
      setAssetSaveStates((current) => ({ ...current, [key]: { status: 'failed', message: '這份素材目前不是可保存的成功結果。' } }));
      return undefined;
    }
    const canonical = { kind: initial.artifact.kind, url: initial.artifact.url };
    if (localSaved(initial.artifact)) {
      setAssetSaveStates((current) => ({ ...current, [key]: { status: 'saved' } }));
      return initial.artifact;
    }
    if (apiState !== 'ready' || !tokenRef.current) {
      setAssetSaveStates((current) => ({ ...current, [key]: { status: 'failed', message: '服務尚未連線，請重試。' } }));
      notify('素材保存失敗，請確認服務連線後重試。', 'error');
      return undefined;
    }

    const operation = (async (): Promise<Artifact | undefined> => {
      setAssetSaveStates((current) => ({ ...current, [key]: { status: 'saving' } }));
      const clearStaleState = () => {
        setAssetSaveStates((current) => {
          if (!current[key] || current[key].status !== 'saving') return current;
          const next = { ...current };
          delete next[key];
          return next;
        });
      };
      const sourceStillCurrent = () => {
        const latest = readCurrent();
        return Boolean(
          latest.run?.status === 'succeeded' && latest.result?.status === 'succeeded' && latest.artifact &&
          latest.artifact.kind === canonical.kind && latest.artifact.url === canonical.url,
        );
      };
      try {
        const response = await requestJson<Artifact | { artifact: Artifact }>(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(nodeId)}/${artifactIndex}/save`, { method: 'POST', body: '{}' });
        const savedArtifact = 'artifact' in response ? response.artifact : response;
        if (
          !savedArtifact || savedArtifact.kind !== canonical.kind || savedArtifact.url !== canonical.url ||
          !localSaved(savedArtifact) || typeof savedArtifact.mimeType !== 'string'
        ) {
          throw new Error('保存回讀不符合素材識別。');
        }
        if (!sourceStillCurrent()) {
          clearStaleState();
          return undefined;
        }
        const nextRuns = runsRef.current.map((candidate) => {
          if (candidate.id !== runId) return candidate;
          const result = candidate.results[nodeId];
          if (!result) return candidate;
          return {
            ...candidate,
            results: {
              ...candidate.results,
              [nodeId]: { ...result, artifacts: result.artifacts.map((item, index) => index === artifactIndex ? savedArtifact : item) },
            },
          };
        });
        runsRef.current = nextRuns;
        setRuns(nextRuns);
        setAssetSaveStates((current) => ({ ...current, [key]: { status: 'saved' } }));
        notify('素材已保存到本機。', 'success');
        return savedArtifact;
      } catch (error) {
        if (!sourceStillCurrent()) {
          clearStaleState();
          return undefined;
        }
        const status = (error as { status?: number }).status;
        const message = status === 409 ? '來源素材已變更，請重新選擇。' : '保存失敗，請重試。';
        setAssetSaveStates((current) => ({ ...current, [key]: { status: 'failed', message } }));
        notify(message, 'error');
        return undefined;
      }
    })();
    assetSaveInFlightRef.current.set(key, operation);
    void operation.finally(() => {
      if (assetSaveInFlightRef.current.get(key) === operation) assetSaveInFlightRef.current.delete(key);
    }).catch(() => undefined);
    return operation;
  }, [apiState, notify, requestJson]);

  const updateProviderDraft = useCallback((patch: Partial<Provider>) => {
    const draftId = providerDraftIdRef.current;
    providerEditVersionRef.current += 1;
    setProviders((current) => {
      const next = current.map((provider) => provider.id === draftId ? { ...provider, ...patch } : provider);
      providersRef.current = next;
      return next;
    });
    setProviderDiagnostics((current) => {
      const next = { ...current };
      delete next[draftId];
      return next;
    });
    setProviderModels((current) => {
      const next = { ...current };
      delete next[draftId];
      return next;
    });
    setProvidersDirty(true);
  }, []);

  const addProvider = useCallback((template: ProviderTemplate = 'openai') => {
    if (providers.length >= 20) {
      notify('供應商最多 20 個。', 'error');
      return;
    }
    const id = makeId('provider');
    const envSuffix = id.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
    const templates: Record<ProviderTemplate, Omit<Provider, 'id' | 'keyEnv'>> = {
      openai: { name: 'OpenAI compatible', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', imageModel: 'gpt-image-1', videoModel: '' },
      newapi: { name: 'New API / One API', protocol: 'openai', baseUrl: '', imageModel: 'gpt-image-1', videoModel: '' },
      videos: { name: 'Videos JSON relay', protocol: 'videos', baseUrl: '', imageModel: '', videoModel: '' },
      relay: { name: 'Image + Video JSON 中轉站', protocol: 'relay', baseUrl: '', imageModel: '', videoModel: '' },
      fal: { name: 'fal.ai', protocol: 'fal', baseUrl: 'https://queue.fal.run', imageModel: 'fal-ai/flux/schnell', videoModel: 'fal-ai/kling-video/v3/standard/image-to-video' },
      replicate: { name: 'Replicate', protocol: 'replicate', baseUrl: 'https://api.replicate.com/v1', imageModel: 'black-forest-labs/flux-schnell', videoModel: 'minimax/video-01' },
    };
    const provider: Provider = {
      id,
      ...templates[template],
      keyEnv: `RELAY_KEY_${envSuffix}`.slice(0, 74),
    };
    providerEditVersionRef.current += 1;
    setProviders((current) => {
      const next = [...current, provider];
      providersRef.current = next;
      return next;
    });
    setProvidersDirty(true);
    providerDraftIdRef.current = id;
    setProviderDraftId(id);
    notify(`已新增 ${provider.name} 設定，請填入協定與環境變數名稱。`, 'info');
  }, [notify, providers.length]);

  const saveProviders = useCallback(async () => {
    if (providerSaveInFlightRef.current) return providerSaveInFlightRef.current;
    if (apiState !== 'ready') {
      notify('服務尚未連線，無法保存供應商設定。', 'error');
      return;
    }
    const snapshot = providersRef.current;
    const editVersionAtStart = providerEditVersionRef.current;
    const operation = (async () => {
      setProvidersSaving(true);
      try {
        const response = await requestJson<Provider[] | { providers: Provider[] }>('/api/providers', { method: 'PUT', body: JSON.stringify({ providers: snapshot }) });
        const savedProviders = 'providers' in response ? response.providers : response;
        if (providerEditVersionRef.current !== editVersionAtStart) {
          setProvidersDirty(true);
          notify('供應商已保存較早版本；保存期間的新編輯仍保留，請再次保存。', 'info');
          return;
        }
        providersRef.current = savedProviders;
        setProviders(savedProviders);
        setProvidersDirty(false);
        setProviderDiagnostics({});
        setProviderModels({});
        notify('供應商設定已保存。', 'success');
      } catch (error) {
        notify(`供應商設定保存失敗：${errorMessage(error)}`, 'error');
      } finally {
        setProvidersSaving(false);
      }
    })();
    providerSaveInFlightRef.current = operation;
    try {
      await operation;
    } finally {
      if (providerSaveInFlightRef.current === operation) providerSaveInFlightRef.current = null;
    }
  }, [apiState, notify, requestJson]);

  const refreshProviderDiagnostics = useCallback(async () => {
    if (providersDirty || apiState !== 'ready' || !tokenRef.current) return;
    const requestProviderId = providerDraftIdRef.current;
    const requestVersion = providerEditVersionRef.current;
    const requestProfile = JSON.stringify(providersRef.current.find((provider) => provider.id === requestProviderId));
    const requestIsCurrent = () => providerDraftIdRef.current === requestProviderId
      && providerEditVersionRef.current === requestVersion
      && JSON.stringify(providersRef.current.find((provider) => provider.id === requestProviderId)) === requestProfile;
    setDiagnosticsLoading(true);
    try {
      const response = await requestJson<ProviderDiagnostic[] | { diagnostics: ProviderDiagnostic[] }>('/api/providers/diagnostics');
      const diagnostics = 'diagnostics' in response ? response.diagnostics : response;
      if (!requestIsCurrent()) return;
      setProviderDiagnostics(Object.fromEntries(diagnostics.map((diagnostic) => [diagnostic.providerId, diagnostic])));
      notify('Provider 診斷已更新。', 'success');
    } catch {
      if (requestIsCurrent()) notify('Provider 診斷失敗，請稍後重試。', 'error');
    } finally {
      setDiagnosticsLoading(false);
    }
  }, [apiState, notify, providersDirty, requestJson]);

  const queryProviderModels = useCallback(async () => {
    const requestProviderId = providerDraftIdRef.current;
    const provider = providersRef.current.find((candidate) => candidate.id === requestProviderId);
    if (!provider || providersDirty || apiState !== 'ready' || !tokenRef.current) return;
    const requestVersion = providerEditVersionRef.current;
    const requestProfile = JSON.stringify(provider);
    const requestIsCurrent = () => providerDraftIdRef.current === requestProviderId
      && providerEditVersionRef.current === requestVersion
      && JSON.stringify(providersRef.current.find((candidate) => candidate.id === requestProviderId)) === requestProfile;
    if (provider.protocol === 'demo') {
      setProviderModels((current) => ({ ...current, [provider.id]: [provider.imageModel, provider.videoModel].filter(Boolean) }));
      notify('Demo 模型清單為固定離線清單。', 'info');
      return;
    }
    if (provider.protocol !== 'openai' && provider.protocol !== 'videos' && provider.protocol !== 'relay') {
      notify('此協定未提供安全模型查詢，請手動輸入模型。', 'info');
      return;
    }
    const diagnostic = providerDiagnostics[provider.id];
    if (!settings.remoteEnabled || !diagnostic?.configurationValid || !diagnostic.remoteEnabled || !diagnostic.credentialConfigured) {
      notify('模型查詢需要已保存且 ready 的遠端 provider。', 'error');
      return;
    }
    setModelsLoading(true);
    try {
      const response = await requestJson<ProviderModels>(`/api/providers/${encodeURIComponent(provider.id)}/models`);
      if (!requestIsCurrent()) return;
      setProviderModels((current) => ({ ...current, [provider.id]: response.models }));
      notify(`已取得 ${response.models.length} 個模型。`, 'success');
    } catch {
      if (requestIsCurrent()) notify('模型查詢失敗，請確認 provider 設定。', 'error');
    } finally {
      setModelsLoading(false);
    }
  }, [apiState, notify, providerDiagnostics, providersDirty, requestJson, settings.remoteEnabled]);

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

  const toastView = toast ? <ToastView toast={toast} onClose={() => setToast(undefined)} /> : null;

  if (view === 'home') {
    return <HomePage
      cards={filteredProjects}
      query={projectQuery}
      apiState={apiState}
      apiError={apiError}
      navigationPending={navigationPending}
      onQueryChange={setProjectQuery}
      onCreate={() => void createBoard()}
      onCreateImage={() => void createBoard('image')}
      onCreateVideo={() => void createBoard('video')}
      onOpenProject={openProject}
      onOpenAssets={openAssets}
      onOpenCodex={() => { setView('canvas'); setPanel('help'); setPanelOpen(true); }}
    >{toastView}</HomePage>;
  }

  if (view === 'assets') {
    return <AssetsPage
      assets={filteredAssets}
      totalCount={assets.length}
      query={assetQuery}
      filter={assetFilter}
      navigationPending={navigationPending}
      onQueryChange={setAssetQuery}
      onFilterChange={setAssetFilter}
      onBack={goHome}
      onOpenBoard={(boardId, nodeId) => openProject(boardId, nodeId)}
      preview={assetPreview ? assets.find((asset) => asset.id === assetPreview.id) ?? assetPreview : undefined}
      onPreview={setAssetPreview}
      onClosePreview={() => setAssetPreview(undefined)}
      onCreate={() => void createBoard()}
      assetSaveStates={assetSaveStates}
      onSaveAsset={saveAsset}
    >{toastView}</AssetsPage>;
  }

  return (
    <div className="app-shell app-canvas">
      <header className="topbar canvas-topbar">
        <button className="topbar-back" aria-label="back-home" onClick={goHome} disabled={navigationPending}><ArrowLeft size={15} />Projects</button>
        <div className="brand-lockup">
          <div className="brand-mark"><span /></div>
          <div>
            <div className="brand-name">Relay Canvas</div>
            <div className="brand-kicker">IDEAS, CONNECTED.</div>
          </div>
          <span className="version-tag">v0.7.0</span>
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
          <button className="ghost-button" onClick={() => { setPanel('help'); setPanelOpen(true); }}><CircleHelp size={15} />MCP help</button>
          <button className="primary-button" aria-label="save" onClick={() => void saveBoard()} disabled={saving || !dirty || navigationPending}>
            {saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} {saving ? '保存中' : '保存'}
          </button>
        </div>
      </header>

      <div className="workspace canvas-workspace">
        <aside className="left-rail canvas-rail">
          <div className="rail-navigation">
            <button className="rail-nav-button" aria-label="home-nav" onClick={goHome} disabled={navigationPending}><Home size={15} /><span>Projects</span></button>
            <button className="rail-nav-button" aria-label="assets-nav" onClick={openAssets} disabled={navigationPending}><LayoutGrid size={15} /><span>Assets</span></button>
          </div>
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
            <button className={`rail-tool ${panel === 'history' && panelOpen ? 'is-active' : ''}`} onClick={() => { setPanel('history'); setPanelOpen(true); }}><span className="rail-tool-icon"><Clock3 size={17} /></span><span>History</span></button>
            <button className={`rail-tool ${panel === 'providers' && panelOpen ? 'is-active' : ''}`} aria-label="provider-settings" onClick={() => { setPanel('providers'); setPanelOpen(true); }}><span className="rail-tool-icon"><Settings2 size={17} /></span><span>Providers</span></button>
            <button className={`rail-tool ${panel === 'help' && panelOpen ? 'is-active' : ''}`} onClick={() => { setPanel('help'); setPanelOpen(true); }}><span className="rail-tool-icon"><CircleHelp size={17} /></span><span>Guide</span></button>
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
              <button className="toolbar-button" data-testid="timeline-open" onClick={openTimeline}><Scissors size={14} />Timeline</button>
              <button className="toolbar-button" data-testid="compare-open" onClick={openCompare}><GitCompareArrows size={14} />Compare</button>
              <button className="toolbar-button" aria-label="export-board" onClick={exportBoard}><Download size={14} />Export</button>
              <button className="toolbar-button" aria-label="import-board" onClick={() => { fileInputModeRef.current = 'board'; if (fileInputRef.current) { fileInputRef.current.accept = BOARD_IMPORT_ACCEPT; fileInputRef.current.click(); } }}><Upload size={14} />Import</button>
              <button className="toolbar-button media-import-button" data-testid="import-media" aria-label="import-media" onClick={() => { fileInputModeRef.current = 'media'; if (fileInputRef.current) { fileInputRef.current.accept = MEDIA_IMPORT_ACCEPT; fileInputRef.current.click(); } }} disabled={Boolean(mediaImport && (mediaImport.status === 'saving' || mediaImport.status === 'uploading')) || navigationPending}><ImagePlus size={14} />Import media</button>
              <input ref={fileInputRef} id="import-media-input" data-testid="import-media-input" aria-label="import-media-input" type="file" accept={MEDIA_IMPORT_ACCEPT} onChange={(event) => { const mode = fileInputModeRef.current; const file = event.currentTarget.files?.[0]; const isBoardFile = file?.type === 'application/json' || file?.name.toLocaleLowerCase().endsWith('.json'); if (mode === 'media' || !isBoardFile) void importMedia(event); else void importBoard(event); fileInputModeRef.current = 'board'; event.currentTarget.accept = BOARD_IMPORT_ACCEPT; }} hidden />
            </div>
          </div>
          {mediaImport && <div className={`media-import-status is-${mediaImport.status}`} role={mediaImport.status === 'failed' ? 'alert' : 'status'}><div><strong>{mediaImport.status === 'saving' ? '正在保存畫布' : mediaImport.status === 'uploading' ? '正在匯入素材' : '素材匯入失敗'}</strong><span>{mediaImport.file.name} · {formatBytes(mediaImport.file.size)} · {mediaImport.kind.toUpperCase()}</span>{mediaImport.error && <small>{mediaImport.error}</small>}</div>{mediaImport.status === 'failed' && <button className="secondary-button" data-testid="import-media-retry" aria-label="import-media-retry" onClick={retryMediaImport}><RefreshCw size={13} />重試</button>}</div>}
          {mediaImportNotice && <div className="media-import-notice" role="status"><Info size={14} />{mediaImportNotice}<button aria-label="dismiss-import-media-notice" onClick={() => setMediaImportNotice(undefined)}><X size={13} /></button></div>}
          {conflict && <div className="conflict-banner" role="alert"><AlertCircle size={15} /><div><strong>畫布有新的遠端 revision</strong><span>本機 rev {conflict.localRevision} · server rev {conflict.remoteRevision}；你的編輯仍保留。</span></div><button className="conflict-reload" aria-label="reload-board" onClick={() => void reloadCurrentBoard()}><RefreshCw size={13} />載入最新版本</button></div>}
          <div className="canvas-wrap">
            <ReactFlow<FlowNode, FlowEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, node) => { setSelectedNodeId(node.id); setPanel('inspector'); setPanelOpen(false); }}
              onPaneClick={() => setSelectedNodeId(undefined)}
              deleteKeyCode={timelineOpen || compareOpen ? null : ['Backspace', 'Delete']}
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
          {selectedNode && !panelOpen && panel === 'inspector' && <div className={`floating-composer${selectedNode.data.previewUrl || selectedNode.data.assetUrl ? ' has-media-preview' : ''}`} aria-label="floating-composer"><button className="floating-composer-close" aria-label="close-floating-composer" onClick={() => setSelectedNodeId(undefined)}><X size={14} /></button><InspectorPanel node={selectedNode} providers={providers} localAssets={localAssets} selectedResult={selectedResult} runId={latestRun?.id} assetSaveStates={assetSaveStates} onSaveAsset={saveAsset} onChange={updateSelectedNode} onDelete={deleteSelectedNode} onOpenProviders={() => { const id = selectedNode.data.providerId ?? 'demo'; providerDraftIdRef.current = id; setProviderDraftId(id); setPanel('providers'); setPanelOpen(true); }} /></div>}
          {plan && <div className={`validation-toast ${plan.errors.length ? 'has-errors' : ''}`}><span>{plan.errors.length ? <AlertCircle size={14} /> : <Check size={14} />}</span><div><strong>{plan.errors.length ? 'Validation needs attention' : 'Ready to run'}</strong><small>{plan.errors.length ? plan.errors[0] : `${plan.order.length} node${plan.order.length === 1 ? '' : 's'} in execution order`}</small></div><button aria-label="close-validation" onClick={() => setPlan(undefined)}><X size={14} /></button></div>}
        </main>

        {panelOpen && <aside className={`right-panel ${panel === 'inspector' ? '' : 'panel-mode'}`}>
          <div className="panel-drawer-head"><span>Canvas tools</span><button className="icon-button" aria-label="close-panel" onClick={() => setPanelOpen(false)}><X size={15} /></button></div>
          <div className="panel-tabs">
            <button className={panel === 'inspector' ? 'is-active' : ''} onClick={() => setPanel('inspector')}><PanelRight size={15} />Inspector</button>
            <button className={panel === 'history' ? 'is-active' : ''} onClick={() => setPanel('history')}><Clock3 size={15} />History{runs.length > 0 && <span className="tab-count">{runs.length}</span>}</button>
          </div>
          {panel === 'inspector' && <InspectorPanel node={selectedNode} providers={providers} localAssets={localAssets} selectedResult={selectedResult} runId={latestRun?.id} assetSaveStates={assetSaveStates} onSaveAsset={saveAsset} onChange={updateSelectedNode} onDelete={deleteSelectedNode} onOpenProviders={() => { const id = selectedNode?.data.providerId ?? 'demo'; providerDraftIdRef.current = id; setProviderDraftId(id); setPanel('providers'); setPanelOpen(true); }} />}
          {panel === 'history' && <HistoryPanel runs={runs.filter((run) => run.boardId === activeBoardId)} activeRunId={activeRun?.id} currentRevision={activeBoard?.revision} onSelect={(run) => { if (run.revision !== activeBoard?.revision) { notify('這筆執行來自較舊 revision，保留在 history，不覆蓋目前畫布。', 'info'); return; } setNodes((current) => current.map((node) => { const result = run.results[node.id]; const artifact = assetForResult(result); return result ? { ...node, data: { ...node.data, runStatus: result.status, runError: result.error, previewUrl: artifactUrl(artifact) } } : node; })); }} />}
          {panel === 'providers' && <ProvidersPanel providers={providers} selectedId={providerDraftId} settings={settings} apiReady={apiState === 'ready'} dirty={providersDirty} saving={providersSaving} diagnostics={providerDiagnostics} diagnosticsLoading={diagnosticsLoading} models={providerModels[providerDraftId] ?? []} modelsLoading={modelsLoading} relayFlowBusy={providersSaving || diagnosticsLoading || modelsLoading || runBusy} relayFlowCapacity={nodes.length + 2 <= 100 && edges.length + 1 <= 200} onDiagnostics={() => void refreshProviderDiagnostics()} onQueryModels={() => void queryProviderModels()} onSelect={(id) => { providerDraftIdRef.current = id; setProviderDraftId(id); }} onChange={updateProviderDraft} onAdd={addProvider} onAddRelayFlow={addRelayFlow} onSave={() => void saveProviders()} />}
          {panel === 'help' && <HelpPanel />}
        </aside>}
      </div>

      <footer className="statusbar">
        <div className="statusbar-left"><span className="statusbar-item"><LockKeyhole size={12} /> Your workspace stays local</span><span className="statusbar-divider" /><span className="statusbar-item"><Code2 size={12} /> Adapter contract tested · live unverified</span></div>
        <div className="statusbar-right"><span className="statusbar-item"><Activity size={12} /> {activeRun ? `Run ${statusLabel(activeRun.status)}` : 'Ready'}</span><span className="statusbar-item rev-chip">REV {activeBoard?.revision ?? 0}</span></div>
      </footer>

      {toast && <div className={`toast toast-${toast.tone}`} role="status"><span className="toast-icon">{toast.tone === 'success' ? <Check size={15} /> : toast.tone === 'error' ? <AlertCircle size={15} /> : <Info size={15} />}</span>{toast.message}<button onClick={() => setToast(undefined)} aria-label="close-message"><X size={14} /></button></div>}

      {timelineOpen && activeBoard && <TimelineEditor board={activeBoard} runs={runs} exports={exports} requestJson={requestJson as UiRequest} onSaveArtifact={saveAsset as SaveArtifact} onExportJob={(job) => setExports((current) => [job, ...current.filter((candidate) => candidate.id !== job.id)])} handoffIntent={handoffIntent} onHandoffConsumed={clearHandoffIntent} onClose={() => { setTimelineOpen(false); clearHandoffIntent(); }} />}
      {compareOpen && activeBoard && <RunCompare boardId={activeBoard.id} runs={runs} requestJson={requestJson as UiRequest} assetSaveStates={assetSaveStates} onSaveAsset={saveAsset} onUseInTimeline={handoffToTimeline} onClose={() => { setCompareOpen(false); clearHandoffIntent(); }} />}
      {confirmRun && <RunConfirmDialog confirm={confirmRun} providers={providers} onCancel={() => setConfirmRun(undefined)} onConfirm={() => void startRun(confirmRun.nodeId, true, confirmRun.operationId)} />}
    </div>
  );
}

function ToastView({ toast, onClose }: { toast: { tone: 'info' | 'error' | 'success'; message: string }; onClose: () => void }) {
  return <div className={`toast toast-${toast.tone}`} role="status"><span className="toast-icon">{toast.tone === 'success' ? <Check size={15} /> : toast.tone === 'error' ? <AlertCircle size={15} /> : <Info size={15} />}</span>{toast.message}<button onClick={onClose} aria-label="close-message"><X size={14} /></button></div>;
}

function HomePage({ cards, query, apiState, apiError, navigationPending, onQueryChange, onCreate, onCreateImage, onCreateVideo, onOpenProject, onOpenAssets, onOpenCodex, children }: {
  cards: ProjectCard[];
  query: string;
  apiState: ApiState;
  apiError: string;
  navigationPending: boolean;
  onQueryChange: (value: string) => void;
  onCreate: () => void;
  onCreateImage: () => void;
  onCreateVideo: () => void;
  onOpenProject: (boardId: string) => void;
  onOpenAssets: () => void;
  onOpenCodex: () => void;
  children?: ReactNode;
}) {
  return <div className="home-layout">
    <aside className="home-sidebar">
      <div className="home-brand"><div className="brand-mark"><span /></div><div><strong>Relay Canvas</strong><small>CREATOR WORKSPACE</small></div></div>
      <nav className="home-nav" aria-label="主導覽">
        <button className="home-nav-item is-active" aria-label="home-nav" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}><Home size={16} />首頁</button>
        <button className="home-nav-item" onClick={() => document.getElementById('projects-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}><FolderPlus size={16} />專案</button>
        <button className="home-nav-item" aria-label="assets-nav" onClick={onOpenAssets} disabled={navigationPending}><LayoutGrid size={16} />素材</button>
        <button className="home-nav-item" onClick={onOpenCodex}><Code2 size={16} />Codex MCP</button>
      </nav>
      <div className="home-sidebar-rule" />
      <div className="home-sidebar-label">CREATE</div>
      <button className="home-create-link" aria-label="create-image" onClick={onCreateImage} disabled={navigationPending}><span className="home-create-icon"><ImagePlus size={16} /></span><span><strong>圖片創作</strong><small>Image direction</small></span></button>
      <button className="home-create-link" aria-label="create-video" onClick={onCreateVideo} disabled={navigationPending}><span className="home-create-icon video"><Video size={16} /></span><span><strong>影片創作</strong><small>Motion study</small></span></button>
      <div className="home-sidebar-bottom"><span className="demo-chip">DEMO</span><span>v0.3.0</span><span className={`home-api-state ${apiState}`}><i />{apiState === 'ready' ? 'Local API' : apiState === 'loading' ? 'Connecting' : 'Offline'}</span></div>
    </aside>
    <main className="home-main">
      <header className="home-header"><div><span className="home-eyebrow">PROJECTS / LOCAL WORKSPACE</span><h1>把想法變成畫面。</h1><p>從一個方向開始，讓素材沿著畫布流動。</p></div><div className="home-header-actions"><span className="preview-tag">v0.3.0</span><button className="home-codex-button" onClick={onOpenCodex}><Code2 size={15} />Codex help</button></div></header>
      <section className="new-project-zone"><button className="new-project-card" aria-label="new-project" onClick={onCreate} disabled={navigationPending}><span className="new-project-plus"><Plus size={28} strokeWidth={1.5} /></span><strong>新建專案</strong><small>Start a new creative canvas</small></button></section>
      <section className="quick-create"><div className="section-heading"><div><span className="home-eyebrow">QUICK START</span><h2>選一個入口</h2></div><span className="section-note">Local-first · API connected</span></div><div className="quick-create-grid"><button onClick={onCreateImage} aria-label="create-image" disabled={navigationPending}><span className="quick-icon image"><ImageIcon size={19} /></span><span><strong>圖片創作</strong><small>Build a still frame</small></span><ArrowRight size={15} /></button><button onClick={onCreateVideo} aria-label="create-video" disabled={navigationPending}><span className="quick-icon video"><Film size={19} /></span><span><strong>影片創作</strong><small>Turn a frame into motion</small></span><ArrowRight size={15} /></button></div></section>
      <section id="projects-section" className="projects-section"><div className="section-heading projects-heading"><div><span className="home-eyebrow">YOUR WORK</span><h2>專案</h2></div><label className="project-search"><Search size={15} /><input aria-label="project-search" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜尋專案" /></label></div>{apiState === 'offline' && <div className="home-api-notice"><AlertCircle size={14} />{apiError || '服務離線；目前可查看 Demo 畫布。'}</div>}{cards.length === 0 ? <div className="empty-projects"><FolderPlus size={22} /><h3>還沒有符合的專案</h3><p>換一個搜尋字詞，或建立新的創作畫布。</p><button className="light-button" onClick={onCreate} disabled={navigationPending}><Plus size={14} />新建專案</button></div> : <div className="project-grid">{cards.map((card, index) => <ProjectCardView key={card.boardId} card={card} index={index} onOpen={() => onOpenProject(card.boardId)} />)}</div>}</section>
      <footer className="home-footer"><span>Relay Canvas</span><span>Local runtime · protocol tested · live unverified</span></footer>
    </main>
    {children}
  </div>;
}

function ProjectCardView({ card, index, onOpen }: { card: ProjectCard; index: number; onOpen: () => void }) {
  const thumbnail = card.thumbnail;
  return <button className="project-card" data-testid={card.boardId === 'welcome' ? 'project-card-welcome' : undefined} aria-label={card.boardId === 'welcome' ? 'project-card-welcome' : `project-card-${card.boardId}`} onClick={onOpen}><div className={`project-card-media ${thumbnail ? 'has-thumb' : 'is-empty'}`}>{thumbnail?.kind === 'image' && <img src={artifactUrl(thumbnail)} alt="" referrerPolicy="no-referrer" crossOrigin="anonymous" />}{thumbnail?.kind === 'video' && <VideoThumbnail src={artifactUrl(thumbnail) ?? thumbnail.url} alt="影片縮圖" />}{!thumbnail && <><span className="empty-canvas-mark"><LayoutGrid size={24} /></span><span>EMPTY CANVAS</span></>}</div><div className="project-card-body"><div><strong>{card.name}</strong><small>{card.thumbnailRunAt ? `上次生成 · ${new Date(card.thumbnailRunAt).toLocaleDateString('zh-TW')}` : card.latestRunAt ? `最近執行 · ${new Date(card.latestRunAt).toLocaleDateString('zh-TW')}` : `${card.nodeCount} nodes · ready to shape`}</small></div><span className="project-card-index">{String(index + 1).padStart(2, '0')}</span></div><div className="project-card-meta"><span>{card.nodeCount} nodes</span><span>{card.edgeCount} links</span><span className="project-open-label">開啟 <ArrowRight size={13} /></span></div></button>;
}

function AssetsPage({ assets, totalCount, query, filter, navigationPending, onQueryChange, onFilterChange, onBack, onOpenBoard, preview, onPreview, onClosePreview, onCreate, assetSaveStates, onSaveAsset, children }: {
  assets: AssetItem[];
  totalCount: number;
  query: string;
  filter: AssetFilter;
  navigationPending: boolean;
  onQueryChange: (value: string) => void;
  onFilterChange: (value: AssetFilter) => void;
  onBack: () => void;
  onOpenBoard: (boardId: string, nodeId?: string) => void;
  preview?: AssetItem;
  onPreview: (asset: AssetItem) => void;
  onClosePreview: () => void;
  onCreate: () => void;
  assetSaveStates: Record<string, AssetSaveState>;
  onSaveAsset: (runId: string, nodeId: string, artifactIndex: number) => void;
  children?: ReactNode;
}) {
  return <div className="assets-layout"><header className="assets-header"><button className="topbar-back" aria-label="back-home" onClick={onBack} disabled={navigationPending}><ArrowLeft size={15} />Projects</button><div className="assets-brand"><div className="brand-mark"><span /></div><strong>Relay Canvas</strong><span className="preview-tag">v0.3.0</span></div><div className="assets-header-note">REAL OUTPUTS / LOCAL CATALOG</div></header><main className="assets-main"><div className="assets-heading"><div><span className="home-eyebrow">MEDIA LIBRARY</span><h1>素材</h1><p>只顯示已完成執行產生的真實圖片與影片。</p></div><div className="assets-actions"><label className="project-search"><Search size={15} /><input aria-label="asset-search" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜尋素材" /></label><button className="light-button" aria-label="new-project" onClick={onCreate} disabled={navigationPending}><Plus size={14} />新建專案</button></div></div><div className="asset-toolbar"><div className="asset-filters"><button className={filter === 'all' ? 'is-active' : ''} onClick={() => onFilterChange('all')}>全部 <span>{totalCount}</span></button><button className={filter === 'image' ? 'is-active' : ''} aria-label="gallery-filter-image" onClick={() => onFilterChange('image')}>圖片</button><button className={filter === 'video' ? 'is-active' : ''} aria-label="gallery-filter-video" onClick={() => onFilterChange('video')}>影片</button></div><span className="asset-count">{assets.length.toString().padStart(2, '0')} shown / {totalCount.toString().padStart(2, '0')} total</span></div>{assets.length === 0 ? <div className="empty-assets"><div className="empty-assets-icon"><LayoutGrid size={22} /></div><h2>尚無生成素材</h2><p>完成一次 Demo 或已確認的遠端執行後，成果會出現在這裡。</p><button className="light-button" onClick={onCreate} disabled={navigationPending}><Plus size={14} />建立第一個專案</button></div> : <div className="asset-grid">{assets.map((asset) => <AssetCard key={asset.id} asset={asset} saveState={assetSaveStates[asset.id]} onSave={() => onSaveAsset(asset.runId, asset.nodeId, asset.artifactIndex)} onPreview={() => onPreview(asset)} onOpenBoard={() => onOpenBoard(asset.boardId, asset.nodeId)} />)}</div>}</main>{preview && <AssetPreview asset={preview} saveState={assetSaveStates[preview.id]} onSave={() => onSaveAsset(preview.runId, preview.nodeId, preview.artifactIndex)} onClose={onClosePreview} onOpenBoard={() => { onClosePreview(); onOpenBoard(preview.boardId, preview.nodeId); }} />}{children}</div>;
}

function assetDownloadName(asset: AssetItem): string {
  const extension = asset.kind === 'video' ? (asset.artifact.mimeType === 'video/webm' ? 'webm' : 'mp4') : (asset.artifact.mimeType === 'image/jpeg' ? 'jpg' : asset.artifact.mimeType === 'image/webp' ? 'webp' : 'png');
  return `relay-${asset.kind}-${asset.artifactIndex}.${extension}`;
}

function assetSaveLabel(asset: AssetItem, saveState?: AssetSaveState): string {
  if (saveState?.status === 'saving') return '保存中';
  if (saveState?.status === 'failed') return '重試保存';
  if (saveState?.status === 'saved' || asset.artifact.localUrl || asset.artifact.localId) return '已保存本機';
  return '保存本機';
}

function AssetCard({ asset, saveState, onSave, onPreview, onOpenBoard }: { asset: AssetItem; saveState?: AssetSaveState; onSave: () => void; onPreview: () => void; onOpenBoard: () => void }) {
  const saved = saveState?.status === 'saved' || Boolean(asset.artifact.localUrl || asset.artifact.localId);
  return <article className="asset-card"><button className="asset-preview-button" aria-label={`gallery-item-${asset.id}`} onClick={onPreview}>{asset.kind === 'image' ? <img src={asset.url} alt={asset.nodeId} referrerPolicy="no-referrer" crossOrigin="anonymous" /> : <VideoThumbnail src={asset.url} alt={asset.nodeId} />}<span className="asset-kind-badge">{asset.artifact.demo ? 'DEMO' : asset.kind.toUpperCase()}</span><span className="asset-hover-icon"><Maximize2 size={15} /></span></button><div className="asset-card-info"><div><strong>{asset.boardName}</strong><small>{asset.nodeId} · {new Date(asset.startedAt).toLocaleDateString('zh-TW')}</small><span className={`asset-local-status ${saveState?.status === 'failed' ? 'is-failed' : saved ? 'is-saved' : ''}`}>{saveState?.status === 'failed' ? saveState.message ?? '保存失敗' : saved ? '已保存本機' : '僅遠端引用'}</span></div><button className="asset-open-board" aria-label={`open-board-${asset.boardId}`} onClick={onOpenBoard}>開啟畫布 <ArrowRight size={13} /></button></div><div className="asset-card-actions"><button className="asset-save-button" aria-label={`save-asset-${asset.id}`} disabled={saved || saveState?.status === 'saving'} onClick={onSave}>{saveState?.status === 'saving' ? <LoaderCircle className="spin" size={13} /> : saveState?.status === 'failed' ? <RefreshCw size={13} /> : <Save size={13} />}{assetSaveLabel(asset, saveState)}</button>{saved && <a className="asset-download-button" aria-label={`download-asset-${asset.id}`} href={asset.url} download={assetDownloadName(asset)}><Download size={13} />下載</a>}</div></article>;
}

function AssetPreview({ asset, saveState, onSave, onClose, onOpenBoard }: { asset: AssetItem; saveState?: AssetSaveState; onSave: () => void; onClose: () => void; onOpenBoard: () => void }) {
  const saved = saveState?.status === 'saved' || Boolean(asset.artifact.localUrl || asset.artifact.localId);
  return <div className="asset-preview-scrim" role="presentation" onClick={onClose}><div className="asset-preview-dialog" role="dialog" aria-modal="true" aria-label="asset-preview" onClick={(event) => event.stopPropagation()}><button className="asset-preview-close" aria-label="close-asset-preview" onClick={onClose}><X size={16} /></button><div className="asset-preview-media">{asset.kind === 'image' ? <img src={asset.url} alt={asset.nodeId} referrerPolicy="no-referrer" crossOrigin="anonymous" /> : <video src={asset.url} controls autoPlay muted playsInline crossOrigin="anonymous" />}</div><div className="asset-preview-caption"><div><span className="home-eyebrow">{asset.artifact.demo ? 'DEMO OUTPUT' : 'OUTPUT'}</span><h2>{asset.boardName}</h2><p>{asset.nodeId} · {new Date(asset.startedAt).toLocaleString('zh-TW')}</p><span className={`asset-local-status ${saveState?.status === 'failed' ? 'is-failed' : saved ? 'is-saved' : ''}`}>{saveState?.status === 'failed' ? saveState.message ?? '保存失敗' : saved ? '已保存本機' : '僅遠端引用'}</span></div><div className="asset-preview-actions"><button className="asset-save-button" aria-label={`save-asset-${asset.id}`} disabled={saved || saveState?.status === 'saving'} onClick={onSave}>{saveState?.status === 'saving' ? <LoaderCircle className="spin" size={13} /> : saveState?.status === 'failed' ? <RefreshCw size={13} /> : <Save size={13} />}{assetSaveLabel(asset, saveState)}</button>{saved && <a className="asset-download-button" aria-label={`download-asset-${asset.id}`} href={asset.url} download={assetDownloadName(asset)}><Download size={13} />下載</a>}<button className="light-button" onClick={onOpenBoard}>開啟專案 <ArrowRight size={14} /></button></div></div></div></div>;
}

function InspectorPanel({ node, providers, localAssets, selectedResult, runId, assetSaveStates, onSaveAsset, onChange, onDelete, onOpenProviders }: { node?: FlowNode; providers: Provider[]; localAssets: LocalAsset[]; selectedResult?: NodeResult; runId?: string; assetSaveStates: Record<string, AssetSaveState>; onSaveAsset: (runId: string, nodeId: string, artifactIndex: number) => void; onChange: (patch: Partial<CanvasData>) => void; onDelete: () => void; onOpenProviders: () => void }) {
  if (!node) {
    return <div className="empty-panel"><div className="empty-icon"><Maximize2 size={20} /></div><h2>Select a node</h2><p>從畫布選一個節點，開始編輯提示詞、模型與輸出設定。</p><div className="empty-hint"><Link2 size={14} />拖曳節點右側連接點建立資料流</div></div>;
  }
  const meta = nodeKindMeta[node.data.kind];
  const Icon = meta.icon;
  const provider = providers.find((candidate) => candidate.id === node.data.providerId);
  const isGenerator = node.data.kind === 'image' || node.data.kind === 'video';
  const localAsset = node.data.assetId ? localAssets.find((asset) => asset.id === node.data.assetId) : undefined;
  const handleProviderChange = (providerId: string) => {
    const nextProvider = providers.find((candidate) => candidate.id === providerId);
    const model = node.data.kind === 'video' ? nextProvider?.videoModel : nextProvider?.imageModel;
    onChange({
      providerId,
      model,
      ...(node.data.kind === 'video' ? { referenceField: recommendedReferenceField(model ?? '') } : {}),
      ...((nextProvider?.protocol === 'videos' || nextProvider?.protocol === 'relay') ? { params: {} } : {}),
    });
  };
  const handleModelChange = (model: string) => {
    onChange(node.data.kind === 'video' ? { model, referenceField: provider?.protocol === 'relay' ? 'image_url' : recommendedReferenceField(model) } : { model });
  };
  return (
    <div className="inspector-content">
      <div className="panel-heading"><div><span className="panel-eyebrow">NODE INSPECTOR</span><h2>{meta.label} settings</h2></div><button className="icon-button" onClick={onDelete} aria-label="delete-node" title="刪除節點"><Trash2 size={15} /></button></div>
      <div className="node-identity"><span className="identity-icon" style={{ color: meta.color }}><Icon size={17} /></span><div><strong>{node.data.label}</strong><span>{node.id}</span></div><span className={`identity-status ${statusClass(selectedResult?.status ?? node.data.runStatus)}`}>{statusLabel(selectedResult?.status ?? node.data.runStatus)}</span></div>
      <Field label="Label"><input value={node.data.label} onChange={(event) => onChange({ label: event.target.value })} /></Field>
      {(node.data.kind === 'prompt' || node.data.kind === 'note' || isGenerator) && <Field label={node.data.kind === 'note' ? 'Direction' : 'Prompt'} hint={node.data.kind === 'prompt' ? '上游文字會在執行時接到下游提示詞前。' : undefined}><textarea aria-label="prompt-editor" value={node.data.prompt ?? ''} onChange={(event) => onChange({ prompt: event.target.value })} rows={node.data.kind === 'note' ? 8 : 7} placeholder="寫下畫面、動作或方向…" /></Field>}
      {node.data.kind === 'asset' && (node.data.assetId ? <LocalAssetSource node={node} asset={localAsset} /> : <><Field label="Asset URL" hint="使用受允許的 media origin；瀏覽器不會帶 cookies。"><input value={node.data.assetUrl ?? ''} onChange={(event) => onChange({ assetUrl: event.target.value })} placeholder="https://…" /></Field><Field label="Asset kind"><select value={node.data.assetKind ?? 'image'} onChange={(event) => onChange({ assetKind: event.target.value as 'image' | 'video' })}><option value="image">Image</option><option value="video">Video</option></select></Field></>)}
      {isGenerator && <>
        <div className="section-divider"><span>GENERATION</span></div>
        <Field label="Provider"><div className="select-with-action"><select value={node.data.providerId ?? 'demo'} onChange={(event) => handleProviderChange(event.target.value)}><option value="">Select provider</option>{providers.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}{candidate.protocol === 'demo' ? ' · DEMO' : ''}</option>)}</select><button className="mini-icon-button" onClick={onOpenProviders} aria-label="provider-settings" title="編輯供應商"><Settings2 size={14} /></button></div></Field>
        <Field label="Model" hint={provider?.protocol === 'demo' ? '離線 Demo，不消耗 AI 額度。' : provider?.protocol === 'videos' ? 'Videos JSON relay contract；不預填官方 Sora，請手動輸入模型。' : provider?.protocol === 'relay' ? 'Relay 宣告 image + video；固定路徑 contract，尚未 live 驗證。' : '自訂模型／協定驗證，未做 live 驗證。'}><input aria-label="node-model" value={node.data.model ?? ''} onChange={(event) => handleModelChange(event.target.value)} placeholder={provider?.protocol === 'videos' || provider?.protocol === 'relay' ? 'relay model' : 'model-name'} /></Field>
        {node.data.kind === 'video' && <Field label="Reference field" hint={provider?.protocol === 'relay' ? 'Relay video 固定送出 input_reference.image_url。' : undefined}><input value={node.data.referenceField ?? 'image_url'} readOnly={provider?.protocol === 'relay'} onChange={(event) => onChange({ referenceField: event.target.value })} /></Field>}
        <div className="params-box"><div className="params-heading"><span>PARAMETERS</span><SlidersHorizontal size={13} /></div>{(provider?.protocol === 'videos' || provider?.protocol === 'relay') && node.data.kind === 'video' ? <VideoParams params={node.data.params} onChange={(params) => onChange({ params })} /> : <>{node.data.kind === 'image' && (provider?.protocol === 'openai' || provider?.protocol === 'relay') && <ImageParams params={node.data.params} onChange={(params) => onChange({ params })} />}<div className="params-grid"><ParamField label="Aspect" value={String(node.data.params?.aspect_ratio ?? '16:9')} onChange={(value) => onChange({ params: { ...(node.data.params ?? {}), aspect_ratio: value } })} /><ParamField label="Quality" value={String(node.data.params?.quality ?? 'standard')} onChange={(value) => onChange({ params: { ...(node.data.params ?? {}), quality: value } })} /></div></>}</div>
      </>}
      {selectedResult && <ResultBlock result={selectedResult} runId={runId} nodeId={node.id} saveState={runId ? assetSaveStates[`${runId}:${node.id}:0`] : undefined} onSave={runId ? () => onSaveAsset(runId, node.id, 0) : undefined} />}
      <div className="inspector-footer"><span><Info size={12} /> Changes autosave when connected</span></div>
    </div>
  );
}

function LocalAssetSource({ node, asset }: { node: FlowNode; asset?: LocalAsset }) {
  const artifact = asset?.artifact;
  const url = artifactUrl(artifact);
  const kind = artifact?.kind ?? node.data.assetKind ?? 'image';
  const name = asset?.name ?? '已封存素材';
  return <div className="local-asset-source" data-testid="local-asset-source"><div className="local-asset-source-heading"><div><span className="field-label">Imported source</span><strong>{name}</strong><small>{kind.toUpperCase()} · {formatBytes(artifact?.bytes)}</small></div><span className="local-asset-private">PRIVATE</span></div>{url && <div className="local-asset-media">{kind === 'image' ? <img src={url} alt={name} referrerPolicy="no-referrer" crossOrigin="anonymous" /> : <video src={url} controls muted playsInline crossOrigin="anonymous" />}</div>}{url ? <div className="local-asset-actions"><a href={url} target="_blank" rel="noreferrer" data-testid="local-asset-preview" aria-label="local-asset-preview"><Maximize2 size={13} />私有預覽</a><a href={url} download={name} data-testid="local-asset-download" aria-label="local-asset-download"><Download size={13} />下載原檔</a></div> : <div className="local-asset-archived"><AlertCircle size={14} /><span>來源節點已封存；沒有可用的私有預覽，未重新建立節點。</span></div>}<div className="local-asset-id"><span>ASSET ID</span><code>{node.data.assetId ?? 'unknown'}</code></div></div>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}

function ParamField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="param-field"><span>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function ImageParams({ params, onChange }: { params?: Record<string, unknown>; onChange: (params: Record<string, unknown>) => void }) {
  const rawCount = typeof params?.n === 'number' ? params.n : typeof params?.n === 'string' ? Number(params.n) : 1;
  const count = Number.isInteger(rawCount) && rawCount >= 1 && rawCount <= 4 ? rawCount : 1;
  const responseFormat = params?.response_format === 'url' || params?.response_format === 'b64_json' ? params.response_format : '';
  const update = (key: 'n' | 'response_format', value: string) => {
    const next = { ...(params ?? {}) };
    if (key === 'n') next.n = Number(value);
    else if (value) next.response_format = value;
    else delete next.response_format;
    onChange(next);
  };
  return <div className="params-grid image-params"><label className="param-field"><span>Image count</span><select data-testid="image-count" aria-label="image-count" value={String(count)} onChange={(event) => update('n', event.target.value)}><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></label><label className="param-field"><span>Response format</span><select data-testid="image-response-format" aria-label="image-response-format" value={responseFormat} onChange={(event) => update('response_format', event.target.value)}><option value="">Default</option><option value="url">url</option><option value="b64_json">b64_json</option></select></label></div>;
}

function VideoParams({ params, onChange }: { params?: Record<string, unknown>; onChange: (params: Record<string, unknown>) => void }) {
  const seconds = params?.seconds === '4' || params?.seconds === '8' || params?.seconds === '12' ? params.seconds : '';
  const size = params?.size === '720x1280' || params?.size === '1280x720' || params?.size === '1024x1792' || params?.size === '1792x1024' ? params.size : '';
  const update = (key: 'seconds' | 'size', value: string) => {
    const next = { ...(params ?? {}) };
    if (value) next[key] = value;
    else delete next[key];
    onChange(next);
  };
  return <div className="params-grid video-params"><label className="param-field"><span>Seconds</span><select aria-label="video-seconds" value={seconds} onChange={(event) => update('seconds', event.target.value)}><option value="">Default</option><option value="4">4</option><option value="8">8</option><option value="12">12</option></select></label><label className="param-field"><span>Size</span><select aria-label="video-size" value={size} onChange={(event) => update('size', event.target.value)}><option value="">Default</option><option value="720x1280">720x1280</option><option value="1280x720">1280x720</option><option value="1024x1792">1024x1792</option><option value="1792x1024">1792x1024</option></select></label></div>;
}

function ResultBlock({ result, runId, nodeId, saveState, onSave }: { result: NodeResult; runId?: string; nodeId?: string; saveState?: AssetSaveState; onSave?: () => void }) {
  const artifact = assetForResult(result);
  const url = artifactUrl(artifact);
  const saved = Boolean(artifact?.localUrl || artifact?.localId || saveState?.status === 'saved');
  const assetKey = runId && nodeId ? `${runId}:${nodeId}:0` : '';
  const extension = artifact?.kind === 'video' ? (artifact.mimeType === 'video/webm' ? 'webm' : 'mp4') : artifact?.mimeType === 'image/jpeg' ? 'jpg' : artifact?.mimeType === 'image/webp' ? 'webp' : artifact?.mimeType === 'image/svg+xml' ? 'svg' : 'png';
  return <div className="result-block"><div className="result-heading"><span>LAST RESULT</span><span className={`result-status ${statusClass(result.status)}`}>{statusLabel(result.status)}</span></div>{url && artifact && <div className="result-asset"><span>{artifact.demo ? 'DEMO OUTPUT' : 'OUTPUT'}</span>{artifact.kind === 'image' ? <img src={url} alt="Generated output" referrerPolicy="no-referrer" crossOrigin="anonymous" /> : <video src={url} controls muted playsInline crossOrigin="anonymous" />}<div className="result-asset-actions">{onSave && <button className="asset-save-button" aria-label={`save-asset-${assetKey}`} disabled={saved || saveState?.status === 'saving'} onClick={onSave}>{saveState?.status === 'saving' ? <LoaderCircle className="spin" size={13} /> : saveState?.status === 'failed' ? <RefreshCw size={13} /> : <Save size={13} />}{saveState?.status === 'failed' ? '重試保存' : saved ? '已保存本機' : '保存本機'}</button>}{saved && <a className="asset-download-button" aria-label={`download-asset-${assetKey}`} href={url} download={`relay-${artifact.kind}-0.${extension}`}><Download size={13} />下載</a>}</div></div>}{result.error && <p className="result-error"><AlertCircle size={13} />{result.error}</p>}{result.referenceUrl && <p className="result-reference">Reference bound from this run</p>}</div>;
}

function HistoryPanel({ runs, activeRunId, currentRevision, onSelect }: { runs: Run[]; activeRunId?: string; currentRevision?: number; onSelect: (run: Run) => void }) {
  return <div className="history-content"><div className="panel-heading"><div><span className="panel-eyebrow">EXECUTION LOG</span><h2>Run history</h2></div><span className="history-count">{runs.length.toString().padStart(2, '0')}</span></div>{runs.length === 0 ? <div className="empty-panel compact"><div className="empty-icon"><Clock3 size={19} /></div><h2>No runs yet</h2><p>執行節點後，這裡會保留狀態與產物。</p></div> : <div className="run-list">{runs.map((run) => <button key={run.id} className={`run-card ${run.id === activeRunId ? 'is-active' : ''} ${run.revision !== currentRevision ? 'is-stale' : ''}`} onClick={() => onSelect(run)}><div className="run-card-top"><span className={`run-status-mark ${statusClass(run.status)}`} /> <strong>Canvas execution</strong><span className={`run-status-label ${statusClass(run.status)}`}>{statusLabel(run.status)}</span></div><div className="run-card-meta"><span>{new Date(run.startedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</span><span>{run.order.length} nodes</span><span>rev {run.revision}{run.revision !== currentRevision ? ' · archived' : ''}</span></div></button>)}</div>}</div>;
}

function ProvidersPanel({ providers, selectedId, settings, apiReady, dirty, saving, diagnostics, diagnosticsLoading, models, modelsLoading, relayFlowBusy, relayFlowCapacity, onDiagnostics, onQueryModels, onSelect, onChange, onAdd, onAddRelayFlow, onSave }: { providers: Provider[]; selectedId: string; settings: AppState['settings']; apiReady: boolean; dirty: boolean; saving: boolean; diagnostics: Record<string, ProviderDiagnostic>; diagnosticsLoading: boolean; models: string[]; modelsLoading: boolean; relayFlowBusy: boolean; relayFlowCapacity: boolean; onDiagnostics: () => void; onQueryModels: () => void; onSelect: (id: string) => void; onChange: (patch: Partial<Provider>) => void; onAdd: (template: ProviderTemplate) => void; onAddRelayFlow: () => void; onSave: () => void }) {
  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];
  const [template, setTemplate] = useState<ProviderTemplate>('openai');
  const diagnostic = diagnostics[selected?.id ?? ''];
  if (!selected) return null;
  const imageModelChoice = models.includes(selected.imageModel) ? selected.imageModel : '';
  const videoModelChoice = models.includes(selected.videoModel) ? selected.videoModel : '';
  const relayFlowReady = apiReady && selected.protocol === 'relay' && !dirty && !relayFlowBusy && relayFlowCapacity && Boolean(selected.imageModel.trim()) && Boolean(selected.videoModel.trim());
  const relayFlowReason = !apiReady ? '服務尚未連線' : selected.protocol !== 'relay' ? '請選擇 relay provider' : dirty ? '先保存 provider 設定' : relayFlowBusy ? 'provider 或執行工作忙碌中' : !relayFlowCapacity ? '畫布容量不足' : !selected.imageModel.trim() || !selected.videoModel.trim() ? '需要圖片與影片模型' : undefined;
  return <div className="providers-content"><div className="panel-heading"><div><span className="panel-eyebrow">RUNTIME CONFIG</span><h2>Providers</h2></div><div className="provider-heading-actions"><select className="provider-template-select" aria-label="provider-template" value={template} onChange={(event) => setTemplate(event.target.value as ProviderTemplate)}><option value="openai">OpenAI 圖片</option><option value="newapi">NewAPI 圖片</option><option value="videos">Videos JSON 中轉站</option><option value="relay">Image + Video JSON 中轉站</option><option value="fal">fal</option><option value="replicate">Replicate</option></select><button className="icon-button" aria-label="add-provider" onClick={() => onAdd(template)} title="新增供應商" disabled={!apiReady}><Plus size={15} /></button><button className="primary-button compact-button" aria-label="provider-save" onClick={onSave} disabled={!apiReady || !dirty || saving}>{saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}{saving ? '保存中' : 'Save'}</button></div></div><div className="provider-list">{providers.map((provider) => <button key={provider.id} className={`provider-row ${provider.id === selected.id ? 'is-selected' : ''}`} onClick={() => onSelect(provider.id)}><span className="provider-orb" data-protocol={provider.protocol}>{provider.protocol === 'demo' ? <Sparkles size={14} /> : <Zap size={14} />}</span><span><strong>{provider.name}</strong><small>{provider.protocol === 'demo' ? 'Offline preview' : provider.protocol.toUpperCase()}</small></span><ChevronDown className="provider-chevron" size={14} /></button>)}</div><div className="provider-detail"><Field label="Provider ID"><input aria-label="provider-id" value={selected.id} readOnly /></Field><Field label="Display name"><input aria-label="provider-name" value={selected.name} onChange={(event) => onChange({ name: event.target.value })} /></Field><Field label="Protocol"><select aria-label="provider-protocol" value={selected.protocol} onChange={(event) => onChange({ protocol: event.target.value as Provider['protocol'] })}><option value="demo">Demo</option><option value="openai">OpenAI compatible / NewAPI</option><option value="videos">Videos JSON relay</option><option value="relay">Image + Video JSON 中轉站</option><option value="fal">fal.ai</option><option value="replicate">Replicate</option></select></Field>{selected.protocol === 'relay' && <div className="provider-contract-hint" role="note"><strong>固定 relay contract</strong><span>圖片走 /images/generations，影片走 /videos；宣告 image + video 能力，模型查詢與 live provider 仍需實際驗證。</span></div>}<Field label="Base URL" hint="只允許伺服器設定的 exact HTTPS origin。"><input aria-label="provider-base-url" value={selected.baseUrl} onChange={(event) => onChange({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></Field><Field label="Key env name" hint="只填環境變數名稱，不要填入金鑰值。"><input aria-label="provider-key-env" value={selected.keyEnv} onChange={(event) => onChange({ keyEnv: event.target.value })} placeholder="RELAY_KEY_PROVIDER" /></Field><Field label="Image model"><input aria-label="provider-image-model" value={selected.imageModel} onChange={(event) => onChange({ imageModel: event.target.value })} />{models.length > 0 && <select aria-label="provider-image-model-options" value={imageModelChoice} onChange={(event) => event.target.value && onChange({ imageModel: event.target.value })}><option value="">選擇查詢模型（可保留手動輸入）</option>{models.map((model) => <option key={`image-${model}`} value={model}>{model}</option>)}</select>}</Field><Field label="Video model" hint={selected.protocol === 'videos' || selected.protocol === 'relay' ? `${selected.protocol === 'relay' ? 'Relay' : 'Videos JSON relay'} 只在你指定 model 時送出。` : undefined}><input aria-label="provider-video-model" value={selected.videoModel} onChange={(event) => onChange({ videoModel: event.target.value })} placeholder={selected.protocol === 'videos' || selected.protocol === 'relay' ? 'relay model（手動）' : 'Not supported'} />{models.length > 0 && <select aria-label="provider-video-model-options" value={videoModelChoice} onChange={(event) => event.target.value && onChange({ videoModel: event.target.value })}><option value="">選擇查詢模型（可保留手動輸入）</option>{models.map((model) => <option key={`video-${model}`} value={model}>{model}</option>)}</select>}</Field><div className="provider-actions"><button className="secondary-button" aria-label="provider-diagnostics" onClick={onDiagnostics} disabled={!apiReady || dirty || diagnosticsLoading}>{diagnosticsLoading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}診斷</button><button className="secondary-button" aria-label="query-models" onClick={onQueryModels} disabled={!apiReady || dirty || modelsLoading}>{modelsLoading ? <LoaderCircle className="spin" size={13} /> : <Search size={13} />}查詢模型</button></div><button type="button" className="relay-flow-add-button" data-testid="relay-flow-add" aria-label="新增圖→影流程" title={relayFlowReason} onClick={onAddRelayFlow} disabled={!relayFlowReady}><ImagePlus size={14} /><span>新增圖→影流程</span></button>{diagnostic && <div className="provider-diagnostics" role="status"><div className="diagnostic-chips"><span className={diagnostic.credentialConfigured ? 'is-ok' : ''}>KEY {diagnostic.credentialConfigured ? '已設' : '未設'}</span><span className={diagnostic.configurationValid ? 'is-ok' : 'is-bad'}>ORIGIN {diagnostic.configurationValid ? '允許' : '阻擋'}</span><span className={diagnostic.remoteEnabled ? 'is-ok' : ''}>REMOTE {diagnostic.remoteEnabled ? 'READY' : 'OFF'}</span><span>CAP {diagnostic.capabilities.join(', ') || 'none'}</span></div><small>{diagnostic.codes.length ? `codes: ${diagnostic.codes.join(', ')}` : 'codes: none'} · KEY 已設僅代表環境變數存在，不代表 live valid</small></div>}<div className="key-env"><LockKeyhole size={13} /><span>Runtime reads the secret from server env</span><code>{selected.keyEnv || 'No key required'}</code></div></div><div className="remote-banner"><div className="remote-banner-icon"><Activity size={15} /></div><div><strong>{settings.remoteEnabled ? 'Remote generation enabled' : 'Remote generation disabled'}</strong><p>{settings.remoteEnabled ? '每次外部生成仍需在執行前確認。' : 'Demo 可離線執行；遠端 provider 目前由伺服器停用。'}</p></div></div></div>;
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

function RunConfirmDialog({ confirm, providers, onCancel, onConfirm }: { confirm: RunConfirmState; providers: Provider[]; onCancel: () => void; onConfirm: () => void }) {
  const remote = confirm.plan.generations.filter((generation) => providers.find((provider) => provider.id === generation.providerId)?.protocol !== 'demo');
  const remoteModels = [...new Set(remote.map((generation) => `${providers.find((provider) => provider.id === generation.providerId)?.name ?? generation.providerId} · ${generation.model}`))];
  return <div className="dialog-scrim" role="presentation"><div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-run-title"><div className="dialog-icon"><Activity size={21} /></div><div className="panel-eyebrow">EXTERNAL ACTION</div><h2 id="confirm-run-title">Run remote generation?</h2><p>這次執行會呼叫外部 provider，可能產生費用。確認前請檢查 provider、model 與節點數。</p><div className="confirm-summary"><div><span>PROVIDERS</span><strong>{[...new Set(remote.map((generation) => providers.find((provider) => provider.id === generation.providerId)?.name ?? generation.providerId))].join(', ')}</strong></div><div><span>GENERATIONS</span><strong>{remote.length}</strong></div><div><span>IMAGE REQUESTS</span><strong data-testid="requested-image-quantity" aria-label="requested-image-quantity">{confirm.requestedImageCount}</strong></div><div><span>MODELS</span><strong>{remoteModels.join(', ')}</strong></div><div><span>MODE</span><strong>{confirm.nodeId ? 'Selected + ancestors' : 'Entire board'}</strong></div></div>{confirm.localImageReference.count > 0 && <div className="local-reference-disclosure" data-testid="local-reference-disclosure" role="note"><ImageIcon size={14} /><div><strong>本機圖片會在確認後傳給上游</strong><span>確認後，會將這次使用的本機圖片傳送至所選中轉站。</span>{confirm.localImageReference.oversized && <small>有本機圖片超過 4 MiB，無法用於遠端生成；請先縮小圖片。</small>}</div></div>}<div className="dialog-warning"><AlertCircle size={14} />未知 POST 結果不會自動重送；取消只停止本機輪詢。</div><div className="dialog-actions"><button className="ghost-button" onClick={onCancel}>Back</button><button className="primary-button" onClick={onConfirm} disabled={confirm.localImageReference.oversized}><Play size={14} fill="currentColor" />Confirm run</button></div></div></div>;
}

export default function App() {
  return <ReactFlowProvider><AppShell /></ReactFlowProvider>;
}
