import { Film } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

type VideoThumbnailProps = {
  src: string;
  alt: string;
  className?: string;
};

/** Capture a local frame without starting playback. Remote timeline sources use a Film fallback until preview. */
export default function VideoThumbnail({ src, alt, className = '' }: VideoThumbnailProps) {
  return <VideoThumbnailFrame key={src} src={src} alt={alt} className={className} />;
}

function unloadVideo(video: HTMLVideoElement | null): void {
  if (!video) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
}

/** Each source owns its video node so an old effect can never unload a new URL. */
function VideoThumbnailFrame({ src, alt, className }: VideoThumbnailProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewTimeRef = useRef<number | undefined>(undefined);
  const fenceRef = useRef(0);
  const [poster, setPoster] = useState<string>();
  const [failed, setFailed] = useState(false);

  useLayoutEffect(() => {
    const video = videoRef.current;
    const fence = ++fenceRef.current;
    previewTimeRef.current = undefined;
    setPoster(undefined);
    setFailed(false);
    if (!video) return;
    if (video.getAttribute('src') !== src) {
      video.setAttribute('src', src);
      video.load();
    }

    const captureFrame = () => {
      if (fenceRef.current !== fence || videoRef.current !== video || video.seeking || previewTimeRef.current === undefined || video.currentTime < previewTimeRef.current || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return;
      try {
        const canvas = document.createElement('canvas');
        const width = Math.min(video.videoWidth, 960);
        canvas.width = width;
        canvas.height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
        const context = canvas.getContext('2d');
        if (!context) return;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const nextPoster = canvas.toDataURL('image/jpeg', 0.82);
        if (nextPoster.length > 32) setPoster(nextPoster);
      } catch {
        if (fenceRef.current === fence) setFailed(true);
      }
    };

    const handleMetadata = () => {
      if (fenceRef.current !== fence || videoRef.current !== video) return;
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        setFailed(true);
        return;
      }
      // Seeking forces a decoded frame before capture; loadeddata at time zero can
      // expose a black surface in Chromium even when the source's first frame is valid.
      previewTimeRef.current = Math.min(0.1, video.duration / 2);
      try { video.currentTime = previewTimeRef.current; } catch { setFailed(true); }
    };

    const handleError = () => {
      if (fenceRef.current === fence && videoRef.current === video) setFailed(true);
    };

    video.addEventListener('loadedmetadata', handleMetadata);
    video.addEventListener('loadeddata', captureFrame);
    video.addEventListener('seeked', captureFrame);
    video.addEventListener('error', handleError);
    return () => {
      if (fenceRef.current === fence) fenceRef.current += 1;
      video.removeEventListener('loadedmetadata', handleMetadata);
      video.removeEventListener('loadeddata', captureFrame);
      video.removeEventListener('seeked', captureFrame);
      video.removeEventListener('error', handleError);
      unloadVideo(video);
    };
  }, [src]);

  return (
    <span className={`video-thumbnail ${failed ? 'is-failed' : ''} ${className}`.trim()}>
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        muted
        playsInline
        preload="metadata"
        crossOrigin="anonymous"
        aria-label={alt}
      />
      {!poster && failed && <span className="video-thumbnail-fallback" aria-hidden="true"><Film size={22} /></span>}
    </span>
  );
}
