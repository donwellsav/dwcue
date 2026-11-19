'use strict';

// Which browser permissions the app's own pages get.
//
// Chromium asks for "midiSysex" for every Web MIDI request, even the app's
// requestMIDIAccess({ sysex: false }). With only "midi" allowed, the packaged
// app was refused MIDI access and no controller could be used (2.7.1).

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8');
const mainAst = ts.createSourceFile('main.js', mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functionSource = (name) => {
  const node = mainAst.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node, `missing ${name} in Electron main process`);
  return node.getText(mainAst);
};

const TRUSTED = 'file:///app/.output/public/index.html';
const UNTRUSTED = 'https://example.com/';

function permissionHandlers() {
  const handlers = {};
  const context = {
    app: { isPackaged: false },
    isTrustedRendererUrl: url => url === TRUSTED,
    session: {
      defaultSession: {
        setPermissionCheckHandler: (handler) => { handlers.check = handler; },
        setPermissionRequestHandler: (handler) => { handlers.request = handler; },
      },
    },
  };
  vm.runInNewContext(`${functionSource('configureSessionSecurity')}\nconfigureSessionSecurity();`, context);
  const contents = url => ({ getURL: () => url });
  return {
    check: (url, permission) => handlers.check(contents(url), permission),
    request: (url, permission) => {
      let answer;
      handlers.request(contents(url), permission, (granted) => { answer = granted; });
      return answer;
    },
  };
}

test('the app page gets MIDI under the name Chromium asks for', () => {
  const permissions = permissionHandlers();
  for (const name of ['midi', 'midiSysex']) {
    assert.equal(permissions.request(TRUSTED, name), true, `request ${name}`);
    assert.equal(permissions.check(TRUSTED, name), true, `check ${name}`);
  }
});

test('MIDI is still refused to any other page', () => {
  const permissions = permissionHandlers();
  for (const name of ['midi', 'midiSysex']) {
    assert.equal(permissions.request(UNTRUSTED, name), false, `request ${name}`);
    assert.equal(permissions.check(UNTRUSTED, name), false, `check ${name}`);
  }
});

test('permissions the app does not use stay refused, even to its own page', () => {
  const permissions = permissionHandlers();
  for (const name of ['media', 'geolocation', 'notifications', 'hid', 'serial', 'usb', 'display-capture']) {
    assert.equal(permissions.request(TRUSTED, name), false, name);
  }
});
