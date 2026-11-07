export type NodeKind = 'prompt' | 'image' | 'video' | 'asset' | 'note';
export type MediaKind = 'image' | 'video';
export type Protocol = 'demo' | 'openai' | 'videos' | 'relay' | 'fal' | 'replicate';
export type ProviderCapability = 'image' | 'video';
export interface CanvasData extends Record<string, unknown> {
  kind: NodeKind;
  label: string;
  prompt?: string;
  providerId?: string;
  model?: string;
  params?: Record<string, unknown>;
  referenceField?: string;
  assetId?: string;
  assetUrl?: string;
  assetKind?: MediaKind;
}
export interface CanvasNode { id: string; type: 'canvas'; position: { x: number; y: number }; data: CanvasData }
export interface CanvasEdge { id: string; source: string; target: string }
export interface Board { schemaVersion: 1; id: string; name: string; revision: number; nodes: CanvasNode[]; edges: CanvasEdge[]; viewport: { x: number; y: number; zoom: number } }
export interface Provider { id: string; name: string; protocol: Protocol; baseUrl: string; keyEnv: string; imageModel: string; videoModel: string }
export interface ProviderDiagnostic {
  providerId: string;
  configurationValid: boolean;
  remoteEnabled: boolean;
  credentialConfigured: boolean;
  capabilities: ProviderCapability[];
  codes: string[];
}
export interface ProviderModels { models: string[] }
export interface Artifact {
  kind: MediaKind;
  url: string;
  mimeType?: string;
  demo?: boolean;
  localId?: string;
  localUrl?: string;
  bytes?: number;
  sha256?: string;
}
export interface LocalAsset {
  id: string;
  boardId: string;
  nodeId: string;
  name: string;
  createdAt: string;
  artifact: Artifact;
}
export interface ImportAssetInput {
  expectedRevision: number;
  operationId: string;
  kind: MediaKind;
  name: string;
}
export interface ImportAssetResult { board: Board; asset: LocalAsset; nodePresent: boolean }
export type Status = 'pending' | 'submitting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'needs_review';
export interface NodeResult { nodeId: string; status: Status; text?: string; artifacts: Artifact[]; error?: string; attemptId?: string; remoteId?: string; referenceUrl?: string }
export interface Run { id: string; boardId: string; revision: number; operationId: string; status: Status; startedAt: string; finishedAt?: string; snapshot: Board; providers: Provider[]; order: string[]; results: Record<string, NodeResult>; error?: string }
export type TimelineFormat = 'landscape' | 'portrait';
export interface ClipSource { runId: string; nodeId: string; artifactIndex: number }
export interface MediaInfo { duration: number; width: number; height: number; hasAudio: boolean }
export interface TimelineClip {
  id: string;
  source: ClipSource;
  inSeconds: number;
  outSeconds: number;
  artifact: Artifact;
  media: MediaInfo;
}
export interface Timeline { boardId: string; revision: number; format: TimelineFormat; clips: TimelineClip[] }
export interface TimelineInputClip { id: string; source: ClipSource; inSeconds: number; outSeconds: number }
export interface TimelineInput { expectedRevision: number; format: TimelineFormat; clips: TimelineInputClip[] }
export interface EditorCapabilities {
  available: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
  formats: Record<TimelineFormat, { width: number; height: number }>;
  fps: 24;
  limits: {
    maxClips: 12;
    maxClipSeconds: 60;
    maxTimelineSeconds: 180;
    maxSourceBytes: number;
  };
}
export type ExportStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface ExportJob {
  id: string;
  boardId: string;
  timelineRevision: number;
  operationId: string;
  status: ExportStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  snapshot: Timeline;
  artifact?: Artifact;
}
export interface StoredExportJob extends ExportJob { attemptNonce: string }
export interface CanonicalArtifact { kind: MediaKind; url: string; demo?: boolean }
export interface CanonicalNodeResult {
  nodeId: string;
  status: Status;
  text?: string;
  artifacts: CanonicalArtifact[];
  error?: string;
  attemptId?: string;
  remoteId?: string;
  referenceUrl?: string;
}
export interface CanonicalRun {
  id: string;
  boardId: string;
  revision: number;
  operationId: string;
  status: Exclude<Status, 'pending' | 'submitting' | 'running'>;
  startedAt: string;
  finishedAt?: string;
  snapshot: Board;
  providers: Provider[];
  order: string[];
  results: Record<string, CanonicalNodeResult>;
  error?: string;
}
export type RunComparisonField = 'presence' | 'status' | 'prompt' | 'providerId' | 'model' | 'params' | 'artifacts';
export interface RunComparisonDifference { nodeId: string; fields: RunComparisonField[] }
export interface RunComparison { boardId: string; left: CanonicalRun; right: CanonicalRun; differences: RunComparisonDifference[] }
export interface ArtifactInfo { source: ClipSource; artifact: Artifact; media: MediaInfo }
export interface ExportInput { expectedRevision: number; operationId: string }
/** Local-only, allowlisted learning events. No free text, prompts, credentials or media. */
export interface LearningEventBase {
  schemaVersion: 1;
  eventId: string;
  occurredAt: string;
  episodeId: string;
  actor: 'unattributed';
  scope: 'local_only';
  boardId: string;
  revision: number;
}
export type LearningEventRecord = LearningEventBase & (
  | { type: 'board.revision_committed'; nodes: number; edges: number }
  | { type: 'board.patch_committed'; operationTypes: Array<'add_node' | 'update_node' | 'remove_node' | 'connect' | 'remove_edge'> }
  | { type: 'run.started'; runId: string; generations: number; remote: boolean }
  | { type: 'run.finished'; runId: string; status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'needs_review'; succeededNodes: number; artifactCount: number }
);

/** UI session channel is not cryptographic proof of a human actor. */
export type LocalFeedbackChoice = 'left' | 'right' | 'tie' | 'neither';
export type LocalFeedbackReason = 'identity' | 'motion' | 'composition' | 'instruction' | 'technical' | 'other';
export interface LocalFeedbackConsent { enabled: boolean; revision: number; updatedAt: string }
export interface LocalFeedbackRecord {
  id: string; operationId: string; boardId: string; nodeId: string;
  leftRunId: string; rightRunId: string;
  leftArtifactIndex: number; rightArtifactIndex: number;
  choice: LocalFeedbackChoice; reason?: LocalFeedbackReason; consentRevision: number;
  source: 'local_ui_unverified'; createdAt: string;
}
export interface LocalFeedbackStatus {
  enabled: boolean; revision: number; recordCount: number;
  scope: 'local_only'; attribution: 'unverified';
}

export interface StoreData {
  schemaVersion: 1;
  boards: Board[];
  providers: Provider[];
  runs: Run[];
  timelines?: Timeline[];
  exports?: StoredExportJob[];
  localAssets?: LocalAsset[];
  /** Canonical local event outbox. Persisted atomically with workspace changes. */
  learningOutbox?: LearningEventRecord[];
  /** Opt-in runs whose terminal event has not yet been queued. */
  learningObservedRuns?: string[];
  /** Observations dropped when outbox is full. Never blocks primary operations. */
  learningDroppedEvents?: number;
  learningFeedbackConsent?: LocalFeedbackConsent;
  learningFeedback?: LocalFeedbackRecord[];
}
export interface AppState extends Omit<StoreData, 'exports' | 'learningOutbox' | 'learningObservedRuns' | 'learningDroppedEvents' | 'learningFeedbackConsent' | 'learningFeedback'> {
  exports?: ExportJob[];
  settings: { remoteEnabled: boolean; mediaOrigins: string[]; providerOrigins: string[] };
}
export type Operation = { type: 'add_node'; node: CanvasNode } | { type: 'update_node'; id: string; data?: Partial<CanvasData>; position?: { x: number; y: number } } | { type: 'remove_node'; id: string } | { type: 'connect'; edge: CanvasEdge } | { type: 'remove_edge'; id: string };
export interface GenerationRequest { kind: MediaKind; model: string; prompt: string; params: Record<string, unknown>; referenceUrl?: string; referenceField: string; signal: AbortSignal; onSubmitted: (remoteId: string) => void | Promise<void> }
export interface GenerationOutput { artifacts: Artifact[]; remoteId?: string }
export interface ExecutionPlan { order: string[]; generations: { nodeId: string; providerId: string; model: string }[]; errors: string[] }
