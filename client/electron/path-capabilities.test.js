const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PathCapabilityRegistry } = require('./path-capabilities');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dwcue-capabilities-'));
try {
  const project = path.join(temp, 'project');
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(project, 'inside.wav'), '');
  fs.writeFileSync(path.join(outside, 'exact.wav'), '');
  fs.writeFileSync(path.join(outside, 'blocked.wav'), '');
  fs.symlinkSync(outside, path.join(project, 'escape'));

  const capabilities = new PathCapabilityRegistry();
  capabilities.authorizeRoot(project);
  capabilities.authorizeFile(path.join(outside, 'exact.wav'));

  assert(capabilities.allows(path.join(project, 'inside.wav')));
  assert(capabilities.allows(path.join(project, 'waveforms', 'new.json'), { allowMissing: true }));
  assert(capabilities.allows(path.join(outside, 'exact.wav')));
  assert(!capabilities.allows(path.join(outside, 'blocked.wav')));
  assert(!capabilities.allows(path.join(project, 'escape', 'blocked.wav')));
  assert.throws(
    () => capabilities.require(path.join(project, '..', 'outside', 'blocked.wav')),
    /outside the user-authorized/,
  );
  console.log('Path capability checks passed.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
