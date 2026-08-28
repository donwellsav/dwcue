'use strict';

function buildVideoOutputContextTemplate({
  fullscreen,
  testCard,
  labels,
  onToggleFullscreen,
  onToggleTestCard,
  onExit,
}) {
  return [
    {
      label: fullscreen ? labels.exitFullscreen : labels.enterFullscreen,
      click: onToggleFullscreen,
    },
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
