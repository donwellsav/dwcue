// Run with node --test scripts/operator-tooltips.test.js on an Electron desktop host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.versions.electron) {
  const { app, BrowserWindow } = require('electron');
  const ts = require('typescript');
  app.setPath('userData', process.env.DWCUE_TOOLTIP_TEST_PROFILE);
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await window.loadURL('about:blank');
    const source = fs.readFileSync(path.resolve(__dirname, '../client/app/utils/tooltips.ts'), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    await window.webContents.executeJavaScript(`(async () => {
      const exports = {};
      ${compiled}
      document.title = 'Operator';
      document.body.innerHTML = '<button title="Play" aria-label="GO"></button><span title="Old hint"></span>';
      const button = document.querySelector('button');
      const span = document.querySelector('span');
      const restore = exports.suppressTooltips(document.body);
      const check = (ok, message) => { if (!ok) throw new Error(message); };
      check(button.title === '' && button.getAttribute('aria-label') === 'GO', 'Only the hint should be hidden');
      button.title = 'Play new cue';
      span.removeAttribute('title');
      const panel = document.createElement('section');
      panel.innerHTML = '<button title="New panel"></button>';
      document.body.append(panel);
      await Promise.resolve();
      check(!document.querySelector('[title]:not([title=""])'), 'Updated and newly mounted hints must stay hidden');
      panel.remove();
      await Promise.resolve();
      check(panel.firstChild.title === 'New panel', 'Removing a panel should release its original hint');
      button.title = 'Next cue';
      restore();
      check(button.title === 'Next cue' && !span.hasAttribute('title'), 'Restore the current hints only');
      check(document.title === 'Operator', 'Preserve the native window title');
    })()`);
    app.exit(0);
  }).catch(error => {
    console.error(error);
    app.exit(1);
  });
} else {
  require('node:test')('operator tooltips follow live DOM changes', () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dwcue-tooltip-test-'));
    try {
      const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '', DWCUE_TOOLTIP_TEST_PROFILE: profile },
        encoding: 'utf8', timeout: 20000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
