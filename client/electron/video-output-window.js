'use strict';

// The right picture on the right screen: which display is the assigned one,
// and how a video output window takes over that screen and no other.
//
// macOS fullscreen is a Space, not a window state. With "Displays have separate
// Spaces" turned off in macOS (usual on machines that feed video gear), one
// window entering fullscreen blanks every other display: putting the audience
// output up took the operator's screen with it. So on macOS a video output
// never enters native fullscreen:
//
// - the audience output on its assigned display is a borderless window laid
//   exactly over that display, above the menu bar and Dock, in every Space;
// - the preview window uses "simple" fullscreen, which resizes the window over
//   the screen it is on and makes no Space.
//
// Windows and Linux fullscreen already belongs to one display and is unchanged.
//
// The same goes for every other window of the app on a Mac: the control
// window entering a fullscreen Space would blank the audience display.

const usesNativeFullscreen = platform => platform !== 'darwin';

// main.js marks the window that owns a physical display.
const isPhysicalOutput = outputWindow => outputWindow.videoOutputTargetDisplayId != null;

function physicalOutputWindowOptions(platform, bounds) {
  const options = {
    // Raw display bounds: this is a physical output, so no DPI correction
    // (correction is only for capture-only outputs, e.g. a future NDI sink).
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    // Keep the Windows Alt+F4 escape hatch available even though this output
    // has no frame. The closed handler disarms the session so it stays shut.
    closable: true,
    alwaysOnTop: true,
  };
  if (usesNativeFullscreen(platform)) return { ...options, fullscreen: true };
  return {
    ...options,
    fullscreenable: false,         // nothing can send it into a fullscreen Space
    enableLargerThanScreen: true,  // sit over the menu bar, not pushed below it
    roundedCorners: false,         // square to the corners of the display
    hasShadow: false,              // no shadow on the neighbouring display
  };
}

// Single-display (or unassigned) machines get a normal window instead of a
// hostile fullscreen black takeover.
function previewWindowOptions(platform) {
  const options = { useContentSize: true, width: 960, height: 540, minWidth: 320, minHeight: 180 };
  // The green title-bar button would otherwise open a fullscreen Space.
  return usesNativeFullscreen(platform) ? options : { ...options, fullscreenable: false };
}

function seatPhysicalOutput(outputWindow, platform, bounds) {
  outputWindow.setAlwaysOnTop(true, 'screen-saver');
  if (usesNativeFullscreen(platform)) return;
  outputWindow.setBounds({ ...bounds });
  // Stay on the audience display when the operator changes Space, and keep
  // the app in the Dock and app switcher.
  outputWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
}

function isOutputFullscreen(outputWindow, platform) {
  if (usesNativeFullscreen(platform)) return outputWindow.isFullScreen();
  // A Mac audience output covers its display by construction.
  return isPhysicalOutput(outputWindow) || outputWindow.isSimpleFullScreen();
}

function canToggleOutputFullscreen(outputWindow, platform) {
  return usesNativeFullscreen(platform) || !isPhysicalOutput(outputWindow);
}

function setOutputFullscreen(outputWindow, platform, on) {
  if (usesNativeFullscreen(platform)) outputWindow.setFullScreen(on);
  else if (!isPhysicalOutput(outputWindow)) outputWindow.setSimpleFullScreen(on);
}

// Simple fullscreen hides the menu bar and Dock for the whole app, and macOS
// does not give them back when the window is destroyed. Hand them back before
// a window that is using it goes away.
function releaseOutputFullscreen(outputWindow, platform) {
  if (usesNativeFullscreen(platform) || isPhysicalOutput(outputWindow)) return;
  if (!outputWindow.isSimpleFullScreen()) return;
  // Hidden first, so it goes at once instead of shrinking to a window on the
  // way out (and its page does not report every size in between).
  outputWindow.hide();
  outputWindow.setSimpleFullScreen(false);
}

// At most one output window, ever: a picture on two screens is the one thing
// the output must never do. Nothing should leave a second one behind, and if
// anything does, it is closed before the new one shows a frame.
const liveOutputWindows = new Set();
function claimSoleOutput(outputWindow, platform = process.platform) {
  for (const other of liveOutputWindows) {
    if (other === outputWindow || other.isDestroyed()) continue;
    // destroy() skips the window's close handler, so the menu bar and Dock a
    // covering preview took are handed back here first.
    releaseOutputFullscreen(other, platform);
    other.destroy();
  }
  liveOutputWindows.clear();
  liveOutputWindows.add(outputWindow);
}

// Control, QuickPlays, Help: on a Mac their green button fills the screen
// instead of opening a fullscreen Space.
function keepOutOfFullscreenSpaces(window, platform) {
  if (usesNativeFullscreen(platform)) return;
  // Electron announces a new window before applying that window's own options,
  // which would switch this back on. Wait until the window is fully made.
  setImmediate(() => {
    if (!window.isDestroyed()) window.setFullScreenable(false);
  });
}

/**
 * The display the operator assigned, or null when the app cannot be sure.
 * Never a guess: a wrong screen at a live event is worse than no picture.
 *
 * The saved id is the display while it is connected. When the id is gone (the
 * OS can hand out a new one after a reconnect) the saved size and name may
 * identify the same display again, but only if exactly one connected display
 * fits, and never:
 * - a look-alike (`lookalikeIds`): a display of the same size and name that
 *   was connected under its own id next to the assigned one. An identical
 *   stage monitor is a different screen;
 * - the display the control window is on.
 */
function resolveAssignedDisplay({
  displays, displayId, fingerprint, fingerprintOf, lookalikeIds, controlDisplayId,
}) {
  const byId = displayId ? displays.find(display => String(display.id) === displayId) : null;
  if (byId) return byId;
  if (!fingerprint) return null;
  const candidates = displays.filter(display => fingerprintOf(display) === fingerprint
    && !lookalikeIds.includes(String(display.id)) && display.id !== controlDisplayId);
  return candidates.length === 1 ? candidates[0] : null;
}

module.exports = {
  canToggleOutputFullscreen,
  claimSoleOutput,
  isOutputFullscreen,
  keepOutOfFullscreenSpaces,
  physicalOutputWindowOptions,
  previewWindowOptions,
  releaseOutputFullscreen,
  resolveAssignedDisplay,
  seatPhysicalOutput,
  setOutputFullscreen,
  usesNativeFullscreen,
};
