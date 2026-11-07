import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, Download, LoaderCircle, Play, Square, X } from 'lucide-react';
import type {
  Artifact, DexSrBundle, DexSrReferenceRole, ExportJob, LocalAsset, Run,
} from '../shared/types.js';
import './DexSrStudio.css';

type ApiRequest = <T>(path: string, init?: RequestInit) => Promise<T>;
type MediaChoice = { hash: string; label: string; url: string; artifact: Artifact };
interface PlanResponse {
  status: 'plan_only'; current: { sha256: string; duration: number; width: number; height: number };
  previousSegment?: { sha256: string; duration: number };
  originals: Array<{ sha256: string; role: string; pixelTransfer: string }>;
  promptPolicy: { intent: string; temporalStrength: number; referenceStrength: number; allowGeneration: false };
}
interface Capabilities {
  available: boolean; engine: string; maxSeconds: number; outputFormat: string;
}

function choices(boardId: string, localAssets: LocalAsset[], runs: Run[], kind: 'video' | 'image'): MediaChoice[] {
  const output = new Map<string, MediaChoice>();
  for (const asset of localAssets) {
    const a = asset.artifact;
    if (asset.boardId === boardId && a.kind === kind && a.localId && a.sha256 === a.localId && a.localUrl) {
      output.set(a.localId, { hash: a.localId, label: asset.name, url: a.localUrl, artifact: a });
    }
  }
  // Only videos can be derived from completed runs; source stills must be imported originals.
  if (kind === 'video') for (const run of runs) {
    if (run.boardId !== boardId || run.status !== 'succeeded') continue;
    for (const [nodeId, result] of Object.entries(run.results)) {
      if (result.status !== 'succeeded') continue;
      for (const [index, artifact] of result.artifacts.entries()) {
        if (artifact.kind !== kind || !artifact.localId || artifact.localId !== artifact.sha256 || !artifact.localUrl) continue;
        if (!output.has(artifact.localId)) {
          output.set(artifact.localId, {
            hash: artifact.localId, label: '已保存生成片段／' + nodeId + ' #' + index,
            url: artifact.localUrl, artifact,
          });
        }
      }
    }
  }
  return [...output.values()];
}
const options: Array<{ value: DexSrReferenceRole; label: string }> = [
  { value: 'identity', label: '人物身分（只做參考，不貼臉）' },
  { value: 'detail', label: '同視角細節（符合配準才可用）' },
  { value: 'scene', label: '場景原圖（符合配準才可用）' },
  { value: 'color', label: '色彩參考（只記錄，不自動調色）' },
];

export default function DexSrStudio({
  boardId, localAssets, runs, exports: jobs, requestJson, onJob, onClose,
}: {
  boardId: string; localAssets: LocalAsset[]; runs: Run[]; exports: ExportJob[];
  requestJson: ApiRequest; onJob: (job: ExportJob) => void; onClose: () => void;
}) {
  const videoOptions = useMemo(() => choices(boardId, localAssets, runs, 'video'), [boardId, localAssets, runs]);
  const imageOptions = useMemo(() => choices(boardId, localAssets, runs, 'image'), [boardId, localAssets, runs]);
  const [current, setCurrent] = useState('');
  const [previous, setPrevious] = useState('');
  const [originals, setOriginals] = useState<Record<string, DexSrReferenceRole>>({});
  const [prompt, setPrompt] = useState('保真，保持五官、服裝、髮型與場景；保留自然顆粒；不要生成新細節。');
  const [radius, setRadius] = useState<0 | 1 | 2>(2);
  const [plan, setPlan] = useState<PlanResponse>();
  const [cap, setCap] = useState<Capabilities>();
  const [busy, setBusy] = useState<'plan' | 'start' | 'cancel'>();
  const [error, setError] = useState('');
  const [jobId, setJobId] = useState<string>();
  const beforeVideo = useRef<HTMLVideoElement>(null);
  const afterVideo = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let mounted = true;
    void requestJson<Capabilities>('/api/dex-sr/capabilities')
      .then(value => { if (mounted) setCap(value); })
      .catch(() => { if (mounted) setCap({ available: false, engine: 'precision-temporal-vsr', maxSeconds: 8, outputFormat: 'video/mp4' }); });
    return () => { mounted = false; };
  }, [requestJson]);

  useEffect(() => { setPlan(undefined); setError(''); }, [current, previous, originals, prompt, radius]);

  const bundle: DexSrBundle = {
    schemaVersion: 1,
    currentVideo: { artifactSha256: current },
    ...(previous ? { previousSegment: { artifactSha256: previous } } : {}),
    originals: Object.entries(originals).map(([artifactSha256, role]) => ({ artifactSha256, role })),
    prompt, temporalRadius: radius, targetHeight: 1080,
  };
  const selected = videoOptions.find(v => v.hash === current);
  const activeJob = jobs.find(j => j.id === jobId) ??
    jobs.find(j => j.boardId === boardId && j.dexSr?.request.currentVideo.artifactSha256 === current);
  const latestJobId = activeJob?.id;

  useEffect(() => {
    if (!latestJobId || !activeJob || !['pending', 'running'].includes(activeJob.status)) return;
    let disposed = false, polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const updated = await requestJson<ExportJob>('/api/exports/' + encodeURIComponent(latestJobId));
        if (!disposed) onJob(updated);
      } catch { /* Never auto-restart a failed or interrupted job. */ }
      finally { polling = false; }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 2500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [latestJobId, activeJob?.status, onJob, requestJson]);

  const analyze = async () => {
    if (!current || Object.keys(originals).length < 1 || busy) return;
    setBusy('plan'); setError(''); setPlan(undefined);
    try {
      const response = await requestJson<PlanResponse>(
        '/api/boards/' + encodeURIComponent(boardId) + '/dex-sr/plan',
        { method: 'POST', body: JSON.stringify(bundle) },
      );
      setPlan(response);
    } catch (e) { setError('來源驗證失敗：' + (e instanceof Error ? e.message : '請確認影片與原始圖片。')); }
    finally { setBusy(undefined); }
  };
  const submit = async () => {
    if (!plan || !current || !cap?.available || busy) return;
    setBusy('start'); setError('');
    try {
      const job = await requestJson<ExportJob>(
        '/api/boards/' + encodeURIComponent(boardId) + '/dex-sr/jobs',
        { method: 'POST', body: JSON.stringify({ operationId: window.crypto.randomUUID(), bundle }) },
      );
      setJobId(job.id); onJob(job);
    } catch (e) { setError('無法啟動修復：' + (e instanceof Error ? e.message : '本機工作服務不可用。')); }
    finally { setBusy(undefined); }
  };
  const cancel = async () => {
    if (!activeJob || busy || !['pending', 'running'].includes(activeJob.status)) return;
    setBusy('cancel');
    try {
      const job = await requestJson<ExportJob>('/api/exports/' + encodeURIComponent(activeJob.id) + '/cancel', { method: 'POST', body: '{}' });
      onJob(job);
    } catch (e) { setError('取消失敗：' + (e instanceof Error ? e.message : '請重試')); }
    finally { setBusy(undefined); }
  };
  const togglePlay = () => {
    const a = beforeVideo.current, b = afterVideo.current;
    if (!a || !b) return;
    if (!a.paused || !b.paused) { a.pause(); b.pause(); return; }
    b.currentTime = a.currentTime;
    void a.play().catch(() => undefined);
    void b.play().catch(() => undefined);
  };
  const ready = activeJob?.status === 'succeeded' && activeJob.artifact?.localUrl && selected;

  return <div className="dexsr-overlay" role="presentation" onClick={onClose}>
    <div className="dexsr-dialog" role="dialog" aria-modal="true" aria-label="DE-X SR德式超分" onClick={event => event.stopPropagation()}>
      <header className="dexsr-header">
        <div><span className="dexsr-eyebrow">NON-GENERATIVE PRECISION RESTORATION</span><h2>DE-X SR｜德式超分</h2>
          <p>完整前段影片＋多原始圖＋保真提示詞。不換臉、不生成新幀、不覆寫來源。</p>
        </div>
        <button type="button" aria-label="close-dex-sr" className="dexsr-close" onClick={onClose}><X size={18}/></button>
      </header>
      <div className="dexsr-content">
        <section className="dexsr-config">
          <div className="dexsr-section-title"><strong>01｜片段輸入</strong><span>使用原生影片，不抽JPEG尾幀</span></div>
          <label>待修復影片
            <select aria-label="dex-sr-current-video" value={current} onChange={e => setCurrent(e.target.value)}>
              <option value="">選擇本機已保存影片</option>
              {videoOptions.map(a => <option key={a.hash} value={a.hash}>{a.label} · {a.hash.slice(0,8)}</option>)}
            </select>
          </label>
          <label>前段影片記憶（選填，1–8秒）
            <select aria-label="dex-sr-previous-video" value={previous} onChange={e => setPrevious(e.target.value)}>
              <option value="">無前段影片</option>
              {videoOptions.filter(a => a.hash !== current).map(a => <option key={a.hash} value={a.hash}>{a.label} · {a.hash.slice(0,8)}</option>)}
            </select>
          </label>
          <div className="dexsr-section-title"><strong>02｜原始視覺參考</strong><span>{Object.keys(originals).length}/8張</span></div>
          {imageOptions.length === 0 ? <p className="dexsr-hint">請先在畫布用「Import media」匯入人物、場景原始圖片。</p> :
          <div className="dexsr-refs">{imageOptions.map(item =>
            <div key={item.hash} className="dexsr-reference">
              <label className="dexsr-reference-main">
                <input type="checkbox" aria-label={'dex-sr-ref-' + item.hash} checked={Boolean(originals[item.hash])}
                  disabled={!originals[item.hash] && Object.keys(originals).length >= 8}
                  onChange={e => setOriginals(old => {
                    const next = { ...old };
                    if (e.target.checked) next[item.hash] = 'identity';
                    else delete next[item.hash];
                    return next;
                  })}/>
                <img src={item.url} alt="" loading="lazy"/>
                <span title={item.label}>{item.label}</span>
              </label>
              {originals[item.hash] && <select aria-label={'dex-sr-role-' + item.hash} value={originals[item.hash]}
                onChange={e => setOriginals(old => ({ ...old, [item.hash]: e.target.value as DexSrReferenceRole }))}>
                {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>}
            </div>)}</div>}
          <div className="dexsr-section-title"><strong>03｜保真指令</strong><span>僅控制數值修復規則</span></div>
          <textarea aria-label="dex-sr-prompt" rows={3} maxLength={1200} value={prompt} onChange={e => setPrompt(e.target.value)}/>
          <label>時序半徑
            <select aria-label="dex-sr-radius" value={radius} onChange={e => setRadius(Number(e.target.value) as 0 | 1 | 2)}>
              <option value={0}>0｜單幀基線</option>
              <option value={1}>1｜前後各一幀</option>
              <option value={2}>2｜前後各兩幀</option>
            </select>
          </label>
          <p className="dexsr-hint">{cap?.available ? '本機OpenCV修復引擎可用。' : '本機Python/OpenCV修復引擎未就緒；可先驗證素材，無法啟動執行。'}目前最多8秒；只輸出MP4交付版，FFV1母帶尚未永久歸檔。</p>
          {error && <p className="dexsr-error" role="alert">{error}</p>}
          {plan && <div className="dexsr-plan" role="status">
            <Check size={14}/><span>預檢完成：{plan.current.width}×{plan.current.height}／{plan.current.duration.toFixed(2)}秒；
              {plan.previousSegment ? '已驗證前段影片；' : '無前段影片；'}
              {plan.originals.length}張原始圖；{plan.promptPolicy.intent}。
            </span>
          </div>}
          <div className="dexsr-actions">
            <button type="button" className="dexsr-button secondary" data-testid="dex-sr-plan"
              disabled={!current || Object.keys(originals).length === 0 || Boolean(busy)}
              onClick={() => void analyze()}>{busy === 'plan' ? <LoaderCircle size={15}/> : <Check size={15}/>}預檢來源</button>
            <button type="button" className="dexsr-button primary" data-testid="dex-sr-run"
              disabled={!plan || !cap?.available || Boolean(busy) || ['pending','running'].includes(activeJob?.status ?? '')}
              onClick={() => void submit()}>{busy === 'start' ? <LoaderCircle size={15}/> : <ArrowRight size={15}/>}執行保真修復</button>
            {activeJob && ['pending','running'].includes(activeJob.status) &&
              <button type="button" className="dexsr-button secondary" data-testid="dex-sr-cancel" disabled={Boolean(busy)}
                onClick={() => void cancel()}><Square size={13}/>取消</button>}
          </div>
        </section>
        <section className="dexsr-result">
          <div className="dexsr-section-title"><strong>04｜原片與修復對照</strong><span>同幀率，沒有新增影格</span></div>
          {activeJob && <p className="dexsr-job-status" role="status">工作{activeJob.id.slice(0,8)}｜{activeJob.status === 'pending' ? '等待中' :
            activeJob.status === 'running' ? '修復中' : activeJob.status === 'succeeded' ? '已完成' :
            activeJob.status === 'failed' ? '失敗' : activeJob.status === 'cancelled' ? '已取消' : '已中斷'}
            {activeJob.error ? '｜' + activeJob.error : ''}</p>}
          <div className="dexsr-compare">
            <div className="dexsr-video-panel">
              <strong>原始影片</strong>
              {selected ? <video ref={beforeVideo} controls playsInline preload="metadata" src={selected.url} /> :
                <p className="dexsr-placeholder">選擇待修復影片</p>}
            </div>
            <div className="dexsr-video-panel">
              <strong>DE-X SR修復結果</strong>
              {ready ? <video ref={afterVideo} controls playsInline preload="metadata" src={activeJob!.artifact!.localUrl}/> :
                <p className="dexsr-placeholder">完成修復後顯示影片</p>}
            </div>
          </div>
          {ready && <div className="dexsr-actions">
            <button type="button" className="dexsr-button secondary" aria-label="dex-sr-sync-play" onClick={togglePlay}><Play size={15}/>同步播放／暫停</button>
            <a className="dexsr-button primary" download={'dex-sr-' + activeJob!.id.slice(0,8) + '-1080p.mp4'}
              href={activeJob!.artifact!.localUrl!}><Download size={15}/>下載1080p修復版</a>
          </div>}
          <p className="dexsr-hint">檢視人像時，請對照五官比例、髮絲方向、衣物紋理與鏡頭轉場。光流修復不保證還原來源中已完全失去的細節。</p>
        </section>
      </div>
    </div>
  </div>;
}
