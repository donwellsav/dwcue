import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  PROJECT_FILE_EXTENSIONS,
  isLegacyProjectPath,
  isNativeProjectPath,
  projectFileAction,
  projectFileKind,
  projectPathInFolder,
} from '../app/utils/projectFileFormats';

const require = createRequire(import.meta.url);
const desktopFormats = require('../electron/project-file-formats.js');

assert.deepEqual(desktopFormats.PROJECT_EXTENSIONS, PROJECT_FILE_EXTENSIONS);
const windowsSeparator = String.fromCharCode(92);

const cases = [
  ['/shows/Opening.dwcue', 'native-project', 'open-project'],
  ['C:' + windowsSeparator + 'Shows' + windowsSeparator + 'Opening.DWCUE', 'native-project', 'open-project'],
  ['/shows/Opening.dwcuepack', 'native-archive', 'import-archive'],
  ['/legacy/Opening.liveplay', 'legacy-project', 'import-legacy-project'],
  ['C:' + windowsSeparator + 'Legacy' + windowsSeparator + 'Opening.LPA', 'legacy-archive', 'import-archive'],
  ['/shows/Opening.dwcue.backup', null, null],
  ['/shows/dwcue', null, null],
  ['/shows/.dwcue', null, null],
  ['', null, null],
] as const;

for (const [filePath, expectedKind, expectedAction] of cases) {
  assert.equal(projectFileKind(filePath), expectedKind, filePath);
  assert.equal(projectFileAction(filePath), expectedAction, filePath);
  assert.equal(desktopFormats.fileKindFor(filePath), expectedKind, filePath);
  assert.equal(desktopFormats.fileActionFor(filePath), expectedAction, filePath);
}

assert.equal(isNativeProjectPath('/shows/Opening.dwcue'), true);
assert.equal(isNativeProjectPath('/shows/Opening.liveplay'), false,
  'legacy shows must never enter native save/load routes');
assert.equal(isNativeProjectPath('/shows/Opening.dwcuepack'), false);
assert.equal(isLegacyProjectPath('/shows/Opening.liveplay'), true);
assert.equal(isLegacyProjectPath('/shows/Opening.dwcue'), false);
assert.equal(projectPathInFolder('/shows/', 'Opening'), '/shows/Opening.dwcue');
assert.equal(
  projectPathInFolder('C:' + windowsSeparator + 'Shows' + windowsSeparator, 'Opening'),
  'C:' + windowsSeparator + 'Shows' + windowsSeparator + 'Opening.dwcue',
);

const archivePaths = [
  ['/shows/Opening', '/shows/Opening.dwcuepack'],
  ['/shows/Opening.dwcuepack', '/shows/Opening.dwcuepack'],
  ['/shows/Opening.DWCUEPACK', '/shows/Opening.dwcuepack'],
  ['/legacy/Opening.lpa', '/legacy/Opening.dwcuepack'],
  ['/legacy/Opening.LPA', '/legacy/Opening.dwcuepack'],
  ['/shows/Opening.zip', '/shows/Opening.zip.dwcuepack'],
] as const;
for (const [input, expected] of archivePaths) {
  assert.equal(desktopFormats.canonicalArchivePath(input), expected, input);
}

assert.equal(
  desktopFormats.getOpenableFileFromArgv([
    '/Applications/Electron.app/Contents/MacOS/Electron',
    '.',
    '/shows/Opening.dwcue',
  ]),
  '/shows/Opening.dwcue',
  'macOS dev positional project arguments must be detected',
);
assert.equal(
  desktopFormats.getOpenableFileFromArgv(['dwcue', '/legacy/Opening.liveplay']),
  '/legacy/Opening.liveplay',
);
assert.equal(
  desktopFormats.getOpenableFileFromArgv(['dwcue', '/shows/Opening.dwcuepack']),
  '/shows/Opening.dwcuepack',
);
assert.equal(desktopFormats.getOpenableFileFromArgv(['dwcue', '--inspect=9222']), null,
  'a launch without a show or archive must remain a normal launch');
assert.equal(desktopFormats.getOpenableFileFromArgv(undefined), null,
  'missing argv must be cancel-safe');
assert.equal(desktopFormats.shouldScanInitialOpenFileArgv('darwin', true), true);
assert.equal(desktopFormats.shouldScanInitialOpenFileArgv('darwin', false), false);
assert.equal(desktopFormats.shouldScanInitialOpenFileArgv('win32', false), true);
assert.equal(desktopFormats.shouldScanInitialOpenFileArgv('linux', false), true);
assert.equal(desktopFormats.shouldRegisterProtocolClient(undefined), true);
assert.equal(desktopFormats.shouldRegisterProtocolClient(''), true);
assert.equal(desktopFormats.shouldRegisterProtocolClient('/tmp/dwcue-preview'), false,
  'isolated preview profiles must not mutate OS protocol defaults');

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(packageJson.build.productName, 'DonWells Cue');
assert.deepEqual(
  packageJson.build.fileAssociations.map(({ ext, name, description }: Record<string, string>) => ({
    ext,
    name,
    description,
  })),
  [
    { ext: 'dwcue', name: 'DonWells Cue Show', description: 'DonWells Cue Show' },
    {
      ext: 'dwcuepack',
      name: 'DonWells Cue Show Archive',
      description: 'DonWells Cue Show Archive',
    },
  ],
  'OS associations must advertise only the two canonical formats',
);

const mainSource = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
assert.match(mainSource,
  /shouldRegisterProtocolClient\(process\.env\.DWCUE_USERDATA\)/,
  'preview userData isolation must gate protocol registration');
assert.match(mainSource,
  /shouldScanInitialOpenFileArgv\(process\.platform, process\.defaultApp\)/,
  'desktop startup must apply the tested macOS development argv policy');

const serverComposableSource = readFileSync(
  new URL('../app/composables/useLiveplayServer.ts', import.meta.url),
  'utf8',
);
assert.match(serverComposableSource, /['"]\/api\/project\/import-legacy['"]/,
  'legacy show routing must use the explicit conversion endpoint');
const projectComposableSource = readFileSync(
  new URL('../app/composables/useProject.ts', import.meta.url),
  'utf8',
);
assert.equal(
  projectComposableSource.includes('if (!isNativeProjectPath(projectFilePath))'),
  true,
  'native open must reject legacy and archive paths before calling /load',
);
assert.equal(
  projectComposableSource.includes('server.importLegacyProjectFromPath(sourcePath, destinationPath)'),
  true,
  'legacy input must route through conversion rather than native load',
);
assert.equal(
  projectComposableSource.includes('if (!isNativeProjectPath(path) || !server.connected ||'),
  true,
  'automatic saves must reject every non-canonical project path',
);
assert.equal(
  projectComposableSource.includes('projectPathInFolder(folderPath, name)'),
  true,
  'new shows must always receive a canonical .dwcue path',
);

console.log('project file format tests passed');
