#!/usr/bin/env node
// =============================================================================
// scripts/build-server.js
// -----------------------------------------------------------------------------
// Always configures (idempotent) and builds the C++ server using whichever
// CMake preset fits the host. Used by `npm run server:build`, `npm run build`,
// and CI.
// =============================================================================
const fs        = require('node:fs');
const path      = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');
const BUILD_DIR  = path.join(SERVER_DIR, 'build');
const PRESET     = process.platform === 'win32' ? 'vs2022' : 'default';

// On macOS, DWCUE_MAC_ARCH selects the packaged native-server architecture.
// Default to the host architecture so a normal local build remains one
// command, while CI can build Intel and Apple Silicon in separate jobs.
const macArch = process.platform === 'darwin'
  ? (process.env.DWCUE_MAC_ARCH || (process.arch === 'x64' ? 'x64' : 'arm64'))
  : null;
if (macArch && !['arm64', 'x64'].includes(macArch)) {
  throw new Error(`DWCUE_MAC_ARCH must be arm64 or x64, received ${macArch}`);
}
const macCmakeArch = macArch === 'x64' ? 'x86_64' : macArch;
const macTriplet = macArch === 'x64' ? 'x64-osx-dwcue' : 'arm64-osx-dwcue';

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const cmakeCache = path.join(BUILD_DIR, 'CMakeCache.txt');
if (process.platform === 'darwin' && fs.existsSync(cmakeCache)) {
  const cache = fs.readFileSync(cmakeCache, 'utf8');
  // CMake may record command-line cache entries as STRING or UNINITIALIZED
  // depending on the preset/toolchain version. Match the key, not one cache
  // type, so switching between Intel and Apple Silicon cannot reuse the wrong
  // native dependency tree.
  const cachedArch = /CMAKE_OSX_ARCHITECTURES:[^=]+=([^\n]+)/.exec(cache)?.[1];
  const cachedTriplet = /VCPKG_TARGET_TRIPLET:[^=]+=([^\n]+)/.exec(cache)?.[1];
  const wrongArch = cachedArch !== macCmakeArch;
  const wrongTriplet = cachedTriplet !== macTriplet;
  if (wrongArch || wrongTriplet) {
    fs.rmSync(cmakeCache, { force: true });
    fs.rmSync(path.join(BUILD_DIR, 'CMakeFiles'), { recursive: true, force: true });
  }
}

const configureArgs = ['--preset', PRESET];
if (process.platform === 'darwin') {
  configureArgs.push(
    `-DCMAKE_OSX_ARCHITECTURES=${macCmakeArch}`,
    `-DVCPKG_TARGET_TRIPLET=${macTriplet}`,
    '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.3',
  );
}
run('cmake', configureArgs, { cwd: SERVER_DIR });
run('cmake', ['--build', BUILD_DIR, '--preset', PRESET], { cwd: SERVER_DIR });
