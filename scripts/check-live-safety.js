const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const pkg = JSON.parse(read('client/package.json'));
for (const target of pkg.build.mac.target) {
  assert.deepEqual(target.arch, ['arm64'], `macOS ${target.target} must be Apple Silicon-only`);
}

const engine = read('server/src/audio/engine.cpp');
assert.match(engine, /render_block \* 4\)/, 'output ring must not add hundreds of milliseconds of latency');

const electron = read('client/electron/main.js');
assert.match(electron, /async function terminateLiveplayPid\(pid\)/, 'server termination must be shared and awaitable');
assert.match(electron, /await terminateLiveplayPid\(lock\.pid\)/, 'an unhealthy locked server must be stopped before replacement');
assert.match(electron, /let liveplayServerStartPromise = null/, 'concurrent start requests must share one launch');
assert.match(electron, /if \(liveplayServerStartPromise\) return liveplayServerStartPromise/, 'concurrent start requests must not spawn twice');
assert.match(electron, /await pollPidfileForServerPid\(lockPath\)/, 'a launch must adopt its PID before it is considered complete');
assert.match(electron, /const pid = liveplayServerPid \?\? readLiveplayLock\(\)\?\.pid/, 'shutdown must cover the pidfile race window');
assert.match(electron, /async function stopLiveplayServer\(\)[\s\S]*if \(liveplayServerStartPromise\) await liveplayServerStartPromise/, 'shutdown must wait for an in-flight launch');
assert.match(electron, /async function stopLiveplayServer\(\)[\s\S]*await terminateLiveplayPid\(pid\)/, 'normal shutdown must wait for termination');
assert.match(electron, /ipcMain\.handle\('app:confirm-quit', async[\s\S]*await stopLiveplayServer\(\)/, 'confirmed shutdown must finish before Electron exits');
assert.match(electron, /ipcMain\.handle\('liveplay-server:restart', async[\s\S]*await stopLiveplayServer\(\)[\s\S]*await startLiveplayServer\(\)/, 'restart must not overlap two servers');

const workspace = read('client/app/components/MainWorkspace.vue');
assert.match(workspace, /uiMode\.value === 'playback'[\s\S]*e\.key === 'Delete'[\s\S]*key === 'd'[\s\S]*key === 'v'/, 'Show Mode must block destructive workspace shortcuts');

const cart = read('client/app/components/CartPlayer.vue');
assert.match(cart, /handleCartKeydown[\s\S]*showMode\.value[\s\S]*requestDeleteFromKeyboard/, 'Show Mode must block detached-cart deletion');

console.log('Live safety checks passed.');
