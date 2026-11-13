export interface VideoFraming {
  width: number;
  height: number;
  scale: number;
  scaling: 'fit' | 'limit';
}

export const VIDEO_FRAME_PRESETS: readonly { id: string; width: number; height: number }[];
export const VIDEO_FRAME_LIMITS: Readonly<{ minDimension: number; maxDimension: number; minScale: number; maxScale: number }>;
export const DEFAULT_VIDEO_FRAMING: Readonly<VideoFraming>;
export function readVideoFraming(value: unknown): VideoFraming | null;
export function videoFrameLayout(framing: VideoFraming, pixelScale: number): { aspect: number; fraction: number; maxWidth: number };
export function videoFrameCaptureRect(width: number, height: number, framing: VideoFraming, pixelScale: number):
  { x: number; y: number; width: number; height: number };
