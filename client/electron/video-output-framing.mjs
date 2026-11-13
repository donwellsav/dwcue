export const VIDEO_FRAME_PRESETS = [
  { id: '1080p', width: 1920, height: 1080 },
  { id: '720p', width: 1280, height: 720 },
  { id: 'uhd', width: 3840, height: 2160 },
  { id: 'dci4k', width: 4096, height: 2160 },
  { id: 'wuxga', width: 1920, height: 1200 },
  { id: 'wxga', width: 1280, height: 800 },
  { id: 'xga', width: 1024, height: 768 },
  { id: 'stage', width: 3840, height: 1080 },
  { id: 'portrait', width: 1080, height: 1920 },
];

export const VIDEO_FRAME_LIMITS = { minDimension: 64, maxDimension: 16384, minScale: 25, maxScale: 100 };
export const DEFAULT_VIDEO_FRAMING = { width: 1920, height: 1080, scale: 100, scaling: 'fit' };

export function readVideoFraming(value) {
  const { width, height, scale, scaling } = value ?? {};
  const { minDimension, maxDimension, minScale, maxScale } = VIDEO_FRAME_LIMITS;
  if (![width, height].every(size => Number.isInteger(size) && size >= minDimension && size <= maxDimension)
      || !Number.isInteger(scale) || scale < minScale || scale > maxScale
      || (scaling !== 'fit' && scaling !== 'limit')) return null;
  return { width, height, scale, scaling };
}

export function videoFrameLayout(framing, pixelScale) {
  return {
    aspect: framing.width / framing.height,
    fraction: framing.scale / 100,
    maxWidth: framing.scaling === 'limit' ? framing.width / pixelScale : Infinity,
  };
}

export function videoFrameCaptureRect(width, height, framing, pixelScale) {
  const { aspect, fraction, maxWidth } = videoFrameLayout(framing, pixelScale);
  const frameWidth = Math.min(width, height * aspect, maxWidth) * fraction;
  // Round outward so fractional display pixels cannot cut off the picture edge.
  const x = Math.floor(Math.max(0, (width - frameWidth) / 2));
  const y = Math.floor(Math.max(0, (height - frameWidth / aspect) / 2));
  return { x, y, width: width - 2 * x, height: height - 2 * y };
}
