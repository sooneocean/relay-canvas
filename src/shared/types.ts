export type NodeKind = 'prompt' | 'image' | 'video' | 'asset' | 'note';
export type MediaKind = 'image' | 'video';
export type Protocol = 'demo' | 'openai' | 'videos' | 'fal' | 'replicate';
export type ProviderCapability = 'image' | 'video';
export interface CanvasData extends Record<string, unknown> {
  kind: NodeKind;
  label: string;
  prompt?: string;
  providerId?: string;
  model?: string;
  params?: Record<string, unknown>;
  referenceField?: string;
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
export type Status = 'pending' | 'submitting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'needs_review';
export interface NodeResult { nodeId: string; status: Status; text?: string; artifacts: Artifact[]; error?: string; attemptId?: string; remoteId?: string; referenceUrl?: string }
export interface Run { id: string; boardId: string; revision: number; operationId: string; status: Status; startedAt: string; finishedAt?: string; snapshot: Board; providers: Provider[]; order: string[]; results: Record<string, NodeResult>; error?: string }
export interface StoreData { schemaVersion: 1; boards: Board[]; providers: Provider[]; runs: Run[] }
export interface AppState extends StoreData { settings: { remoteEnabled: boolean; mediaOrigins: string[]; providerOrigins: string[] } }
export type Operation = { type: 'add_node'; node: CanvasNode } | { type: 'update_node'; id: string; data?: Partial<CanvasData>; position?: { x: number; y: number } } | { type: 'remove_node'; id: string } | { type: 'connect'; edge: CanvasEdge } | { type: 'remove_edge'; id: string };
export interface GenerationRequest { kind: MediaKind; model: string; prompt: string; params: Record<string, unknown>; referenceUrl?: string; referenceField: string; signal: AbortSignal; onSubmitted: (remoteId: string) => void | Promise<void> }
export interface GenerationOutput { artifacts: Artifact[]; remoteId?: string }
export interface ExecutionPlan { order: string[]; generations: { nodeId: string; providerId: string; model: string }[]; errors: string[] }
