'use strict';

const MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift']);
const NATIVE_PRIMARY_KEYS = new Set(['n', 'o', 'q', 's', 'w']);

function normalizeShortcutKey(input) {
  const key = typeof input?.key === 'string' ? input.key : '';
  if (key === 'Space' || key === 'Spacebar') return ' ';
  if (key === 'Esc') return 'Escape';
  if (key === 'Up') return 'ArrowUp';
  if (key === 'Down') return 'ArrowDown';
  if (key === 'Left') return 'ArrowLeft';
  if (key === 'Right') return 'ArrowRight';
  return key;
}

function isNativeApplicationShortcut(input, platform) {
  const key = normalizeShortcutKey(input);
  const lowerKey = key.toLowerCase();
  const primary = platform === 'darwin' ? input.meta === true : input.control === true;

  if (key === 'F11' && !input.control && !input.meta && !input.alt && !input.shift) {
    return true;
  }
  if (primary && !input.alt && !input.shift && NATIVE_PRIMARY_KEYS.has(lowerKey)) {
    return true;
  }
  if (primary && input.shift && !input.alt && (lowerKey === 'd' || lowerKey === 'i')) {
    return true;
  }
  return platform === 'darwin' && input.meta === true && input.alt === true &&
    !input.control && !input.shift && lowerKey === 'i';
}

function shouldForwardVideoOutputShortcut(input, platform = process.platform) {
  if (!input || input.type !== 'keyDown') return false;
  const key = normalizeShortcutKey(input);
  if (!key || MODIFIER_KEYS.has(key)) return false;

  // Preserve OS-level escape hatches. Windows-key combinations belong to the
  // shell; Alt+F4 must always be able to close the otherwise-frameless output.
  if (platform === 'win32' && (input.meta === true || (input.alt === true && key === 'F4'))) {
    return false;
  }
  return !isNativeApplicationShortcut(input, platform);
}

function toRendererShortcut(input) {
  return {
    key: normalizeShortcutKey(input),
    code: typeof input?.code === 'string' ? input.code : '',
    ctrlKey: input?.control === true,
    shiftKey: input?.shift === true,
    altKey: input?.alt === true,
    metaKey: input?.meta === true,
    repeat: input?.isAutoRepeat === true,
  };
}

module.exports = {
  normalizeShortcutKey,
  shouldForwardVideoOutputShortcut,
  toRendererShortcut,
};
