'use strict';

function buildVideoOutputContextTemplate({
  fullscreen,
  // False for a Mac audience output, which always covers its display.
  canToggleFullscreen = true,
  testCard,
  labels,
  onToggleFullscreen,
  onToggleTestCard,
  onExit,
}) {
  return [
    ...(canToggleFullscreen ? [{
      label: fullscreen ? labels.exitFullscreen : labels.enterFullscreen,
      click: onToggleFullscreen,
    }] : []),
    {
      label: labels.showTestCard,
      type: 'checkbox',
      checked: testCard,
      click: (item) => onToggleTestCard(item.checked === true),
    },
    { type: 'separator' },
    {
      label: labels.exitOutput,
      click: onExit,
    },
  ];
}

module.exports = { buildVideoOutputContextTemplate };
