'use strict';

// Does the audience window really cover the display it was put on?
//
// Electron positions windows in device-independent pixels. On Windows, when
// the control display and the output display use different scaling (a laptop
// at 150% feeding a projector at 100% is the normal case), a window created on
// or moved to the other display can come out the wrong physical size, and a
// "fullscreen" output then shows the desktop around a smaller picture.
//
// Main cannot see the physical window rectangle, but the page inside it can:
// its viewport and the screen it sits on are reported in the same units. This
// module holds the pure decisions; main.js applies them to the real window.

// CSS pixels of slack for rounding under fractional scaling.
const COVERAGE_TOLERANCE = 2;
// Re-seat twice, compensate once, then stop and tell the operator.
const MAX_CORRECTIONS = 3;
const MAX_DIMENSION = 32768;
const MAX_COMPENSATION = 4;

function wholePixels(value) {
  return Number.isInteger(value) && value > 0 && value <= MAX_DIMENSION ? value : null;
}

// Accept only the fields this check uses, from the output renderer.
function readViewportReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const innerWidth = wholePixels(value.innerWidth);
  const innerHeight = wholePixels(value.innerHeight);
  const screenWidth = wholePixels(value.screenWidth);
  const screenHeight = wholePixels(value.screenHeight);
  const pixelScale = typeof value.pixelScale === 'number' && Number.isFinite(value.pixelScale)
    && value.pixelScale >= 0.25 && value.pixelScale <= 8 ? value.pixelScale : null;
  if (!innerWidth || !innerHeight || !screenWidth || !screenHeight || !pixelScale) return null;
  return { innerWidth, innerHeight, screenWidth, screenHeight, pixelScale };
}

function viewportCoversScreen(report) {
  return report.innerWidth >= report.screenWidth - COVERAGE_TOLERANCE
    && report.innerHeight >= report.screenHeight - COVERAGE_TOLERANCE;
}

/**
 * What to do about the latest measurement of a physical output window.
 *
 * A physical output is borderless and cannot be moved or resized by hand, so
 * it must cover its display whether or not it is in fullscreen: the operator
 * leaving fullscreen (Esc is also Stop All) must not shrink the picture.
 *
 * - `none`: nothing to correct (it covers, or this platform is not corrected
 *   automatically).
 * - `reseat`: place the window on the display again, re-entering fullscreen
 *   when `fullscreen` is set. Fixes a window sized with another display's scale.
 * - `compensate`: it keeps coming out short, so cover the display with plain
 *   bounds enlarged by the measured shortfall instead.
 * - `give-up`: stop changing the window during a show; warn the operator.
 */
function planGeometryCorrection({
  platform, report, corrections, fullscreenWanted, onTargetDisplay, windowBounds, targetBounds,
}) {
  if (!report) return { action: 'none', covered: false };
  const covered = viewportCoversScreen(report) && onTargetDisplay;
  if (covered) return { action: 'none', covered: true };
  // Only Windows has shown this fault. Elsewhere a short viewport can be
  // legitimate (a notched Mac display), so it is recorded but left alone.
  if (platform !== 'win32') return { action: 'none', covered: false };
  if (corrections >= MAX_CORRECTIONS) return { action: 'give-up', covered: false };
  if (corrections < MAX_CORRECTIONS - 1 || !onTargetDisplay) {
    return {
      action: 'reseat', covered: false, bounds: { ...targetBounds }, fullscreen: fullscreenWanted === true,
    };
  }
  const grow = (shown, wanted) => Math.min(MAX_COMPENSATION, Math.max(1, wanted / shown));
  return {
    action: 'compensate',
    covered: false,
    bounds: {
      x: targetBounds.x,
      y: targetBounds.y,
      width: Math.ceil(windowBounds.width * grow(report.innerWidth, report.screenWidth)),
      height: Math.ceil(windowBounds.height * grow(report.innerHeight, report.screenHeight)),
    },
  };
}

module.exports = {
  COVERAGE_TOLERANCE,
  MAX_CORRECTIONS,
  planGeometryCorrection,
  readViewportReport,
  viewportCoversScreen,
};
