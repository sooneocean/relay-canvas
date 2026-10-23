import {
  AlertCircle,
  Check,
  ChevronDown,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Artifact, CanonicalNodeResult, Run, RunComparison } from '../shared/types.js';
import { validateTimelineHandoff, type TimelineHandoffIntent, type UiRequest } from './TimelineEditor.js';
import useModalFocus from './useModalFocus.js';

type RunCompareProps = {
  boardId: string;
  runs: Run[];
  requestJson: UiRequest;
  onClose: () => void;
  onUseInTimeline?: (intent: TimelineHandoffIntent) => Promise<boolean> | boolean;
};

type Side = 'left' | 'right';
type VideoRef = HTMLVideoElement | null;
type MediaHandler = (side: Side, video: HTMLVideoElement, identity: string) => void;
type DurationHandler = (side: Side, artifactIndex: number, video: HTMLVideoElement, duration: number, identity: string) => void;

const terminalStatuses = new Set<Run['status']>(['succeeded', 'failed', 'cancelled', 'interrupted', 'needs_review']);

function statusLabel(status: Run['status']): string {
  switch (status) {
    case 'succeeded': return '已完成';
    case 'failed': return '失敗';
    case 'cancelled': return '已取消';
    case 'interrupted': return '已中斷';
    case 'needs_review': return '需要檢視';
    case 'running': return '執行中';
    default: return status;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '讀取比較失敗，請稍後重試。';
}

function makeToken(): string {
  return globalThis.crypto?.randomUUID?.() ?? `handoff-${Math.random().toString(36).slice(2, 12)}`;
}

function durationKey(side: Side, runId: string, nodeId: string, artifactIndex: number, canonicalUrl: string): string {
  return `${side}\u0000${runId}\u0000${nodeId}\u0000${artifactIndex}\u0000${canonicalUrl}`;
}

function exactArtifact(runs: Run[], runId: string, nodeId: string, index: number, canonical?: { kind: Artifact['kind']; url: string }): Artifact | undefined {
  const run = runs.find((candidate) => candidate.id === runId);
  const artifact = run?.results[nodeId]?.artifacts[index];
  if (!artifact || !canonical || artifact.kind !== canonical.kind || artifact.url !== canonical.url) return undefined;
  return artifact;
}

function outputIdentity(runs: Run[], runId: string, nodeId: string): string {
  const result = runs.find((run) => run.id === runId)?.results[nodeId];
  return result ? `${result.status}:${result.artifacts.map((artifact, index) => `${index}:${artifact.kind}:${artifact.url}:${artifact.localUrl ?? ''}`).join('|')}` : '';
}

function canonicalNode(run: Run | undefined, nodeId: string): CanonicalNodeResult | undefined {
  return run?.results[nodeId];
}

function canonicalOutputIdentity(result: CanonicalNodeResult | undefined): string {
  return result ? `${result.status}:${result.artifacts.map((artifact, index) => `${index}:${artifact.kind}:${artifact.url}`).join('|')}` : '';
}

function formatTime(value?: string): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-TW') : value;
}

function paramsText(value: unknown): string {
  if (value === undefined) return '—';
  try { return JSON.stringify(value, null, 2); } catch { return '無法顯示參數'; }
}

function Output({
  runId,
  nodeId,
  result,
  currentRuns,
  side,
  mediaIdentity,
  startedAt,
  durationByArtifact,
  pendingHandoff,
  boardId,
  onUseInTimeline,
  onVideo,
  onDuration,
  onTimeUpdate,
  onPlay,
  onPause,
  onEnded,
}: {
  runId: string;
  nodeId: string;
  result?: CanonicalNodeResult;
  currentRuns: Run[];
  side: Side;
  mediaIdentity: string;
  startedAt?: string;
  durationByArtifact: Record<string, number>;
  pendingHandoff: boolean;
  boardId: string;
  onUseInTimeline?: (intent: TimelineHandoffIntent) => Promise<boolean> | boolean;
  onVideo: (side: Side, video: VideoRef, identity: string) => void;
  onDuration: DurationHandler;
  onTimeUpdate: MediaHandler;
  onPlay: MediaHandler;
  onPause: MediaHandler;
  onEnded: MediaHandler;
}) {
  if (!result) return <div className="compare-missing"><AlertCircle size={16} /><span>此 run 沒有這個 node 的結果。</span></div>;
  if (result.status !== 'succeeded') return <div className="compare-missing"><AlertCircle size={16} /><span>結果狀態：{statusLabel(result.status)}{result.error ? ` · ${result.error}` : ''}</span></div>;
  if (!result.artifacts.length) return <div className="compare-missing"><AlertCircle size={16} /><span>此 node 沒有輸出 artifact。</span></div>;
  return <div className="compare-output-list">{result.artifacts.map((canonical, index) => {
    const current = exactArtifact(currentRuns, runId, nodeId, index, canonical);
    const url = current?.localUrl ?? canonical.url;
    const label = `${side === 'left' ? 'A' : 'B'} output ${index + 1}`;
    const intentBase: TimelineHandoffIntent = { token: '', originBoardId: boardId, source: { runId, nodeId, artifactIndex: index }, canonical: { kind: canonical.kind, url: canonical.url } };
    const eligibility = validateTimelineHandoff(intentBase, boardId, currentRuns);
    const duration = durationByArtifact[durationKey(side, runId, nodeId, index, canonical.url)];
    const durationLabel = duration !== undefined && Number.isFinite(duration) && duration > 0 ? `${duration.toFixed(2)}s` : '時長未知';
    const useInTimeline = () => {
      if (!eligibility.ok || !onUseInTimeline || pendingHandoff) return;
      const intent = { ...intentBase, token: makeToken() };
      void Promise.resolve(onUseInTimeline(intent)).catch(() => false);
    };
    return <div className="compare-output" key={`${canonical.kind}-${index}`}>
      <div className="compare-output-label"><strong>{canonical.demo ? 'DEMO' : canonical.kind.toUpperCase()} · output {index + 1}</strong><small>{nodeId} · {startedAt ? formatTime(startedAt) : '執行時間未知'}</small><small>{durationLabel}</small></div>
      {canonical.kind === 'image' ? <img src={url} alt={label} referrerPolicy="no-referrer" crossOrigin="anonymous" /> : <video ref={(element) => { if (index === 0) onVideo(side, element, mediaIdentity); }} src={url} playsInline preload="metadata" aria-label={label} onLoadedMetadata={(event) => { if (Number.isFinite(event.currentTarget.duration)) onDuration(side, index, event.currentTarget, event.currentTarget.duration, mediaIdentity); }} onTimeUpdate={(event) => { if (index === 0) onTimeUpdate(side, event.currentTarget, mediaIdentity); }} onPlay={(event) => { if (index === 0) onPlay(side, event.currentTarget, mediaIdentity); }} onPause={(event) => { if (index === 0) onPause(side, event.currentTarget, mediaIdentity); }} onEnded={(event) => { if (index === 0) onEnded(side, event.currentTarget, mediaIdentity); }} onError={() => undefined} />}
      {current?.localUrl && <small className="compare-local-badge"><Check size={11} />本機保存</small>}
      <div className="compare-output-handoff"><button type="button" data-testid={`compare-timeline-${side}-${index}`} className="secondary-button" disabled={!eligibility.ok || pendingHandoff || !onUseInTimeline} onClick={useInTimeline}>在時間軸使用</button>{!eligibility.ok && <small role="status">{eligibility.reason}</small>}</div>
    </div>;
  })}</div>;
}

function RunMeta({ run, nodeId, result }: { run: Run; nodeId: string; result?: CanonicalNodeResult }) {
  const node = run.snapshot.nodes.find((candidate) => candidate.id === nodeId);
  const providerId = node?.data.providerId ?? '—';
  const model = node?.data.model ?? '—';
  return <div className="compare-meta-grid"><div><span>STATUS</span><strong>{statusLabel(result?.status ?? run.status)}</strong></div><div><span>RUN STARTED</span><strong>{formatTime(run.startedAt)}</strong></div><div><span>CANVAS REV</span><strong>{run.revision}</strong></div><div><span>PROVIDER</span><strong>{providerId}</strong></div><div><span>MODEL</span><strong>{model}</strong></div><div className="compare-meta-wide"><span>PROMPT</span><p>{node?.data.prompt || '—'}</p></div><div className="compare-meta-wide"><span>PARAMS</span><pre>{paramsText(node?.data.params)}</pre></div></div>;
}

export default function RunCompare({ boardId, runs, requestJson, onClose, onUseInTimeline }: RunCompareProps) {
  const dialogRef = useModalFocus<HTMLElement>();
  const boardRuns = useMemo(() => runs.filter((run) => run.boardId === boardId), [boardId, runs]);
  const [leftId, setLeftId] = useState('');
  const [rightId, setRightId] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [comparison, setComparison] = useState<RunComparison>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [durations, setDurations] = useState({ left: 0, right: 0 });
  const [durationByArtifact, setDurationByArtifact] = useState<Record<string, number>>({});
  const [pendingHandoff, setPendingHandoff] = useState(false);
  const leftVideoRef = useRef<VideoRef>(null);
  const rightVideoRef = useRef<VideoRef>(null);
  const videoIdentityRef = useRef<{ left?: string; right?: string }>({});
  const mediaIdentityRef = useRef('');
  const durationsRef = useRef({ left: 0, right: 0 });
  const endedRef = useRef({ left: false, right: false });
  const playingRef = useRef(false);
  const playbackAttemptRef = useRef(0);
  const requestVersionRef = useRef(0);

  const terminalRuns = useMemo(() => boardRuns.filter((run) => terminalStatuses.has(run.status)), [boardRuns]);
  useEffect(() => {
    if (!leftId || !terminalRuns.some((run) => run.id === leftId)) setLeftId(terminalRuns[0]?.id ?? '');
    if (!rightId || !terminalRuns.some((run) => run.id === rightId) || rightId === leftId) setRightId(terminalRuns.find((run) => run.id !== (leftId || terminalRuns[0]?.id))?.id ?? '');
  }, [leftId, rightId, terminalRuns]);

  const mediaIdentity = `${leftId}\u0000${rightId}\u0000${nodeId}\u0000${outputIdentity(runs, leftId, nodeId)}\u0000${outputIdentity(runs, rightId, nodeId)}\u0000${canonicalOutputIdentity(canonicalNode(comparison?.left, nodeId))}\u0000${canonicalOutputIdentity(canonicalNode(comparison?.right, nodeId))}`;
  mediaIdentityRef.current = mediaIdentity;

  const leftRun = comparison?.left ?? boardRuns.find((run) => run.id === leftId);
  const rightRun = comparison?.right ?? boardRuns.find((run) => run.id === rightId);
  const nodeIds = useMemo(() => {
    const values = [...(leftRun?.snapshot.nodes ?? []), ...(rightRun?.snapshot.nodes ?? [])].map((node) => node.id);
    return [...new Set(values)];
  }, [leftRun, rightRun]);
  useEffect(() => { if (!nodeIds.includes(nodeId)) setNodeId(nodeIds[0] ?? ''); }, [nodeId, nodeIds]);

  const fetchComparison = useCallback(async () => {
    if (!leftId || !rightId || leftId === rightId) { setComparison(undefined); return; }
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    setError('');
    try {
      const result = await requestJson<RunComparison>(`/api/boards/${encodeURIComponent(boardId)}/compare?left=${encodeURIComponent(leftId)}&right=${encodeURIComponent(rightId)}`);
      if (requestVersion !== requestVersionRef.current) return;
      setComparison(result);
    } catch (requestError) {
      if (requestVersion === requestVersionRef.current) setError(errorText(requestError));
    } finally {
      if (requestVersion === requestVersionRef.current) setLoading(false);
    }
  }, [boardId, leftId, requestJson, rightId]);

  useEffect(() => { void fetchComparison(); }, [fetchComparison]);
  useEffect(() => () => {
    requestVersionRef.current += 1;
    playbackAttemptRef.current += 1;
    [leftVideoRef.current, rightVideoRef.current].forEach((video) => video?.pause());
    mediaIdentityRef.current = '';
  }, []);

  useEffect(() => {
    playbackAttemptRef.current += 1;
    [leftVideoRef.current, rightVideoRef.current].forEach((video) => video?.pause());
    playingRef.current = false;
    endedRef.current = { left: false, right: false };
    durationsRef.current = { left: 0, right: 0 };
    setPlaying(false);
    setCurrentTime(0);
    setDurations({ left: 0, right: 0 });
  }, [mediaIdentity]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setVideo = useCallback((side: Side, video: VideoRef, identity: string) => {
    if (identity !== mediaIdentityRef.current) return;
    if (!video) return;
    const previous = side === 'left' ? leftVideoRef.current : rightVideoRef.current;
    if (side === 'left') leftVideoRef.current = video;
    else rightVideoRef.current = video;
    videoIdentityRef.current[side] = video ? identity : undefined;
    if (previous !== video) endedRef.current[side] = false;
  }, []);

  const isCurrentVideo = useCallback((side: Side, video: HTMLVideoElement, identity: string) => {
    if (identity !== mediaIdentityRef.current || videoIdentityRef.current[side] !== identity) return false;
    return video.isConnected && (side === 'left' ? leftVideoRef.current : rightVideoRef.current) === video;
  }, []);

  const currentEntries = useCallback(() => [
    { side: 'left' as const, video: leftVideoRef.current },
    { side: 'right' as const, video: rightVideoRef.current },
  ].filter((entry): entry is { side: Side; video: HTMLVideoElement } => entry.video !== null && videoIdentityRef.current[entry.side] === mediaIdentityRef.current && entry.video.isConnected), []);

  const setDuration = useCallback((side: Side, artifactIndex: number, video: HTMLVideoElement, duration: number, identity: string) => {
    if (!Number.isFinite(duration) || duration <= 0 || identity !== mediaIdentityRef.current) return;
    const currentRunId = side === 'left' ? leftId : rightId;
    setDurationByArtifact((current) => ({ ...current, [durationKey(side, currentRunId, nodeId, artifactIndex, canonicalNode(side === 'left' ? comparison?.left : comparison?.right, nodeId)?.artifacts[artifactIndex]?.url ?? video.currentSrc)] : duration }));
    if (artifactIndex !== 0 || !isCurrentVideo(side, video, identity)) return;
    durationsRef.current = { ...durationsRef.current, [side]: duration };
    setDurations((current) => ({ ...current, [side]: duration }));
  }, [comparison, isCurrentVideo, leftId, nodeId, rightId]);

  const updateMediaClock = useCallback(() => {
    const videos = currentEntries().map(({ video }) => video);
    if (!videos.length) return;
    const currentValues = videos.map((video) => Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0);
    const knownDuration = Math.max(durationsRef.current.left, durationsRef.current.right, ...videos.map((video) => Number.isFinite(video.duration) ? video.duration : 0));
    const next = Math.max(...currentValues);
    setCurrentTime(knownDuration > 0 ? Math.min(next, knownDuration) : next);
  }, [currentEntries]);

  const handleTimeUpdate = useCallback((side: Side, video: HTMLVideoElement, identity: string) => {
    if (!isCurrentVideo(side, video, identity)) return;
    updateMediaClock();
  }, [isCurrentVideo, updateMediaClock]);

  const handlePlay = useCallback((side: Side, video: HTMLVideoElement, identity: string) => {
    if (!isCurrentVideo(side, video, identity)) return;
    playingRef.current = true;
    setPlaying(true);
  }, [isCurrentVideo]);

  const handlePause = useCallback((side: Side, video: HTMLVideoElement, identity: string) => {
    if (!isCurrentVideo(side, video, identity) || !playingRef.current) return;
    const otherSide: Side = side === 'left' ? 'right' : 'left';
    const otherVideos = currentEntries()
      .filter(({ side: entrySide }) => entrySide === otherSide)
      .map(({ video: candidate }) => candidate);
    const currentDuration = durationsRef.current[side] || (Number.isFinite(video.duration) ? video.duration : 0);
    if (video.ended || (currentDuration > 0 && video.currentTime >= currentDuration - 0.04)) {
      const otherHasRemaining = otherVideos.some((candidate) => {
        const duration = durationsRef.current[otherSide] || (Number.isFinite(candidate.duration) ? candidate.duration : 0);
        return !candidate.ended && !(duration > 0 && candidate.currentTime >= duration - 0.04);
      });
      if (otherHasRemaining) return;
    }
    if (otherVideos.some((candidate) => !candidate.paused && !candidate.ended)) return;
    playingRef.current = false;
    setPlaying(false);
  }, [currentEntries, isCurrentVideo]);

  const handleEnded = useCallback((side: Side, video: HTMLVideoElement, identity: string) => {
    if (!isCurrentVideo(side, video, identity)) return;
    endedRef.current[side] = true;
    updateMediaClock();
    const entries = currentEntries();
    const allEnded = entries.length > 0 && entries.every(({ side: entrySide, video: entryVideo }) => {
      const duration = durationsRef.current[entrySide] || (Number.isFinite(entryVideo.duration) ? entryVideo.duration : 0);
      return endedRef.current[entrySide] || entryVideo.ended || (duration > 0 && entryVideo.currentTime >= duration - 0.04);
    });
    if (allEnded) {
      playbackAttemptRef.current += 1;
      entries.forEach((entry) => entry.video.pause());
      playingRef.current = false;
      setPlaying(false);
      setCurrentTime(Math.max(durationsRef.current.left, durationsRef.current.right, ...entries.map((entry) => Number.isFinite(entry.video.duration) ? entry.video.duration : 0)));
    } else if (playingRef.current) {
      setPlaying(true);
    }
  }, [currentEntries, isCurrentVideo, updateMediaClock]);

  const togglePlay = useCallback(() => {
    const entries = currentEntries();
    if (!entries.length) return;
    if (playingRef.current || playing) {
      playbackAttemptRef.current += 1;
      playingRef.current = false;
      setPlaying(false);
      entries.forEach((entry) => entry.video.pause());
      return;
    }
    const allEnded = entries.every(({ side, video }) => {
      const duration = durationsRef.current[side] || (Number.isFinite(video.duration) ? video.duration : 0);
      return endedRef.current[side] || video.ended || (duration > 0 && video.currentTime >= duration - 0.04);
    });
    if (allEnded) {
      entries.forEach((entry) => {
        entry.video.pause();
        try { entry.video.currentTime = 0; } catch { /* media may still be loading */ }
        endedRef.current[entry.side] = false;
      });
      setCurrentTime(0);
    }
    const identity = mediaIdentityRef.current;
    const attempt = ++playbackAttemptRef.current;
    playingRef.current = true;
    setPlaying(true);
    void Promise.all(entries.map((entry) => entry.video.play())).catch(() => {
      if (identity !== mediaIdentityRef.current || attempt !== playbackAttemptRef.current) return;
      entries.forEach((entry) => entry.video.pause());
      playingRef.current = false;
      setPlaying(false);
    });
  }, [currentEntries, playing]);

  const seek = useCallback((value: number) => {
    const maxDuration = Math.max(durationsRef.current.left, durationsRef.current.right);
    const next = Math.max(0, maxDuration > 0 ? Math.min(value, maxDuration) : value);
    setCurrentTime(next);
    endedRef.current = { left: false, right: false };
    currentEntries().forEach(({ side, video }) => {
      const duration = durationsRef.current[side] || (Number.isFinite(video.duration) ? video.duration : 0);
      try { video.currentTime = duration > 0 ? Math.min(next, duration) : next; } catch { /* media may still be loading */ }
    });
    if (!playingRef.current) return;
    const identity = mediaIdentityRef.current;
    const attempt = ++playbackAttemptRef.current;
    const entries = currentEntries();
    const playable = entries.filter(({ side, video }) => {
      const duration = durationsRef.current[side] || (Number.isFinite(video.duration) ? video.duration : 0);
      return duration <= 0 || next < duration;
    });
    if (!playable.length) {
      playingRef.current = false;
      setPlaying(false);
      return;
    }
    void Promise.all(playable.map(({ video }) => video.play())).catch(() => {
      if (identity !== mediaIdentityRef.current || attempt !== playbackAttemptRef.current) return;
      entries.forEach(({ video }) => video.pause());
      playingRef.current = false;
      setPlaying(false);
    });
  }, [currentEntries]);

  const leftResult = leftRun ? canonicalNode(leftRun, nodeId) : undefined;
  const rightResult = rightRun ? canonicalNode(rightRun, nodeId) : undefined;
  const requestHandoff = useCallback(async (intent: TimelineHandoffIntent): Promise<boolean> => {
    if (!onUseInTimeline || pendingHandoff) return false;
    setPendingHandoff(true);
    try {
      const accepted = await onUseInTimeline(intent);
      if (!accepted) setPendingHandoff(false);
      return accepted;
    } catch {
      setPendingHandoff(false);
      return false;
    }
  }, [onUseInTimeline, pendingHandoff]);

  return <div className="dialog-scrim compare-scrim" role="presentation"><section ref={dialogRef} className="compare-dialog" data-testid="compare-dialog" role="dialog" aria-modal="true" aria-labelledby="compare-title">
    <header className="compare-dialog-head"><div><span className="panel-eyebrow">READ ONLY / v0.5.0</span><h2 id="compare-title">Compare generation runs</h2><p>只讀查看同一 board 的 immutable run；不會重畫 canvas 或觸發 generation。</p></div><button className="icon-button" data-modal-close data-testid="compare-close" aria-label="關閉版本比較" onClick={onClose}><X size={17} /></button></header>
    <div className="compare-selectors"><label><span>Run A</span><select data-testid="compare-left-run" aria-label="選擇 Run A" value={leftId} onChange={(event) => setLeftId(event.target.value)}><option value="">選擇 terminal run</option>{boardRuns.map((run) => <option key={run.id} value={run.id} disabled={!terminalStatuses.has(run.status)}>{run.id.slice(0, 12)} · rev {run.revision} · {statusLabel(run.status)}{terminalStatuses.has(run.status) ? '' : ' · active'}</option>)}</select></label><ChevronDown size={15} className="compare-selector-arrow" /><label><span>Run B</span><select data-testid="compare-right-run" aria-label="選擇 Run B" value={rightId} onChange={(event) => setRightId(event.target.value)}><option value="">選擇 terminal run</option>{boardRuns.map((run) => <option key={run.id} value={run.id} disabled={!terminalStatuses.has(run.status) || run.id === leftId}>{run.id.slice(0, 12)} · rev {run.revision} · {statusLabel(run.status)}{terminalStatuses.has(run.status) ? '' : ' · active'}</option>)}</select></label><label><span>Node</span><select data-testid="compare-node" aria-label="選擇比較節點" value={nodeId} onChange={(event) => setNodeId(event.target.value)} disabled={!nodeIds.length}><option value="">選擇 node</option>{nodeIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label></div>
    {loading ? <div className="compare-state"><LoaderCircle className="spin" size={22} /><strong>讀取 comparison…</strong></div> : error ? <div className="compare-state is-error" role="alert"><AlertCircle size={19} /><strong>無法比較這兩筆 run</strong><p>{error}</p><button className="secondary-button" onClick={() => void fetchComparison()}><RefreshCw size={14} />重試</button></div> : !comparison || !leftRun || !rightRun ? <div className="compare-state"><AlertCircle size={20} /><strong>請選擇兩筆不同的 terminal run</strong><p>pending / submitting / running 會被保留在清單中，但 API 會拒絕 active comparison。</p></div> : <>
      <div className="compare-summary"><span>A · rev {leftRun.revision} · {statusLabel(leftRun.status)} · {formatTime(leftRun.startedAt)}</span><span>↔</span><span>B · rev {rightRun.revision} · {statusLabel(rightRun.status)} · {formatTime(rightRun.startedAt)}</span></div>
      <div className="compare-differences" data-testid="compare-differences"><span className="panel-eyebrow">DIFFERENCES</span>{comparison.differences.length ? comparison.differences.map((difference) => <button className={difference.nodeId === nodeId ? 'is-active' : ''} key={difference.nodeId} onClick={() => setNodeId(difference.nodeId)}><strong>{difference.nodeId}</strong><span>{difference.fields.join(' · ')}</span></button>) : <p><Check size={13} />這兩筆 run 沒有可見差異。</p>}</div>
      <div className="compare-columns"><article className="compare-side compare-side-a"><div className="compare-side-heading"><span className="compare-run-letter">A</span><div><strong>{leftRun.id.slice(0, 12)}</strong><small>{statusLabel(leftRun.status)} · revision {leftRun.revision}</small></div></div><RunMeta run={leftRun} nodeId={nodeId} result={leftResult} /><Output boardId={boardId} runId={leftRun.id} nodeId={nodeId} result={leftResult} currentRuns={runs} side="left" mediaIdentity={mediaIdentity} startedAt={leftRun.startedAt} durationByArtifact={durationByArtifact} pendingHandoff={pendingHandoff} onUseInTimeline={requestHandoff} onVideo={setVideo} onDuration={setDuration} onTimeUpdate={handleTimeUpdate} onPlay={handlePlay} onPause={handlePause} onEnded={handleEnded} /></article><article className="compare-side compare-side-b"><div className="compare-side-heading"><span className="compare-run-letter">B</span><div><strong>{rightRun.id.slice(0, 12)}</strong><small>{statusLabel(rightRun.status)} · revision {rightRun.revision}</small></div></div><RunMeta run={rightRun} nodeId={nodeId} result={rightResult} /><Output boardId={boardId} runId={rightRun.id} nodeId={nodeId} result={rightResult} currentRuns={runs} side="right" mediaIdentity={mediaIdentity} startedAt={rightRun.startedAt} durationByArtifact={durationByArtifact} pendingHandoff={pendingHandoff} onUseInTimeline={requestHandoff} onVideo={setVideo} onDuration={setDuration} onTimeUpdate={handleTimeUpdate} onPlay={handlePlay} onPause={handlePause} onEnded={handleEnded} /></article></div>
      <div className="compare-video-controls"><button className="primary-button" data-testid="compare-play" onClick={togglePlay}><span>{playing ? <Pause size={14} /> : <Play size={14} fill="currentColor" />}</span>{playing ? 'Pause videos' : 'Play videos'}</button><input data-testid="compare-scrub" aria-label="比較影片播放位置" type="range" min="0" max={Math.max(durations.left, durations.right, 0.01)} step="0.01" value={Math.min(currentTime, Math.max(durations.left, durations.right, 0.01))} onChange={(event) => seek(Number(event.target.value))} /><span>{currentTime.toFixed(2)}s</span>{durations.left !== durations.right && (durations.left || durations.right) > 0 && <small>不同長度：A {durations.left.toFixed(2)}s / B {durations.right.toFixed(2)}s</small>}</div>
      <div className="compare-dialog-foot"><span>prompt、provider/model、params 與 outputs 皆依選定 run/node exact identity 顯示。</span><button className="ghost-button" onClick={onClose}>Close</button></div>
    </>}
  </section></div>;
}
