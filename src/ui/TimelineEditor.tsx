import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Film,
  GripVertical,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Scissors,
  Trash2,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type {
  Artifact,
  ArtifactInfo,
  Board,
  EditorCapabilities,
  ExportJob,
  Run,
  Timeline,
  TimelineClip,
  TimelineFormat,
} from '../shared/types.js';
import useModalFocus from './useModalFocus.js';

export type UiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;
export type SaveArtifact = (runId: string, nodeId: string, artifactIndex: number) => Promise<Artifact | undefined>;

type TimelineEditorProps = {
  board: Board;
  runs: Run[];
  exports: ExportJob[];
  requestJson: UiRequest;
  onSaveArtifact: SaveArtifact;
  onExportJob: (job: ExportJob) => void;
  onClose: () => void;
};

type VideoSource = {
  id: string;
  run: Run;
  nodeId: string;
  artifactIndex: number;
  artifact: Artifact;
};

type RequestError = Error & { status?: number };
type PendingExportRequest = {
  operationId: string;
  expectedRevision: number;
  editVersion: number;
};

type TimelineTrimEdge = 'inSeconds' | 'outSeconds';
type TimelineTrimDrag = {
  id: string;
  edge: TimelineTrimEdge;
  startX: number;
  startValue: number;
  pixelsPerSecond: number;
  pointerId: number;
};

const timelineFramesPerSecond = 24;
const timelineFrame = 1 / timelineFramesPerSecond;

const terminalExportStatuses = new Set<ExportJob['status']>(['succeeded', 'failed', 'cancelled', 'interrupted']);

function makeId(prefix: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2, 12);
  return `${prefix}-${id}`;
}

function operationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? makeId('export');
}

function asTimeline(value: Timeline | { timeline: Timeline }): Timeline {
  return 'timeline' in value ? value.timeline : value;
}

function asJob(value: ExportJob | { job: ExportJob }): ExportJob {
  return 'job' in value ? value.job : value;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '請稍後重試。';
}

function isConflict(error: unknown): boolean {
  return (error as RequestError)?.status === 409 || /409|版本|revision|衝突|conflict/i.test(errorText(error));
}

function formatSeconds(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function artifactUrl(artifact: Artifact): string {
  return artifact.localUrl ?? artifact.url;
}

function sourceLabel(source: VideoSource): string {
  return `${source.nodeId} · ${source.run.id.slice(0, 8)}${source.artifact.demo ? ' · Demo' : ''}`;
}

function statusLabel(status: ExportJob['status']): string {
  switch (status) {
    case 'pending': return '排隊中';
    case 'running': return '匯出中';
    case 'succeeded': return '已完成';
    case 'failed': return '失敗';
    case 'cancelled': return '已取消';
    case 'interrupted': return '服務中斷';
    default: return status;
  }
}

function quantizeTimelineSeconds(value: number): number {
  return Math.round(value * timelineFramesPerSecond) / timelineFramesPerSecond;
}

function clampTimelineTrim(clip: TimelineClip, edge: TimelineTrimEdge, value: number): number {
  const quantized = quantizeTimelineSeconds(Math.max(0, value));
  if (edge === 'inSeconds') {
    const minimum = quantizeTimelineSeconds(Math.max(0, clip.outSeconds - 60));
    const maximum = quantizeTimelineSeconds(Math.min(clip.media.duration, clip.outSeconds - timelineFrame));
    return Math.max(minimum, Math.min(Math.max(minimum, maximum), quantized));
  }
  const minimum = quantizeTimelineSeconds(Math.max(0, clip.inSeconds + timelineFrame));
  const maximum = quantizeTimelineSeconds(Math.min(clip.media.duration, clip.inSeconds + 60));
  return Math.max(minimum, Math.min(Math.max(minimum, maximum), quantized));
}

function ClipCard({
  clip,
  index,
  total,
  onDragStart,
  onDrop,
  onMove,
  onDuplicate,
  onRemove,
  onTrim,
}: {
  clip: TimelineClip;
  index: number;
  total: number;
  onDragStart: (event: DragEvent<HTMLDivElement>, index: number) => void;
  onDrop: (event: DragEvent<HTMLDivElement>, index: number) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onDuplicate: (clip: TimelineClip) => void;
  onRemove: (id: string) => void;
  onTrim: (id: string, field: 'inSeconds' | 'outSeconds', value: number) => void;
}) {
  const invalid = clip.inSeconds < 0 || clip.outSeconds <= clip.inSeconds || clip.outSeconds > clip.media.duration || clip.outSeconds - clip.inSeconds < 1 / 24 || clip.outSeconds - clip.inSeconds > 60;
  return (
    <div
      className={`timeline-clip-card ${invalid ? 'is-invalid' : ''}`}
      data-testid={`timeline-clip-${clip.id}`}
      draggable
      onDragStart={(event) => onDragStart(event, index)}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
      onDrop={(event) => onDrop(event, index)}
    >
      <div className="timeline-clip-head">
        <span className="timeline-clip-drag" title="拖曳重新排序" aria-hidden="true"><GripVertical size={15} /></span>
        <div className="timeline-clip-title"><strong>{clip.artifact.demo ? 'Demo video' : 'Saved video'}</strong><small>{clip.source.nodeId} · {clip.source.runId.slice(0, 8)}</small></div>
        <span className="timeline-clip-index">{String(index + 1).padStart(2, '0')}</span>
      </div>
      <video className="timeline-clip-thumb" src={artifactUrl(clip.artifact)} muted playsInline preload="metadata" aria-label={`片段 ${index + 1}`} />
      <div className="timeline-clip-meta"><span>{formatSeconds(clip.outSeconds - clip.inSeconds)}</span><span>{clip.media.width}×{clip.media.height}</span><span>{clip.media.hasAudio ? 'Audio' : 'Silent'}</span></div>
      <div className="timeline-trim-grid">
        <label><span>In</span><input data-testid={`timeline-in-${clip.id}`} type="number" min="0" max={clip.media.duration} step="0.01" value={clip.inSeconds} onChange={(event) => onTrim(clip.id, 'inSeconds', Number(event.target.value))} /></label>
        <label><span>Out</span><input data-testid={`timeline-out-${clip.id}`} type="number" min="0" max={clip.media.duration} step="0.01" value={clip.outSeconds} onChange={(event) => onTrim(clip.id, 'outSeconds', Number(event.target.value))} /></label>
      </div>
      {invalid && <span className="timeline-clip-error" role="alert"><AlertCircle size={12} />檢查 in / out 與 60s 上限</span>}
      <div className="timeline-clip-actions">
        <button data-testid={`timeline-move-left-${clip.id}`} aria-label={`片段 ${index + 1} 左移`} disabled={index === 0} onClick={() => onMove(index, -1)}><ChevronLeft size={14} /></button>
        <button data-testid={`timeline-move-right-${clip.id}`} aria-label={`片段 ${index + 1} 右移`} disabled={index === total - 1} onClick={() => onMove(index, 1)}><ChevronRight size={14} /></button>
        <button data-testid={`timeline-duplicate-${clip.id}`} aria-label={`複製片段 ${index + 1}`} onClick={() => onDuplicate(clip)}><Copy size={13} /></button>
        <button data-testid={`timeline-remove-${clip.id}`} aria-label={`移除片段 ${index + 1}`} onClick={() => onRemove(clip.id)}><Trash2 size={13} /></button>
      </div>
    </div>
  );
}

export default function TimelineEditor({ board, runs, exports, requestJson, onSaveArtifact, onExportJob, onClose }: TimelineEditorProps) {
  const dialogRef = useModalFocus<HTMLElement>();
  const [timeline, setTimeline] = useState<Timeline>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [capabilities, setCapabilities] = useState<EditorCapabilities>();
  const [capabilitiesError, setCapabilitiesError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [sourceSaving, setSourceSaving] = useState<string>();
  const [sourceError, setSourceError] = useState('');
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [playhead, setPlayhead] = useState(0);
  const [seekIntent, setSeekIntent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [activeClipIndex, setActiveClipIndex] = useState(0);
  const [timelineZoom, setTimelineZoom] = useState(72);
  const [exportJob, setExportJob] = useState<ExportJob>();
  const [exportError, setExportError] = useState('');
  const [exportSaving, setExportSaving] = useState(false);
  const [pendingExport, setPendingExport] = useState<PendingExportRequest>();
  const editVersionRef = useRef(0);
  const timelineRef = useRef<Timeline | undefined>(undefined);
  const dirtyRef = useRef(false);
  const saveInFlightRef = useRef<Promise<boolean> | undefined>(undefined);
  const savingRef = useRef(false);
  const loadVersionRef = useRef(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playingRef = useRef(false);
  const transitioningRef = useRef(false);
  const exportPollRef = useRef<Map<string, number>>(new Map());
  const exportPollInFlightRef = useRef<Set<string>>(new Set());
  const selectedExportIdRef = useRef<string | undefined>(undefined);
  const pendingExportRef = useRef<PendingExportRequest | undefined>(undefined);
  const exportSubmitRef = useRef<Promise<void> | undefined>(undefined);
  const mountedRef = useRef(false);
  const trimDragRef = useRef<TimelineTrimDrag | undefined>(undefined);

  const boardRuns = useMemo(() => runs.filter((run) => run.boardId === board.id), [board.id, runs]);
  const sources = useMemo<VideoSource[]>(() => boardRuns.flatMap((run) => {
    if (run.status !== 'succeeded') return [];
    return Object.entries(run.results).flatMap(([nodeId, result]) => {
      if (result.status !== 'succeeded') return [];
      return result.artifacts.flatMap((artifact, artifactIndex) => artifact.kind === 'video' ? [{ id: `${run.id}:${nodeId}:${artifactIndex}`, run, nodeId, artifactIndex, artifact }] : []);
    });
  }), [boardRuns]);
  const totalDuration = useMemo(() => timeline?.clips.reduce((sum, clip) => sum + Math.max(0, clip.outSeconds - clip.inSeconds), 0) ?? 0, [timeline]);
  const currentClip = timeline?.clips[activeClipIndex];
  const boardExports = useMemo(() => exports.filter((job) => job.boardId === board.id), [board.id, exports]);
  const selectedSource = sources.find((source) => source.id === selectedSourceId);

  useEffect(() => { timelineRef.current = timeline; }, [timeline]);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  useEffect(() => {
    if (!sources.some((source) => source.id === selectedSourceId)) setSelectedSourceId(sources[0]?.id ?? '');
  }, [selectedSourceId, sources]);

  const loadRemote = useCallback(async (discardDraft = false) => {
    if (discardDraft && dirtyRef.current && !window.confirm('重新載入會捨棄目前未保存的 timeline 編輯。要繼續嗎？')) return;
    const requestVersion = ++loadVersionRef.current;
    setLoading(true);
    setLoadError('');
    try {
      const result = await requestJson<Timeline | { timeline: Timeline }>(`/api/boards/${encodeURIComponent(board.id)}/timeline`);
      if (requestVersion !== loadVersionRef.current) return;
      const next = asTimeline(result);
      setTimeline(next);
      timelineRef.current = next;
      dirtyRef.current = false;
      setDirty(false);
      setConflict(false);
      setSaveError('');
      setPlayhead(0);
      setActiveClipIndex(0);
    } catch (error) {
      if (requestVersion === loadVersionRef.current) setLoadError(errorText(error));
    } finally {
      if (requestVersion === loadVersionRef.current) setLoading(false);
    }
  }, [board.id, requestJson]);

  useEffect(() => {
    void loadRemote();
    let active = true;
    void requestJson<EditorCapabilities>('/api/editor/capabilities').then((value) => {
      if (active) { setCapabilities(value); setCapabilitiesError(''); }
    }).catch((error) => {
      if (active) setCapabilitiesError(errorText(error));
    });
    return () => { active = false; };
  }, [board.id, loadRemote, requestJson]);
  useEffect(() => () => { loadVersionRef.current += 1; }, []);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const edit = useCallback((change: (current: Timeline) => Timeline) => {
    setTimeline((current) => {
      if (!current) return current;
      const next = change(current);
      timelineRef.current = next;
      return next;
    });
    editVersionRef.current += 1;
    dirtyRef.current = true;
    setDirty(true);
    setSaveError('');
    setConflict(false);
  }, []);

  const saveTimeline = useCallback(async (): Promise<boolean> => {
    if (saveInFlightRef.current) return saveInFlightRef.current;
    const current = timelineRef.current;
    if (!current) return false;
    if (!dirtyRef.current) return true;
    const versionAtStart = editVersionRef.current;
    savingRef.current = true;
    setSaving(true);
    setSaveError('');
    const operation = (async () => {
      try {
        const body = {
          expectedRevision: current.revision,
          format: current.format,
          clips: current.clips.map(({ id, source, inSeconds, outSeconds }) => ({ id, source, inSeconds, outSeconds })),
        };
        const response = await requestJson<Timeline | { timeline: Timeline }>(`/api/boards/${encodeURIComponent(board.id)}/timeline`, { method: 'PUT', body: JSON.stringify(body) });
        const saved = asTimeline(response);
        const editedWhileSaving = editVersionRef.current !== versionAtStart;
        setTimeline((latest) => latest ? { ...latest, revision: saved.revision } : latest);
        timelineRef.current = timelineRef.current ? { ...timelineRef.current, revision: saved.revision } : saved;
        if (editedWhileSaving) {
          dirtyRef.current = true;
          setDirty(true);
          setSaveError('保存了較早的 snapshot；保存期間的新編輯仍保留，請再次保存。');
          return false;
        }
        setTimeline(saved);
        timelineRef.current = saved;
        dirtyRef.current = false;
        setDirty(false);
        setConflict(false);
        return true;
      } catch (error) {
        if (isConflict(error)) setConflict(true);
        setSaveError(errorText(error));
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    })();
    saveInFlightRef.current = operation;
    void operation.finally(() => { if (saveInFlightRef.current === operation) saveInFlightRef.current = undefined; }).catch(() => undefined);
    return operation;
  }, [board.id, requestJson]);

  const closeEditor = useCallback(async () => {
    if (saving) return;
    if (dirtyRef.current) {
      const closed = await saveTimeline();
      if (!closed || dirtyRef.current || savingRef.current) return;
    }
    onClose();
  }, [onClose, saveTimeline, saving]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') void closeEditor(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeEditor]);

  const addSource = useCallback(async (source: VideoSource) => {
    const sourceKey = source.id;
    setSourceError('');
    setSourceSaving(sourceKey);
    try {
      if ((timelineRef.current?.clips.length ?? 0) >= (capabilities?.limits.maxClips ?? 12)) {
        throw new Error(`Timeline 最多 ${capabilities?.limits.maxClips ?? 12} 個片段。`);
      }
      let artifact = source.artifact;
      if (!artifact.localId && !artifact.localUrl) {
        const saved = await onSaveArtifact(source.run.id, source.nodeId, source.artifactIndex);
        if (!saved) throw new Error('素材保存失敗；請重試後再加入 timeline。');
        artifact = saved;
      }
      const info = await requestJson<ArtifactInfo | { info: ArtifactInfo }>(`/api/runs/${encodeURIComponent(source.run.id)}/artifacts/${encodeURIComponent(source.nodeId)}/${source.artifactIndex}/info`);
      const resolved = 'info' in info ? info.info : info;
      edit((current) => {
        const duration = Math.min(resolved.media.duration, capabilities?.limits.maxClipSeconds ?? 60);
        return { ...current, clips: [...current.clips, { id: makeId('clip'), source: resolved.source, inSeconds: 0, outSeconds: duration, artifact: resolved.artifact ?? artifact, media: resolved.media }] };
      });
    } catch (error) {
      setSourceError(errorText(error));
    } finally {
      setSourceSaving(undefined);
    }
  }, [capabilities?.limits.maxClipSeconds, capabilities?.limits.maxClips, edit, onSaveArtifact, requestJson]);

  const updateTrim = useCallback((id: string, field: 'inSeconds' | 'outSeconds', value: number) => {
    if (!Number.isFinite(value)) return;
    edit((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === id ? { ...clip, [field]: Math.max(0, value) } : clip) }));
  }, [edit]);

  const pauseForTrim = useCallback(() => {
    videoRef.current?.pause();
    playingRef.current = false;
    setPlaying(false);
  }, []);

  const onTrimPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>, clip: TimelineClip, edge: TimelineTrimEdge) => {
    event.preventDefault();
    event.stopPropagation();
    pauseForTrim();
    trimDragRef.current = { id: clip.id, edge, startX: event.clientX, startValue: edge === 'inSeconds' ? clip.inSeconds : clip.outSeconds, pixelsPerSecond: timelineZoom, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [pauseForTrim, timelineZoom]);

  const onTrimPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = trimDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const current = timelineRef.current?.clips.find((clip) => clip.id === drag.id);
    if (!current) return;
    const nextValue = clampTimelineTrim(current, drag.edge, drag.startValue + ((event.clientX - drag.startX) / drag.pixelsPerSecond));
    edit((latest) => ({ ...latest, clips: latest.clips.map((clip) => clip.id === drag.id ? { ...clip, [drag.edge]: nextValue } : clip) }));
  }, [edit]);

  const onTrimPointerEnd = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = trimDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    trimDragRef.current = undefined;
  }, []);

  const moveClip = useCallback((index: number, direction: -1 | 1) => {
    edit((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.clips.length) return current;
      const clips = [...current.clips];
      [clips[index], clips[nextIndex]] = [clips[nextIndex], clips[index]];
      return { ...current, clips };
    });
  }, [edit]);

  const duplicateClip = useCallback((clip: TimelineClip) => edit((current) => {
    const index = current.clips.findIndex((candidate) => candidate.id === clip.id);
    const copyClip = { ...clip, id: makeId('clip'), source: { ...clip.source }, artifact: { ...clip.artifact }, media: { ...clip.media } };
    return { ...current, clips: [...current.clips.slice(0, index + 1), copyClip, ...current.clips.slice(index + 1)] };
  }), [edit]);

  const removeClip = useCallback((id: string) => edit((current) => ({ ...current, clips: current.clips.filter((clip) => clip.id !== id) })), [edit]);

  const onClipDragStart = useCallback((event: DragEvent<HTMLDivElement>, index: number) => {
    event.dataTransfer.setData('application/relay-timeline-index', String(index));
    event.dataTransfer.effectAllowed = 'move';
  }, []);
  const onClipDrop = useCallback((event: DragEvent<HTMLDivElement>, targetIndex: number) => {
    const from = Number(event.dataTransfer.getData('application/relay-timeline-index'));
    if (!Number.isInteger(from) || from === targetIndex) return;
    edit((current) => {
      const clips = [...current.clips];
      const [moved] = clips.splice(from, 1);
      clips.splice(targetIndex, 0, moved);
      return { ...current, clips };
    });
  }, [edit]);

  const locatePlayhead = useCallback((value: number, clips = timelineRef.current?.clips ?? []) => {
    let offset = 0;
    for (let index = 0; index < clips.length; index += 1) {
      const duration = Math.max(0, clips[index].outSeconds - clips[index].inSeconds);
      if (value <= offset + duration || index === clips.length - 1) return { index, sourceTime: clips[index].inSeconds + Math.max(0, Math.min(duration, value - offset)) };
      offset += duration;
    }
    return undefined;
  }, []);

  const seekPreview = useCallback((value: number) => {
    const next = Math.max(0, Math.min(totalDuration, value));
    const location = locatePlayhead(next);
    setPlayhead(next);
    setSeekIntent((current) => current + 1);
    if (!location) return;
    if (playingRef.current && location.index !== activeClipIndex) transitioningRef.current = true;
    setActiveClipIndex(location.index);
    const video = videoRef.current;
    if (video) { try { video.currentTime = location.sourceTime; } catch { /* media may still be loading */ } }
  }, [activeClipIndex, locatePlayhead, totalDuration]);

  const timelineTrackWidth = Math.max(1, Math.ceil(totalDuration * timelineZoom));
  const timelineRulerTicks = useMemo(() => Array.from({ length: Math.max(2, Math.ceil(totalDuration) + 1) }, (_, index) => index), [totalDuration]);
  const seekTimelineAtClientX = useCallback((clientX: number, element: HTMLElement) => {
    const bounds = element.getBoundingClientRect();
    seekPreview(Math.max(0, Math.min(totalDuration, (clientX - bounds.left) / timelineZoom)));
  }, [seekPreview, timelineZoom, totalDuration]);
  const onTimelineTrackClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    seekTimelineAtClientX(event.clientX, event.currentTarget);
  }, [seekTimelineAtClientX]);
  const onTimelineTrackKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = timelineFrame;
    if (event.key === 'ArrowLeft') { event.preventDefault(); seekPreview(playhead - step); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); seekPreview(playhead + step); }
    else if (event.key === 'Home') { event.preventDefault(); seekPreview(0); }
    else if (event.key === 'End') { event.preventDefault(); seekPreview(totalDuration); }
  }, [playhead, seekPreview, totalDuration]);

  useEffect(() => {
    if (playhead > totalDuration) setPlayhead(totalDuration);
  }, [playhead, totalDuration]);

  useEffect(() => {
    const current = timelineRef.current?.clips[activeClipIndex];
    const video = videoRef.current;
    if (!current || !video) return;
    const offset = timelineRef.current?.clips.slice(0, activeClipIndex).reduce((sum, item) => sum + Math.max(0, item.outSeconds - item.inSeconds), 0) ?? 0;
    const localOffset = Math.max(0, Math.min(current.outSeconds - current.inSeconds, playhead - offset));
    const sourceTime = current.inSeconds + localOffset;
    const apply = () => { try { video.currentTime = sourceTime; if (playingRef.current) void video.play().catch(() => undefined); } catch { /* media may not be ready */ } };
    if (video.readyState >= 1) apply();
    else video.addEventListener('loadedmetadata', apply, { once: true });
    return () => video.removeEventListener('loadedmetadata', apply);
  }, [activeClipIndex, currentClip?.id, currentClip?.inSeconds, currentClip?.outSeconds, seekIntent]);

  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    const current = timelineRef.current;
    if (!video || !current || !current.clips[activeClipIndex]) return;
    const clip = current.clips[activeClipIndex];
    const clipOffset = current.clips.slice(0, activeClipIndex).reduce((sum, item) => sum + Math.max(0, item.outSeconds - item.inSeconds), 0);
    const local = Math.max(clip.inSeconds, Math.min(clip.outSeconds, video.currentTime));
    const atEnd = local >= clip.outSeconds - 0.04;
    setPlayhead(clipOffset + Math.max(0, local - clip.inSeconds));
    if (atEnd) {
      if (activeClipIndex < current.clips.length - 1) {
        transitioningRef.current = true;
        setActiveClipIndex(activeClipIndex + 1);
        setPlayhead(clipOffset + (clip.outSeconds - clip.inSeconds));
      } else {
        video.pause();
        transitioningRef.current = false;
        setPlaying(false);
        playingRef.current = false;
      }
    }
  }, [activeClipIndex]);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video || !currentClip) return;
    if (playing) { video.pause(); setPlaying(false); playingRef.current = false; }
    else { setPlaying(true); playingRef.current = true; void video.play().catch(() => { transitioningRef.current = false; setPlaying(false); playingRef.current = false; }); }
  }, [currentClip, playing]);

  const handleStagePlay = useCallback(() => {
    transitioningRef.current = false;
    setPlaying(true);
    playingRef.current = true;
  }, []);

  const handleStagePause = useCallback(() => {
    if (transitioningRef.current) return;
    setPlaying(false);
    playingRef.current = false;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const timer of exportPollRef.current.values()) window.clearTimeout(timer);
      exportPollRef.current.clear();
      exportPollInFlightRef.current.clear();
    };
  }, []);

  const updateExport = useCallback((job: ExportJob, activate = false) => {
    onExportJob(job);
    if (activate || selectedExportIdRef.current === job.id) {
      selectedExportIdRef.current = job.id;
      setExportJob(job);
    }
  }, [onExportJob]);

  const pollExport = useCallback((id: string) => {
    if (!mountedRef.current || exportPollInFlightRef.current.has(id)) return;
    const scheduled = exportPollRef.current.get(id);
    if (scheduled !== undefined) {
      window.clearTimeout(scheduled);
      exportPollRef.current.delete(id);
    }
    const schedule = (delay: number) => {
      if (!mountedRef.current || exportPollRef.current.has(id)) return;
      const timer = window.setTimeout(() => {
        exportPollRef.current.delete(id);
        pollExport(id);
      }, delay);
      exportPollRef.current.set(id, timer);
    };
    const poll = async () => {
      if (!mountedRef.current) return;
      exportPollInFlightRef.current.add(id);
      try {
        const response = await requestJson<ExportJob | { job: ExportJob }>(`/api/exports/${encodeURIComponent(id)}`);
        if (!mountedRef.current) return;
        const job = asJob(response);
        updateExport(job);
        if (terminalExportStatuses.has(job.status)) {
          const timer = exportPollRef.current.get(id);
          if (timer !== undefined) window.clearTimeout(timer);
          exportPollRef.current.delete(id);
        } else {
          schedule(1000);
        }
      } catch (error) {
        if (mountedRef.current) {
          if (selectedExportIdRef.current === undefined || selectedExportIdRef.current === id) setExportError(errorText(error));
          schedule(1500);
        }
      } finally {
        exportPollInFlightRef.current.delete(id);
      }
    };
    void poll();
  }, [requestJson, updateExport]);

  useEffect(() => {
    for (const job of boardExports) {
      if (!terminalExportStatuses.has(job.status) && !exportPollRef.current.has(job.id) && !exportPollInFlightRef.current.has(job.id)) pollExport(job.id);
    }
  }, [boardExports, pollExport]);

  const startExport = useCallback(() => {
    if (exportSubmitRef.current) return exportSubmitRef.current;
    const operation = (async () => {
      setExportSaving(true);
      setExportError('');
      try {
        const before = timelineRef.current;
        if (!before || !before.clips.length) { setExportError('空 timeline 無法匯出；請先加入已保存的影片。'); return; }
        if (capabilities && !capabilities.available) { setExportError('FFmpeg/FFprobe 尚未就緒；請先安裝相容的系統 FFmpeg。'); return; }

        const existing = pendingExportRef.current;
        if (existing && (existing.expectedRevision !== before.revision || existing.editVersion !== editVersionRef.current || dirtyRef.current)) {
          setExportError('原匯出提交尚未確認，而目前 draft 已改變；請恢復原提交或先選擇 New attempt。');
          return;
        }
        if (!existing && dirtyRef.current) {
          const saved = await saveTimeline();
          if (!saved || dirtyRef.current || savingRef.current) return;
        }

        const current = timelineRef.current;
        if (!current || !current.clips.length) { setExportError('空 timeline 無法匯出；請先加入已保存的影片。'); return; }
        let request = pendingExportRef.current;
        if (request && (request.expectedRevision !== current.revision || request.editVersion !== editVersionRef.current || dirtyRef.current)) {
          setExportError('原匯出提交尚未確認，而目前 draft 已改變；請恢復原提交或先選擇 New attempt。');
          return;
        }
        if (!request) {
          request = { operationId: operationId(), expectedRevision: current.revision, editVersion: editVersionRef.current };
          pendingExportRef.current = request;
          setPendingExport(request);
        }

        const response = await requestJson<ExportJob | { job: ExportJob }>(`/api/boards/${encodeURIComponent(board.id)}/exports`, { method: 'POST', body: JSON.stringify({ expectedRevision: request.expectedRevision, operationId: request.operationId }) });
        const job = asJob(response);
        pendingExportRef.current = undefined;
        setPendingExport(undefined);
        updateExport(job, true);
        pollExport(job.id);
      } catch (error) {
        const status = (error as RequestError)?.status;
        if (typeof status === 'number' && Number.isFinite(status) && status >= 400 && status < 500 && status !== 408) {
          pendingExportRef.current = undefined;
          setPendingExport(undefined);
        }
        setExportError(errorText(error));
      } finally {
        setExportSaving(false);
      }
    })();
    exportSubmitRef.current = operation;
    void operation.finally(() => {
      if (exportSubmitRef.current === operation) exportSubmitRef.current = undefined;
    }).catch(() => undefined);
    return operation;
  }, [board.id, capabilities, pollExport, requestJson, saveTimeline, updateExport]);

  const beginNewExportAttempt = useCallback(() => {
    pendingExportRef.current = undefined;
    setPendingExport(undefined);
    selectedExportIdRef.current = undefined;
    setExportJob(undefined);
    setExportError('原匯出提交已清除；再次按匯出會建立新的 operation。');
  }, []);

  const cancelExport = useCallback(async (job: ExportJob) => {
    try {
      const response = await requestJson<ExportJob | { job: ExportJob }>(`/api/exports/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', body: '{}' });
      updateExport(asJob(response));
    } catch (error) { setExportError(errorText(error)); }
  }, [requestJson, updateExport]);

  const clips = timeline?.clips ?? [];
  const hasInvalidClip = clips.some((clip) => clip.inSeconds < 0 || clip.outSeconds <= clip.inSeconds || clip.outSeconds > clip.media.duration || clip.outSeconds - clip.inSeconds < 1 / 24);
  const maxClips = capabilities?.limits.maxClips ?? 12;
  const maxClipSeconds = capabilities?.limits.maxClipSeconds ?? 60;
  const maxTimelineSeconds = capabilities?.limits.maxTimelineSeconds ?? 180;
  const overLimit = clips.length > maxClips || totalDuration > maxTimelineSeconds || clips.some((clip) => clip.outSeconds - clip.inSeconds > maxClipSeconds);
  const activeExport = exportJob ?? boardExports[0];
  const pendingExportCanRetry = Boolean(pendingExport && timeline && !dirty && pendingExport.expectedRevision === timeline.revision && pendingExport.editVersion === editVersionRef.current);
  const pendingExportBlocked = Boolean(pendingExport && !pendingExportCanRetry);

  return (
    <div className="dialog-scrim timeline-scrim" role="presentation">
      <section ref={dialogRef} className="timeline-dialog" data-testid="timeline-dialog" role="dialog" aria-modal="true" aria-labelledby="timeline-title">
        <header className="timeline-dialog-head">
          <div><span className="panel-eyebrow">EDITOR / v0.4.0</span><h2 id="timeline-title">Timeline editor <span className="timeline-board-name">{board.name}</span></h2><p>排列已保存的影片，trim 後預覽每個 cut 的原始 audio。</p></div>
          <button className="icon-button" data-modal-close data-testid="timeline-close" aria-label="關閉 timeline editor" onClick={() => void closeEditor()}><X size={17} /></button>
        </header>
        {loading ? <div className="timeline-state"><LoaderCircle className="spin" size={22} /><strong>載入 timeline…</strong></div> : loadError ? <div className="timeline-state is-error" role="alert"><AlertCircle size={20} /><strong>Timeline 載入失敗</strong><p>{loadError}</p><button className="secondary-button" onClick={() => void loadRemote()}><RefreshCw size={14} />重試</button></div> : <>
          <div className="timeline-toolbar">
            <label className="timeline-format-field"><span>輸出方向</span><select data-testid="timeline-format" aria-label="timeline 輸出方向" value={timeline?.format ?? 'landscape'} onChange={(event) => edit((current) => ({ ...current, format: event.target.value as TimelineFormat }))}><option value="landscape">Landscape · 1280 × 720</option><option value="portrait">Portrait · 720 × 1280</option></select></label>
            <div className="timeline-toolbar-stats"><span>{clips.length} / {capabilities?.limits.maxClips ?? 12} clips</span><span>{formatSeconds(totalDuration)} / {capabilities?.limits.maxTimelineSeconds ?? 180}s</span><span>revision {timeline?.revision ?? 0}{dirty ? ' · draft' : ''}</span></div>
            <div className="timeline-toolbar-actions"><button className="secondary-button" data-testid="timeline-reload" onClick={() => void loadRemote(true)} disabled={saving}><RotateCcw size={14} />Reload latest</button><button className="primary-button" data-testid="timeline-save" onClick={() => void saveTimeline()} disabled={!dirty || saving || hasInvalidClip || overLimit}>{saving ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}{saving ? '保存中' : '保存 timeline'}</button></div>
          </div>
          {(saveError || conflict) && <div className="timeline-alert" role="alert"><AlertCircle size={15} /><div><strong>{conflict ? 'Timeline revision 衝突' : '保存未完成'}</strong><span>{saveError || '遠端 timeline 已更新；目前 draft 保留。請保存或明確 Reload latest。'}</span></div>{conflict && <button className="secondary-button" onClick={() => void loadRemote(true)}><RefreshCw size={13} />Reload latest</button>}</div>}
          {capabilitiesError && <div className="timeline-alert is-info" role="status"><AlertCircle size={15} /><span>匯出能力查詢失敗：{capabilitiesError}；仍可編輯與保存 timeline。</span></div>}
          {capabilities && !capabilities.available && <div className="timeline-alert is-info" role="status"><AlertCircle size={15} /><span>系統 FFmpeg/FFprobe 不可用；可繼續編輯，請安裝 FFmpeg 後再匯出。</span></div>}
          {overLimit && <div className="timeline-alert is-info" role="alert"><AlertCircle size={15} /><span>已超過 timeline 資源限制（最多 {maxClips} clips、單片 {maxClipSeconds}s、總長 {maxTimelineSeconds}s）；請 trim 或 remove 後再保存。</span></div>}
          <div className="timeline-content">
            <section className="timeline-stage-panel" aria-label="timeline 預覽">
              <div className="timeline-stage-heading"><div><span className="panel-eyebrow">SEQUENTIAL PREVIEW</span><strong>{clips.length ? `${formatSeconds(playhead)} / ${formatSeconds(totalDuration)}` : '尚未加入片段'}</strong></div><span className="timeline-revision-badge">Timeline rev {timeline?.revision ?? 0}</span></div>
              <div className={`timeline-stage ${timeline?.format === 'portrait' ? 'is-portrait' : ''}`}>
                {currentClip ? <video ref={videoRef} key={currentClip.id} className="timeline-stage-video" src={artifactUrl(currentClip.artifact)} playsInline preload="metadata" onPlay={handleStagePlay} onPause={handleStagePause} onTimeUpdate={handleTimeUpdate} onEnded={handleTimeUpdate} aria-label="timeline 影片預覽" /> : <div className="timeline-stage-empty"><Film size={28} /><span>從右側 source picker 加入已保存影片</span></div>}
              </div>
              <div className="timeline-playback"><button className="primary-button" data-testid="timeline-play" aria-label={playing ? '暫停 timeline 預覽' : '播放 timeline 預覽'} disabled={!currentClip} onClick={togglePlayback}>{playing ? <Pause size={15} /> : <Play size={15} fill="currentColor" />}{playing ? 'Pause' : 'Play'}</button><input data-testid="timeline-scrub" aria-label="timeline 播放位置" type="range" min="0" max={Math.max(totalDuration, 0.01)} step="0.01" value={Math.min(playhead, totalDuration)} disabled={!clips.length} onChange={(event) => seekPreview(Number(event.target.value))} /><span>{formatSeconds(playhead)}</span></div>
              {sourceError && <p className="timeline-inline-error" role="alert"><AlertCircle size={13} />{sourceError}</p>}
            </section>
            <aside className="timeline-side-panel">
              <section className="timeline-source-panel"><div className="timeline-section-heading"><div><span className="panel-eyebrow">SOURCES / THIS BOARD</span><h3>成功影片</h3></div><span>{sources.length}</span></div>{sources.length === 0 ? <div className="timeline-empty-copy"><Film size={17} /><p>此 board 尚無成功影片。先完成一次影片執行，再回來加入。</p></div> : <div className="timeline-source-picker"><label className="timeline-source-select-label"><span>選擇影片來源</span><select data-testid="timeline-source" aria-label="選擇 timeline 影片來源" value={selectedSourceId} onChange={(event) => setSelectedSourceId(event.target.value)}><option value="">選擇影片</option>{sources.map((source) => <option key={source.id} value={source.id}>{sourceLabel(source)}</option>)}</select></label>{selectedSource && <div className="timeline-source-selected"><div className="timeline-source-icon"><Film size={15} /></div><div className="timeline-source-copy"><strong>{sourceLabel(selectedSource)}</strong><small>{selectedSource.artifact.localId || selectedSource.artifact.localUrl ? '已保存本機，可加入' : 'Remote-only，加入前會明確保存'}</small></div><button className={selectedSource.artifact.localId || selectedSource.artifact.localUrl ? 'secondary-button' : 'primary-button'} data-testid="timeline-add" disabled={sourceSaving === selectedSource.id || clips.length >= (capabilities?.limits.maxClips ?? 12)} onClick={() => void addSource(selectedSource)}>{sourceSaving === selectedSource.id ? <LoaderCircle className="spin" size={13} /> : selectedSource.artifact.localId || selectedSource.artifact.localUrl ? <Copy size={13} /> : <Save size={13} />}{selectedSource.artifact.localId || selectedSource.artifact.localUrl ? '加入' : '保存並加入'}</button></div>}</div>}</section>
              <section className="timeline-export-panel"><div className="timeline-section-heading"><div><span className="panel-eyebrow">POST PRODUCTION</span><h3>Export</h3></div><span className="timeline-export-version">v0.4.0</span></div><p className="timeline-export-copy">Export 會先保存目前 timeline snapshot。之後的編輯不會改變這次輸出。</p>{pendingExport && <div className="timeline-alert is-info" role="status"><AlertCircle size={15} /><div><strong>匯出提交尚未確認</strong><span>{pendingExportCanRetry ? '重試會沿用相同 operation；不會建立重複匯出。' : '目前 draft 已改變；請先明確開始新的 attempt。'}</span></div>{pendingExportCanRetry ? <button className="secondary-button" data-testid="timeline-recover-export" onClick={() => void startExport()}>恢復原提交</button> : <button className="secondary-button" data-testid="timeline-new-export-attempt" onClick={beginNewExportAttempt}>New attempt</button>}</div>}<button className="primary-button timeline-export-button" data-testid="timeline-export" disabled={!clips.length || hasInvalidClip || overLimit || saving || exportSaving || pendingExportBlocked || (capabilities !== undefined && !capabilities.available)} onClick={() => void startExport()}>{exportSaving ? <LoaderCircle className="spin" size={14} /> : <Film size={14} />}{exportSaving ? '提交中' : pendingExportCanRetry ? '恢復原提交' : pendingExportBlocked ? '先處理原提交' : '保存並匯出'}</button>{exportError && <p className="timeline-inline-error" role="alert"><AlertCircle size={13} />{exportError}</p>}{activeExport && <div className={`timeline-export-job is-${activeExport.status}`}><div><strong>{statusLabel(activeExport.status)}</strong><small>snapshot rev {activeExport.timelineRevision} · {new Date(activeExport.startedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</small></div>{activeExport.status === 'pending' || activeExport.status === 'running' ? <button className="secondary-button" data-testid="timeline-cancel-export" onClick={() => void cancelExport(activeExport)}>取消</button> : activeExport.status === 'succeeded' && activeExport.artifact?.localUrl ? <a className="secondary-button" data-testid={`timeline-download-${activeExport.id}`} href={activeExport.artifact.localUrl} download={`relay-${board.name}-timeline.mp4`}><Download size={13} />下載 MP4</a> : <button className="secondary-button" onClick={beginNewExportAttempt}><RefreshCw size={14} />New attempt</button>}{activeExport.status === 'succeeded' && activeExport.artifact?.localUrl && <video className="timeline-export-preview" src={activeExport.artifact.localUrl} controls playsInline preload="metadata" aria-label="匯出 MP4 預覽" />}{activeExport.error && <span className="timeline-job-error">{activeExport.error}</span>}</div>}</section>
              {boardExports.length > 0 && <section className="timeline-export-history"><span className="panel-eyebrow">RECENT EXPORTS</span>{boardExports.slice(0, 4).map((job) => <div className="timeline-export-history-row" key={job.id}><span className={`timeline-export-dot is-${job.status}`} /><span>{statusLabel(job.status)}</span><small>rev {job.timelineRevision} · {new Date(job.startedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}</small>{job.status === 'succeeded' && job.artifact?.localUrl && <a href={job.artifact.localUrl} download={`relay-${board.name}-timeline.mp4`} aria-label={`下載 ${job.id}`}><Download size={12} /></a>}</div>)}</section>}
              </aside>
          </div>
          <section className="timeline-track-panel"><div className="timeline-section-heading"><div><span className="panel-eyebrow">ORDERED TRACK / DRAG OR KEYBOARD</span><h3>剪輯片段</h3></div><div className="timeline-track-heading-actions"><span>{hasInvalidClip ? '需要修正' : `${formatSeconds(totalDuration)} total`}</span><label className="timeline-zoom-control"><span>Zoom</span><input id="timeline-zoom" data-testid="timeline-zoom" aria-label="時間軸縮放" type="range" min="32" max="180" step="8" value={timelineZoom} onChange={(event) => setTimelineZoom(Number(event.target.value))} /></label><output>{timelineZoom}px/s</output></div></div>{clips.length === 0 ? <div className="timeline-track-empty"><Scissors size={18} /><p>加入影片後，可拖曳排序、左右移動、duplicate、trim 或 remove。</p></div> : <><div className="timeline-time-track-scroll"><div className="timeline-time-editor" style={{ width: `${timelineTrackWidth}px` }}><div className="timeline-ruler" data-testid="timeline-ruler" aria-label="時間刻度" onClick={onTimelineTrackClick} onKeyDown={onTimelineTrackKeyDown} style={{ width: `${timelineTrackWidth}px` }}>{timelineRulerTicks.map((second) => <span className={`timeline-ruler-tick ${second % 5 === 0 ? 'is-major' : ''}`} key={second} style={{ left: `${second * timelineZoom}px` }}>{second % 5 === 0 ? formatSeconds(second) : ''}</span>)}</div><div className="timeline-time-track" data-testid="timeline-time-track" role="slider" tabIndex={0} aria-label="時間軸播放位置" aria-valuemin={0} aria-valuemax={totalDuration} aria-valuenow={Math.min(playhead, totalDuration)} aria-valuetext={`${formatSeconds(playhead)} / ${formatSeconds(totalDuration)}`} onClick={onTimelineTrackClick} onKeyDown={onTimelineTrackKeyDown} style={{ width: `${timelineTrackWidth}px` }}><div className="timeline-track-grid" style={{ backgroundSize: `${timelineZoom}px 100%` }} aria-hidden="true" />{clips.map((clip, index) => { const offset = clips.slice(0, index).reduce((sum, item) => sum + Math.max(0, item.outSeconds - item.inSeconds), 0); const duration = Math.max(0, clip.outSeconds - clip.inSeconds); return <div className="timeline-segment" data-testid={`timeline-segment-${clip.id}`} key={clip.id} draggable onDragStart={(event) => onClipDragStart(event, index)} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }} onDrop={(event) => onClipDrop(event, index)} role="group" tabIndex={0} aria-current={index === activeClipIndex ? 'true' : undefined} aria-label={`片段 ${index + 1}，${formatSeconds(duration)}`} style={{ left: `${offset * timelineZoom}px`, width: `${Math.max(10, duration * timelineZoom)}px` }}><div className="timeline-segment-body"><span>{String(index + 1).padStart(2, '0')}</span><small>{formatSeconds(duration)}</small></div><button type="button" className="timeline-trim-handle timeline-trim-handle-in" data-testid={`timeline-trim-in-${clip.id}`} aria-label={`片段 ${index + 1} 調整入點`} draggable={false} onPointerDown={(event) => onTrimPointerDown(event, clip, 'inSeconds')} onPointerMove={onTrimPointerMove} onPointerUp={onTrimPointerEnd} onPointerCancel={onTrimPointerEnd} onLostPointerCapture={onTrimPointerEnd} onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}><span aria-hidden="true" /></button><button type="button" className="timeline-trim-handle timeline-trim-handle-out" data-testid={`timeline-trim-out-${clip.id}`} aria-label={`片段 ${index + 1} 調整出點`} draggable={false} onPointerDown={(event) => onTrimPointerDown(event, clip, 'outSeconds')} onPointerMove={onTrimPointerMove} onPointerUp={onTrimPointerEnd} onPointerCancel={onTrimPointerEnd} onLostPointerCapture={onTrimPointerEnd} onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}><span aria-hidden="true" /></button></div>; })}<div className="timeline-playhead" data-testid="timeline-playhead" aria-label={`播放位置 ${formatSeconds(playhead)}`} style={{ left: `${Math.min(totalDuration, Math.max(0, playhead)) * timelineZoom}px` }}><span /></div></div></div></div><div className="timeline-clip-track">{clips.map((clip, index) => <ClipCard key={clip.id} clip={clip} index={index} total={clips.length} onDragStart={onClipDragStart} onDrop={onClipDrop} onMove={moveClip} onDuplicate={duplicateClip} onRemove={removeClip} onTrim={updateTrim} />)}</div></>}</section>
        </>}
        <footer className="timeline-dialog-foot"><span><kbd>Esc</kbd> 關閉；dirty 時會先保存</span><span className="timeline-save-state">{saving ? '正在保存…' : dirty ? '有未保存編輯' : <><Check size={12} />已保存</>}</span><button className="ghost-button" onClick={() => void closeEditor()} disabled={saving}>Close</button></footer>
      </section>
    </div>
  );
}
