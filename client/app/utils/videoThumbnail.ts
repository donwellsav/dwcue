import type { AudioItem } from '../types/project';

type FrameSelection = Pick<AudioItem, 'inPoint' | 'outPoint' | 'videoThumbnailTime'>;

export function videoThumbnailRange(cue: FrameSelection, duration: number) {
  // Seek just inside the clip and the cue's exclusive Out point.
  const last = Math.max(0, duration - 0.001);
  const start = Math.max(0, Math.min(last, cue.inPoint || 0));
  const out = cue.outPoint > 0 ? Math.min(cue.outPoint, duration) : duration;
  const end = Math.max(start, out - 0.001);
  const middle = Math.max(start, Math.min(end, (start + out) / 2));
  const selected = cue.videoThumbnailTime;
  const time = typeof selected === 'number' && Number.isFinite(selected)
    ? Math.max(start, Math.min(end, selected))
    : middle;
  return { start, end, middle, time };
}

export function cueVideoUrl(serverUrl: string, sessionId: string, token: string, uuid: string) {
  const query = new URLSearchParams({ item_uuid: uuid, project_session_id: sessionId });
  if (token) query.set('access_token', token);
  return `${serverUrl.replace(/\/+$/, '')}/api/media?${query}`;
}

export function drawVideoStill(video: HTMLVideoElement, maxEdge: number) {
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight || video.seeking || video.readyState < video.HAVE_CURRENT_DATA) return null;
  const ratio = Math.min(1, maxEdge / Math.max(videoWidth, videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(videoWidth * ratio));
  canvas.height = Math.max(1, Math.round(videoHeight * ratio));
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.92);
}

// A show can open with many video rows in view. Only one background decode
// at a time competes with the actual Video Output window.
let decoding: Promise<string | null> = Promise.resolve(null);

export function readVideoThumbnail(url: string, cue: FrameSelection, signal: AbortSignal) {
  decoding = decoding.then(() => {
    if (signal.aborted) return null;
    return new Promise<string | null>(resolve => {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.preload = 'auto';
      let target: number | undefined;
      function finish(image: string | null) {
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
        video.onloadedmetadata = video.onloadeddata = video.onseeked = video.onerror = null;
        video.removeAttribute('src');
        video.load();
        resolve(image);
      }
      function cancel() { finish(null); }
      const timeout = setTimeout(cancel, 5000);
      function readFrame() {
        if (target === undefined || video.seeking || Math.abs(video.currentTime - target) > 0.05) return;
        try {
          const image = drawVideoStill(video, 512);
          if (image) finish(image);
        } catch { cancel(); }
      }
      signal.addEventListener('abort', cancel, { once: true });
      video.onerror = cancel;
      video.onloadeddata = video.onseeked = readFrame;
      video.onloadedmetadata = () => {
        if (!video.videoWidth || !Number.isFinite(video.duration)) return cancel();
        target = videoThumbnailRange(cue, video.duration).time;
        if (target !== video.currentTime) video.currentTime = target;
        readFrame();
      };
      video.src = url;
    });
  });
  return decoding;
}
