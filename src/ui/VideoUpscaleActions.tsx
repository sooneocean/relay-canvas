import { Download, LoaderCircle, Sparkles } from 'lucide-react';
import type { Artifact, ExportJob } from '../shared/types.js';

/**
 * Opt-in browser-compatible non-AI 1080p enlargement. The resulting asset is a
 * new local artifact; original footage remains unchanged.
 */
export default function VideoUpscaleActions({
  source,
  job,
  onUpscale,
}: {
  source: Artifact;
  job?: ExportJob;
  onUpscale: () => void;
}) {
  if (source.kind !== 'video' || !source.localId || !source.localUrl) return null;
  const working = job?.status === 'pending' || job?.status === 'running';
  const succeeded = job?.status === 'succeeded' && Boolean(job.artifact?.localUrl);
  return (
    <>
      <button
        type="button"
        className="asset-save-button"
        aria-label={'upscale-video-' + source.localId}
        onClick={onUpscale}
        disabled={working || succeeded}
        title="保留時間順序與原始幀率，使用Lanczos放大；非AI細節重建"
      >
        {working ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />}
        {working ? '升頻處理中' : succeeded ? '1080p已完成' : job?.status === 'failed' ? '重試1080p' : '升頻1080p'}
      </button>
      {succeeded && job?.artifact?.localUrl &&
        <a
          className="asset-download-button"
          aria-label={'download-upscale-' + source.localId}
          href={job.artifact.localUrl}
          download="reachflow-1080p-lanczos.mp4"
        >
          <Download size={13} />下載1080p
        </a>}
      {job?.status === 'failed' && <span className="asset-local-status is-failed">超分失敗，原影片未變動</span>}
    </>
  );
}
