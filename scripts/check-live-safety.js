const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const pkg = JSON.parse(read('client/package.json'));
assert.equal(pkg.repository.url, 'https://github.com/donwellsav/dwcue.git',
  'electron-builder must resolve the update repository from the app package in CI');
assert.equal(pkg.build.win.target[0].target, 'nsis',
  'Windows releases must produce an installer');
assert.deepEqual(pkg.build.win.target[0].arch, ['x64'],
  'Windows releases must include the Windows 11 x64 target');
for (const target of pkg.build.mac.target) {
  assert.equal(target.arch, undefined,
    `macOS ${target.target} must let the build matrix select one native architecture`);
}
assert.equal(pkg.build.mac.sign, 'scripts/sign-mac.js',
  'macOS packaging must customize native-server signing');
assert.equal(pkg.build.mac.identity, '-',
  'macOS packaging must explicitly apply a complete ad-hoc signature');
assert.equal(pkg.build.mac.notarize, false,
  'macOS packaging must remain intentionally unnotarized');
assert.equal(pkg.build.afterSign, undefined,
  'macOS packaging must not invalidate its bundle signature with an afterSign re-sign');
assert.match(
  read('.github/workflows/build-release.yml'),
  /name: Validate packaged macOS DMG[\s\S]*hdiutil verify[\s\S]*_CodeSignature\/CodeResources[\s\S]*codesign --verify --deep --strict[\s\S]*Signature=adhoc/,
  'release CI must verify the complete ad-hoc signature inside the exact DMG',
);
assert.match(
  read('.github/workflows/build-release.yml'),
  /macos-15-intel[\s\S]*x64-osx-dwcue[\s\S]*macos-x64-build[\s\S]*--x64/,
  'desktop releases must build and publish a real Intel macOS artifact',
);
assert.match(
  read('.github/workflows/build-release.yml'),
  /os: macos-15[\s\S]*label: macOS Apple Silicon \(arm64\)/,
  'desktop releases must use an explicit Apple Silicon runner',
);
assert.match(
  read('.github/workflows/build-server.yml'),
  /macos-15-intel[\s\S]*x64-osx-dwcue[\s\S]*CMAKE_OSX_ARCHITECTURES=x86_64[\s\S]*dwcue-server-macos-x64/,
  'server CI must build the Intel native engine on an Intel runner',
);
assert.match(
  read('.github/workflows/build-server.yml'),
  /os: macos-15[\s\S]*label: macOS Apple Silicon \(Clang\)/,
  'server CI must use an explicit Apple Silicon runner',
);
assert.match(
  read('.github/workflows/build-release.yml'),
  /latest-mac-\$\{\{ matrix\.mac_arch \}\}\.yml/,
  'macOS updater manifests must remain separate per architecture',
);
assert.match(
  read('.github/workflows/build-release.yml'),
  /required = \{"latest-mac-arm64\.yml", "latest-mac-x64\.yml"\}[\s\S]*if missing:[\s\S]*Missing required macOS update manifest/,
  'canonical macOS updater metadata must require both architecture manifests',
);
assert.match(
  read('server/CMakeLists.txt'),
  /CMAKE_HOST_APPLE[\s\S]*CMAKE_OSX_DEPLOYMENT_TARGET "13\.3"/,
  'local Apple server builds must target macOS 13.3 or newer',
);
assert.match(
  read('server/triplets/arm64-osx-dwcue.cmake'),
  /VCPKG_TARGET_ARCHITECTURE arm64[\s\S]*VCPKG_OSX_DEPLOYMENT_TARGET 13\.3/,
  'bundled Apple Silicon server dependencies must target macOS 13.3',
);
assert.match(
  read('server/triplets/x64-osx-dwcue.cmake'),
  /VCPKG_TARGET_ARCHITECTURE x64[\s\S]*VCPKG_OSX_ARCHITECTURES x86_64[\s\S]*VCPKG_OSX_DEPLOYMENT_TARGET 13\.3/,
  'bundled Intel server dependencies must target macOS 13.3',
);
assert.doesNotMatch(
  read('server/CMakeLists.txt'),
  /_LIBCPP_DISABLE_AVAILABILITY/,
  'macOS compatibility must not bypass libc++ symbol availability checks',
);
assert.doesNotMatch(
  JSON.stringify(pkg.build.dmg),
  /(?:DW Cue|DonWells Cue) Server\.app/,
  'the release DMG must not contain an unsigned standalone server app',
);
const serverCmake = read('server/CMakeLists.txt');
assert.match(
  serverCmake,
  /MSVC[\s\S]*CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS_SKIP TRUE[\s\S]*InstallRequiredSystemLibraries[\s\S]*copy_if_different[\s\S]*CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS[\s\S]*TARGET_FILE_DIR:liveplay-server/,
  'Windows packages must stage the MSVC runtime beside the native server',
);
// MIDI files, tracker modules and game-console music were removed from the
// engine: they cost three extra libraries, a 6 MB SoundFont and their own
// build patches for formats a live show does not use.
const serverManifest = JSON.parse(read('server/vcpkg.json'));
const serverDependencyNames = serverManifest.dependencies.map(dep => typeof dep === 'string' ? dep : dep.name);
for (const removed of ['fluidsynth', 'game-music-emu', 'vgmstream']) {
  assert.ok(!serverDependencyNames.includes(removed), `${removed} must not return to the engine`);
}
assert.ok(
  !serverManifest.dependencies.some(dep => dep.name === 'ffmpeg' && dep.features.includes('openmpt')),
  'the engine FFmpeg must be built without the tracker-module library',
);
assert.doesNotMatch(serverCmake, /VCPKG_OVERLAY_PORTS|SOUNDFONT|TimGM6mb/,
  'the engine build must not depend on private ports or a bundled SoundFont');
assert.doesNotMatch(JSON.stringify(pkg.build), /TimGM6mb|\.sf2/,
  'the installer must not package a SoundFont');
assert.doesNotMatch(read('server/assets/server.rc'), /RT_MANIFEST/,
  'the Windows resource script must not duplicate CMake manifest embedding');
assert.match(serverCmake, /LIVEPLAY_RC[\s\S]*assets\/server\.manifest/,
  'CMake must merge the Windows application manifest during the executable link');
const releaseWorkflow = read('.github/workflows/build-release.yml');
const serverWorkflow = read('.github/workflows/build-server.yml');
for (const [name, workflow] of [['release', releaseWorkflow], ['server', serverWorkflow]]) {
  for (const tool of ['autoconf', 'autoconf-archive', 'automake', 'libtool']) {
    assert.match(workflow, new RegExp(`\\b${tool}\\b`),
      `${name} workflow must install ${tool} for current vcpkg Linux ports`);
  }
}
assert.match(
  releaseWorkflow,
  /workflow_dispatch:[\s\S]*publish_release:[\s\S]*default: false[\s\S]*Smoke test packaged Windows app[\s\S]*dwcue-server\.exe[\s\S]*MainWindowHandle/,
  'manual Windows validation must verify both the packaged server and desktop window',
);
assert.match(
  releaseWorkflow,
  /release:[\s\S]*if: \$\{\{ github\.event_name == 'push' \|\| inputs\.publish_release \}\}/,
  'manual validation must not publish a release unless explicitly requested',
);

const engine = read('server/src/audio/engine.cpp');
assert.match(
  engine,
  /std::shared_ptr<PlaybackItem> AudioEngine::find_cue\(const CueId& id\) const\s*{\s*std::lock_guard lock\{mutex_\};\s*auto it = items_\./,
  'engine lookup must return shared_ptr lifetimes for cues',
);
assert.match(
  engine,
  /std::shared_ptr<MixerChannel> AudioEngine::find_mixer_channel\(\s*const MixerChannelId& id\) const\s*{\s*std::lock_guard lock\{mutex_\};\s*auto it = mixers_\./,
  'engine mixer lookup must return shared_ptr lifetimes',
);
assert.match(read('server/include/liveplay/audio/engine.hpp'), /kMasterQueueBlocks = 3;/,
  'the master output stays at a three-block queue');
assert.match(engine, /const auto target = cfg_\.render_block \* kMasterQueueBlocks;/,
  'the render loop must pace against the master queue rather than total ring capacity');
assert.match(engine, /info\.id = dev\.id;/,
  'opened device rows must expose the instance id accepted by close');
assert.match(engine,
  /device_lifecycle_mutex_[\s\S]*ma_device_id_equal\([\s\S]*playback\.id/,
  'simultaneous requests must not open the same physical output twice');

const liveplayClient = read('client/app/composables/useLiveplayServer.ts');
assert.match(
  liveplayClient,
  /case 'playback_snapshot'[\s\S]*transport: 0[\s\S]*outputChannelGains\.value = Object\.fromEntries/,
  'a reconnect snapshot must clear omitted stopped cues and zeroed output gains',
);
const connectionGuard = read('client/app/composables/useConnectionGuard.ts');
assert.match(
  connectionGuard,
  /if \(hasUnsavedChanges\.value\) \{[\s\S]*?projectChanged\.value = true;[\s\S]*?sessionLost\.value = true;[\s\S]*?return;\s*\}[\s\S]*?await tryRejoinExistingProject\(header, signal\)/,
  'dirty reconnects must request an explicit choice before clean mirrors rehydrate',
);
assert.match(
  connectionGuard,
  /const joinServerSession = async[\s\S]*await tryRejoinExistingProject\(\)/,
  'dirty reconnect conflicts must require an explicit server-project join',
);
const audioClient = read('client/app/composables/useAudioEngine.ts');
assert.match(
  audioClient,
  /watch\(\[[\s\S]*currentProject\.value\?\.items\?\.length[\s\S]*server\.cues[\s\S]*Sweep server\.cues/,
  'active playback must rebuild whether project pages or the reconnect catalogue arrives last',
);

const welcome = read('client/app/components/WelcomeScreen.vue');
const appVue = read('client/app/app.vue');
assert.match(
  welcome,
  /discovered-rescan[\s\S]*:aria-label="t\('welcome\.rescan'\)"/,
  'the icon-only server rescan control must have an explicit accessible name',
);
assert.match(
  appVue,
  /<section v-else class="project-file-panel"[\s\S]*?aria-labelledby="project-file-panel-title"[\s\S]*?<h2 id="project-file-panel-title"/,
  'the project file panel must expose its heading as the region name',
);
const playlistItem = read('client/app/components/PlaylistItem.vue');
const projectDecisionPanel = read('client/app/components/ProjectDecisionPanel.vue');
const waveformTrimmer = read('client/app/components/WaveformTrimmer.vue');
const waveformTypes = read('client/app/types/project.ts');
const audioUtils = read('client/app/utils/audio.ts');
const playlistView = read('client/app/components/PlaylistView.vue');
assert.match(
  playlistView,
  /class="locate-btn locate-live"[\s\S]{0,260}:disabled="readOnly \|\| !locatableLiveUuid" @click="locateLive"[\s\S]{0,120}class="locate-btn locate-next"[\s\S]{0,260}@click="locateUpNext"[\s\S]{0,900}<PlaylistSearch/,
  'the playlist header keeps both locators, live then Up Next, ahead of the search and outside the edit-only actions',
);
assert.match(
  playlistView,
  /\.locate-live:not\(:disabled\)\s*\{[^}]*var\(--state-playing\)[\s\S]{0,200}\.locate-next:not\(:disabled\)\s*\{[^}]*var\(--state-up-next\)/,
  'the locators wear the colours of the rows they jump to: red for live, green for Up Next',
);
const propertiesPanel = read('client/app/components/PropertiesPanel.vue');
const liveMeters = read('client/app/composables/useLiveMeters.ts');
const uiMode = read('client/app/composables/useUiMode.ts');
assert.match(
  waveformTrimmer,
  /class="normalize-menu"[\s\S]*<summary class="normalize-btn"[\s\S]*properties\.normalize[\s\S]*class="normalize-popover"[\s\S]*normalizationMode = 'loudness'[\s\S]*normalizationMode = 'truePeak'[\s\S]*v-model\.number\.lazy="normalizationTarget"[\s\S]*type="number"[\s\S]*step="0\.1"[\s\S]*normalizationUnit/,
  'Properties must expose manual loudness matching and peak reduction with editable 0.1-step levels',
);
assert.match(
  waveformTrimmer,
  /const normalizationMode = ref<NormalizationMode>\('truePeak'\);[\s\S]*const peakReductionCeiling = ref\(-0\.1\);/,
  'the peak reduction control must default to a -0.1 dBTP ceiling',
);
assert.match(
  waveformTypes,
  /peaks: number\[\];[\s\S]*rms\?: number\[\];[\s\S]*channelPeaks\?: number\[\]\[\];[\s\S]*channelRms\?: number\[\]\[\];/,
  'client waveforms must retain server RMS detail beside peak traces',
);
assert.match(
  audioUtils,
  /const rmsLanes = usableChannels\.map[\s\S]*const hasRms =[\s\S]*\.\.\.\(rms \? \{ rms \} : \{\}\)[\s\S]*channelRms:/,
  'server waveform conversion must not discard combined or per-channel RMS data',
);
assert.match(
  waveformTrimmer,
  /interface WaveformLane[\s\S]*channelRms[\s\S]*const trackColor = computed[\s\S]*props\.audioItem\.color[\s\S]*const rmsColor = [\s\S]*0xffffff \^ Number\.parseInt\(trackColor\.value\.slice\(1\), 16\)[\s\S]*rmsPower[\s\S]*ctx\.fillStyle = trackColor\.value[\s\S]*fill\(envelopePath\('peak'\)\)[\s\S]*ctx\.fillStyle = rmsColor[\s\S]*fill\(envelopePath\('rms'\)\)[\s\S]*ctx\.strokeStyle = trackColor\.value[\s\S]*stroke\(envelopePath\('peak'\)\)[\s\S]*props\.audioItem\?\.color/,
  'Properties must render cue-coloured peaks and a distinct complementary RMS body',
);
assert.match(
  propertiesPanel,
  /handleNormalize = async \([\s\S]*mode: 'loudness' \| 'truePeak'[\s\S]*effectiveTarget = Math\.max\(-60, Math\.min\(0, normalizeTarget\)\)[\s\S]*applyTruePeakCeiling\(audioItem, analysis, effectiveTarget\)[\s\S]*applyLoudnessMatch\([\s\S]*effectiveTarget/,
  'manual peak reduction and normalization must use their own ceiling or target independently of the output limiter',
);
assert.match(
  liveMeters,
  /const clipDb\s*= opts\?\.clipThresholdDb \?\? 0;/,
  'the clip latch must indicate digital full scale, not valid -0.1 dBTP audio',
);
assert.match(
  playlistItem,
  /v-if="isPlaying && item\.type === 'audio'"[\s\S]{0,500}icon="restart_alt"[\s\S]{0,500}@click\.stop="handleRestart"[\s\S]{0,500}:aria-label="t\('actions\.restartCue', \{ name: item\.displayName \}\)"[\s\S]*const handleRestart = \(\) => \{[\s\S]{0,140}seekCue\(props\.item\.uuid, props\.item\.inPoint \?\? 0\)/,
  'the active-track restart control must seek to the cue In point without toggling playback',
);
assert.equal(
  (playlistItem.match(
    /<ActionButton\b(?=[^>]*class="set-next-action")(?=[^>]*:aria-pressed="isManuallyQueued")[^>]*\/>/g,
  ) ?? []).length,
  1,
  'the shared armed-next control must expose its queued state',
);
assert.match(
  playlistItem,
  /class="item-arm"[\s\S]*class="set-next-action"[\s\S]*:aria-pressed="isManuallyQueued"/,
  'Play Next must stay in the far-right arm lane in both modes',
);
assert.match(
  playlistItem,
  /class="item-transport"[\s\S]*class="restart-action"[\s\S]*class="play-action"/,
  'restart and stop/play controls must share one adjacent transport group',
);
assert.match(
  playlistItem,
  /grid-template-areas:\s*'expand identity state video actions transport duration arm'/,
  'Normal Mode must place video, edit controls, transport, clock, and Play Next in order',
);
assert.match(
  playlistItem,
  /\.playlist-item\.show-mode[\s\S]{0,900}grid-template-areas:\s*'expand identity state video actions transport duration arm'/,
  'Show Mode must keep video, edit controls, transport, clock, and Play Next in order',
);
assert.equal(
  playlistItem.includes('grid-template-columns: 34px minmax(0, 1fr) max-content max-content max-content max-content var(--cue-time-width, 96px) var(--playlist-set-next-width, 92px)'),
  true,
  'Normal Mode must let the title lane absorb space before the dynamic control lanes',
);
assert.match(
  playlistItem,
  /\.item-actions\s*\{[\s\S]{0,180}grid-template-columns:\s*repeat\(2, 32px\)/,
  'gear and trash must share a compact action lane before transport',
);
assert.match(
  playlistItem,
  /<ActionButton[\s\S]{0,180}class="preview-action"[\s\S]{0,700}<div class="item-identity">[\s\S]*\.preview-action\s*\{\s*grid-area:\s*expand;/,
  'playlist preview must sit in the left expand lane beside the cue number',
);
assert.match(
  playlistItem,
  /\.playlist-item\.show-mode[\s\S]*:deep\(\.preview-action\.action-btn--playlist\)\s*\{[\s\S]*width:\s*32px;[\s\S]*min-width:\s*32px;[\s\S]*min-height:\s*26px;/,
  'Show Mode must keep the secondary preview button at normal size',
);
assert.match(
  playlistItem,
  /\.playlist-item\.show-mode[\s\S]{0,1400}\.item-index\s*\{\s*font-size:\s*18px;[\s\S]*\.item-name,\s*&\.is-group \.item-name\s*\{\s*font-size:\s*18px;/,
  'Show Mode must use larger readable cue numbers and titles',
);
assert.match(
  playlistItem,
  /\.item-index\s*\{[\s\S]*justify-content:\s*center;[\s\S]*font-size:\s*var\(--cue-text-size\);[\s\S]*font-family:\s*var\(--font-sans\);[\s\S]*\.item-name\s*\{[\s\S]*font-size:\s*var\(--cue-text-size\);[\s\S]*\.video-badge-icon\s*\{[\s\S]*height:\s*var\(--cue-cell-height\);[\s\S]*font-size:\s*var\(--cue-text-size\);/,
  'playlist number, title, and video cells must share the readable playlist font and sizing',
);
assert.match(
  playlistItem,
  /\.item-state\s*\{[\s\S]{0,100}flex-wrap:\s*nowrap;[\s\S]*\.behavior-indicators\s*\{[\s\S]{0,100}flex-wrap:\s*nowrap;/,
  'playing status and repeat behavior must stay on one horizontal line',
);
assert.equal((playlistItem.match(/class="status-pill up-next"/g) ?? []).length, 0, 'the separate Up Next status pill must be removed');
assert.equal((playlistItem.match(/v-if="item\.endBehavior\?\.action === 'next'"/g) ?? []).length, 0, 'the obsolete end-next icon must be removed');
assert.match(playlistItem, /class="video-badge-icon"[\s\S]{0,600}>\{\{ videoCheckIssue \? 'VIDEO !' : 'VIDEO' \}\}<\/span>/, 'video cues must use a readable VIDEO text badge');
assert.doesNotMatch(playlistItem, /class="material-symbols-rounded video-badge-icon"|>movie<\/span>/, 'video cues must not use the old movie glyph');
assert.match(playlistItem, /class="set-next-action"[\s\S]{0,700}:label="t\('status\.upNext'\)"[\s\S]{0,700}:hover-label="[^"]+"/, 'the next control must combine its fixed Up Next label with the Play Next hover label');
assert.match(
  uiMode,
  /normalizeBoundedInteger[\s\S]*Math\.min\(max, Math\.max\(min, Math\.round\(number\)\)\)[\s\S]*regular:\s*\{ min: 44, max: 72, default: 44 \}[\s\S]*show:\s*\{ min: 60, max: 96, default: 68 \}[\s\S]*folder:\s*\{ min: 60, max: 96, default: 60 \}[\s\S]*normalizePlaylistRowHeight[\s\S]*REGULAR_ROW_HEIGHT_KEY[\s\S]*SHOW_ROW_HEIGHT_KEY[\s\S]*FOLDER_ROW_HEIGHT_KEY/,
  'playlist row-height preferences must remain bounded and persist per device',
);
assert.match(
  uiMode,
  /WAVEFORM_OPACITY = \{ min: 0, max: 100, default: 10 \}[\s\S]*normalizeWaveformOpacity[\s\S]*WAVEFORM_OPACITY_KEY[\s\S]*setWaveformOpacity/,
  'waveform opacity must remain bounded and persist per device',
);
assert.match(
  playlistView,
  /:style="playlistRowStyle"[\s\S]*--playlist-row-height[\s\S]*--show-playlist-row-height[\s\S]*--folder-playlist-row-height[\s\S]*--playlist-waveform-opacity/,
  'playlist density and waveform opacity must be inherited once by top-level and nested rows',
);
assert.match(
  playlistView,
  /--cue-time-width:\s*96px;/,
  'the playlist time lane must reserve the enlarged playback clock beside Play Next',
);
assert.match(
  playlistItem,
  /\.waveform-canvas\s*\{[\s\S]*opacity:\s*var\(--playlist-waveform-opacity, 0\.1\)/,
  'playlist waveform opacity must use the inherited display preference',
);
assert.match(
  playlistItem,
  /\.playlist-item\.is-playing > \.waveform-canvas\s*\{\s*opacity:\s*var\(--playlist-waveform-opacity, 0\.1\)/,
  'the playing cue waveform must honor the exact configured opacity',
);
assert.match(
  playlistItem,
  /<span class="item-color-rail" :style="\{ backgroundColor: item\.color \}" aria-hidden="true"><\/span>[\s\S]*<button[\s\S]*?class="item-name"[\s\S]*?@click="toggleFileName"[\s\S]*?\{\{ visibleTitle \}\}<span v-if="item\.note" class="item-note">\{\{ item\.note \}\}<\/span><\/button>[\s\S]*v-if="isPaused" class="status-pill paused"[\s\S]*v-else-if="isPlaying" class="status-pill playing"/,
  'cue colour must remain an independent rail while paused and playing states retain explicit priority',
);
assert.match(playlistItem, /'is-up-next': isQueuedNext/, 'queued-next state must remain on the playlist row');
assert.match(
  playlistItem,
  /\.item-name\s*\{[\s\S]{0,260}color:\s*var\(--color-text-primary\);[\s\S]*\.playlist-item\.is-playing > \.item-content \.item-name\s*\{[\s\S]{0,180}color:\s*var\(--color-text-primary\);[\s\S]*\.playlist-item\.is-paused > \.item-content \.item-name\s*\{[\s\S]{0,120}color:\s*var\(--color-text-primary\);/,
  'cue titles stay white for reading whether playing or paused; solid colour carries the state',
);
assert.match(
  playlistItem,
  /\.playlist-item\.is-up-next:not\(\.is-playing\)\s*\{[\s\S]{0,140}var\(--state-up-next\)[\s\S]*\.playlist-item\.is-playing\s*\{[\s\S]{0,140}var\(--state-playing\)[\s\S]*\.playlist-item\.is-playing\.is-paused\s*\{[\s\S]{0,120}var\(--color-text-tertiary\)[\s\S]*\.item-progress\s*\{[\s\S]{0,260}background:\s*var\(--state-playing\);[\s\S]*\.playlist-item\.is-paused \.item-progress\s*\{[\s\S]{0,100}var\(--color-text-tertiary\)[\s\S]*&\.playing\s*\{[\s\S]{0,120}background-color:\s*var\(--state-playing\)[\s\S]*&\.paused\s*\{[\s\S]{0,180}background-color:\s*var\(--color-control\);[\s\S]{0,100}color:\s*var\(--color-text-primary\);/,
  'playlist rows must use green playing, amber next, and an explicit neutral paused treatment',
);
assert.equal(
  playlistItem.includes('grid-template-columns: 34px minmax(0, 1fr) max-content max-content max-content max-content var(--cue-time-width, 96px) var(--playlist-set-next-width, 92px)') &&
    playlistItem.includes('width: fit-content;') &&
    playlistItem.includes('.item-duration {'),
  true,
  'playlist title and clock cells must size dynamically while preserving the control lanes',
);
assert.match(
  playlistItem,
  /class="item-duration"[^>]*durationColor[\s\S]*const durationColor = computed[\s\S]*countdownColorForSeconds[\s\S]*\.item-duration\s*\{[\s\S]*font-size:\s*calc\(var\(--cue-cell-height\) - 4px\);[\s\S]*line-height:\s*1;/,
  'playlist countdown cells must use countdown colors and fill the available cell height',
);
assert.match(
  playlistItem,
  /const itemStyle = computed[\s\S]{0,320}'--folder-background': 'var\(--color-surface-raised\)'/,
  'playlist structural surfaces must remain neutral independently of cue data colours',
);
assert.match(
  playlistItem,
  /\.item-progress\s*\{[\s\S]{0,100}bottom:\s*0;[\s\S]{0,100}height:\s*3px;[\s\S]{0,160}background:\s*var\(--state-playing\);/,
  'playback progress must be a compact green state line rather than a distracting row fill',
);
assert.match(
  playlistItem,
  /getComputedStyle\(canvas\)\.color[\s\S]*color:\s*var\(--waveform-color, var\(--color-text-primary\)\)/,
  'playlist waveforms must draw with the resolved CSS colour so cue data tint stays theme-aware',
);
assert.equal(
  playlistItem.includes('grid-template-columns: 34px minmax(0, 1fr) max-content max-content max-content max-content var(--cue-time-width, 96px) var(--playlist-set-next-width, 92px)'),
  true,
  'folder and audio titles must share the dynamic title lane beside aligned control lanes',
);
assert.match(
  playlistItem,
  /\.playlist-item\.is-group \+ \.playlist-item\.is-group\s*\{[\s\S]*margin-top:\s*var\(--spacing-xs\);[\s\S]*\.playlist-item\.is-group \.item-name\s*\{[\s\S]*font-weight:\s*800;/,
  'adjacent folder headers must separate spatially and use a stronger hierarchy than tracks',
);
assert.match(
  playlistItem,
  /\.playlist-item\.is-audio \.item-index,[\s\S]*\.playlist-item\.is-audio \.behavior-icon\s*\{[\s\S]*color:\s*var\(--color-text-primary\);[\s\S]*opacity:\s*0\.9;[\s\S]*:deep\(\.action-btn--playlist\)\s*\{[\s\S]*background-color:\s*var\(--color-control\);[\s\S]*\.no-device\s*\{[\s\S]*opacity:\s*1;[\s\S]*color:\s*var\(--color-text-disabled\);/,
  'track metadata and icons must stay readable without making unavailable preview controls translucent',
);
assert.doesNotMatch(
  playlistItem,
  /item-name[^\n]*is-peaking|\.item-name[\s\S]{0,300}&\.is-peaking/,
  'a true-peak warning must not turn an idle cue title red',
);
assert.equal(
  playlistItem.includes(':is-active="isPlaying"'),
  false,
  'the playlist stop button must keep the standard unfilled control appearance',
);
assert.equal(
  playlistItem.includes(":highlight-color=\"isPlaying ? 'var(--stop-edge)' :")
    && /\.play-action\.is-stop\.is-stop\s*\{[^}]*background:\s*var\(--stop-button-background\)/.test(playlistItem),
  true,
  'Stop wears the yellow-and-black stripes and never the live red',
);
assert.equal(
  playlistItem.includes('width: fit-content;') && playlistItem.includes('justify-self: start;'),
  true,
  'playlist title cells must size dynamically to their text',
);
assert.equal(
  (playlistItem.match(/item\.type === 'group' \? 'var\(--folder-play-action\)'/g) ?? []).length,
  1,
  'folder Play must use its distinct semantic tint',
);
assert.equal(
  (playlistItem.match(/item\.type === 'group' \? 'var\(--folder-next-action\)'/g) ?? []).length,
  1,
  'folder Next must use its distinct semantic tint',
);
assert.match(
  playlistItem,
  /--folder-play-action:[^;]+;[\s\S]*--folder-next-action:[^;]+;[\s\S]*&\.is-group > \.item-content :deep\(\.play-action[\s\S]*&\.is-group > \.item-content :deep\(\.set-next-action/,
  'idle folder transport buttons must remain visibly distinct from track buttons',
);
assert.match(
  playlistItem,
  /--current-playlist-row-height:\s*var\(--playlist-row-height, 44px\)[\s\S]*--current-playlist-row-height:\s*var\(--folder-playlist-row-height, 60px\)[\s\S]*min-height:\s*var\(--current-playlist-row-height\)[\s\S]*scroll-margin-top:\s*var\(--current-playlist-row-height\)[\s\S]*--current-playlist-row-height:\s*var\(--show-playlist-row-height, 68px\)[\s\S]*@container \(max-width: 700px\)/,
  'regular, Show Mode, and folder row heights must control geometry while preserving usable title space',
);
assert.match(
  playlistItem,
  /'is-sticky-group': item\.type === 'group' && isExpanded && depth === 0[\s\S]*'--folder-background': 'var\(--color-surface-raised\)'[\s\S]*&\.is-sticky-group\s*\{\s*overflow:\s*clip;[\s\S]*&\.is-sticky-group > \.item-content\s*\{[\s\S]*position:\s*sticky;[\s\S]*top:\s*0;/,
  'expanded folder headers must stay collapsible while their children scroll',
);
const mainWorkspace = read('client/app/components/MainWorkspace.vue');
const playbackControls = read('client/app/components/PlaybackControls.vue');

// The background video check and its conversions must never compete with a show.
const videoPreflight = read('client/app/composables/useVideoPreflight.ts');
const videoConvert = read('client/electron/video-convert.js');
assert.match(
  videoPreflight,
  /watch\(\[ready, transportActive\], \(\[isReady, active\]\) => \{\s*if \(!isReady \|\| active\) cancel\(\);[\s\S]*server\.onCueState\(\(\{ transport \}\) => \{ if \(transport !== 0\) cancel\(\); \}\);/,
  'anything that plays stops the video check and any conversion at once',
);
assert.match(
  videoPreflight,
  /const stop = \(\) => api\.cancelConvert\(id\);\s*signal\.addEventListener\('abort', stop, \{ once: true \}\);[\s\S]*if \(busy\.value \|\| !ready\.value \|\| transportActive\.value\) return;[\s\S]*const wanted = computed\(\(\) => ready\.value && !transportActive\.value && !busy\.value && !resting\.value &&/,
  'stopping the check stops the converter, and neither starts while a cue or Preview is running',
);
assert.match(
  videoPreflight,
  /stalls = result === 'timeout' \|\| result === 'probe-error' \? stalls \+ 1 : 0;\s*if \(stalls >= 2\) \{\s*phase\.value = 'interrupted';/,
  'one slow video is flagged and passed over; two in a row end the run rather than queue more disk reads',
);
assert.match(
  videoConvert,
  /if \(!parsed\.name \|\| parsed\.name\.endsWith\(CONVERTED_SUFFIX\)\) return null;[\s\S]*const partial = `\$\{output\}\.part`;[\s\S]*PRIORITY_BELOW_NORMAL[\s\S]*if \(result\.status !== 'converted'\) fs\.rmSync\(partial, \{ force: true \}\);[\s\S]*fs\.renameSync\(partial, output\);/,
  'a conversion writes a new copy beside the original at low priority, leaves nothing half-made, and never converts a copy again',
);
assert.doesNotMatch(
  videoConvert,
  /fs\.(?:rmSync|unlinkSync|writeFileSync|renameSync)\(\s*sourcePath|'-avoid_negative_ts'/,
  'the original video is never written to, and nothing shifts the copy\'s first picture away from zero',
);
const activeCueItem = read('client/app/components/ActiveCueItem.vue');
assert.equal(
  /\.(?:panic-btn|stop-btn|preview-stop-btn)\s*\{[^}]*(?:#d71920|--color-danger|--state-playing)/.test(playbackControls + activeCueItem),
  false,
  'Stop All and the live-card Stop buttons wear the stripes; red is kept for what is live',
);
assert.match(
  playbackControls,
  /\.panic-btn\s*\{[^}]*border:\s*var\(--stop-frame\) solid transparent;[^}]*var\(--stop-stripes\) border-box;[^}]*color:\s*var\(--stop-label\);/,
  'Stop All keeps a readable white label on a black face inside the striped frame',
);
const canvasFader = read('client/app/components/CanvasFader.vue');
const stereoMeter = read('client/app/components/StereoMeter.vue');
const volumeSlider = read('client/app/components/VolumeSlider.vue');
const projectHeader = read('client/app/components/ProjectHeader.vue');
const projectSettingsModal = read('client/app/components/ProjectSettingsModal.vue');
const projectStore = read('client/app/composables/useProject.ts');
assert.match(
  projectStore,
  /const confirmUnsavedChanges[\s\S]{0,240}if \(!hasUnsavedChanges\.value\)/,
  'project-leaving guards must inspect dirty state even when autosave is enabled',
);
assert.match(
  projectStore,
  /choice === 'save'[\s\S]{0,180}const saved = await saveProject\(\{ force: true \}\)[\s\S]{0,120}if \(!saved\)/,
  'failed forced saves must abort guarded actions',
);
assert.match(
  mainWorkspace,
  /const outputPairs = computed[\s\S]{0,1800}pairs\.push\(\{ key: 'main', leftIndex: 0, rightIndex: 1, label: mainLabel \}\);[\s\S]{0,100}pairs\.push\(\.\.\.overridePairs\)/,
  'the Main label must stay bound to output channels 0/1 even when only an override bus is active',
);
assert.doesNotMatch(
  mainWorkspace,
  /overridePairs\[[^\]]+\]!\.label\s*=\s*mainLabel/,
  'an override output must never be relabelled as Main',
);
assert.match(
  mainWorkspace,
  /class="output-console"[\s\S]*<StereoMeter[\s\S]*<VolumeSlider/,
  'the output meters and fader must stay docked beside the playlist',
);
assert.doesNotMatch(
  mainWorkspace,
  /output-target-control|onLimiterOutputTargetChange/,
  'output target selection belongs in Project Settings, not the meter and fader strip',
);
assert.match(
  mainWorkspace,
  /class="limiter-toggle"[\s\S]*:aria-pressed="!limiterEnabled"[\s\S]*limiterGainReductionLabel[\s\S]*@click="toggleLimiter"[\s\S]*limiter-toggle__label[\s\S]*limiter-toggle__gr[\s\S]*class="limiter-ceiling-control"[\s\S]*class="limiter-ceiling-input"[\s\S]*min="-60"[\s\S]*max="0"[\s\S]*step="0\.1"[\s\S]*@change="onLimiterCeilingChange"/,
  'the compact Output header must place two-line limiter status before its editable ceiling',
);
assert.match(
  mainWorkspace,
  /const limiterGainReductionDb = computed[\s\S]{0,420}master_channels[\s\S]{0,180}index === 0[\s\S]{0,120}gain_reduction_db[\s\S]{0,180}index === 1[\s\S]{0,120}gain_reduction_db[\s\S]{0,160}Math\.min\(0, left, right\)[\s\S]{0,180}limiterGainReductionDb\.value\.toFixed\(1\)/,
  'the limiter button must show the worst live L/R gain-reduction value',
);
assert.doesNotMatch(
  mainWorkspace,
  /class="limiter-ceiling-control"[\s\S]{0,120}outputConsole\.ceilingShort/,
  'the ceiling control must not repeat a visible CEIL label beside TP Limiter',
);
assert.match(
  mainWorkspace,
  /limiterCeilingLabel[\s\S]{0,220}dBTP/,
  'the limiter ceiling must be presented as true peak (dBTP)',
);
const enLocale = JSON.parse(read('client/locales/en.json'));
// Every language carries every string, with the same {placeholders}. A missing
// string silently shows English in the middle of a translated screen.
{
  const flattenLocale = (node, prefix = '') => Object.entries(node).flatMap(([key, value]) =>
    value && typeof value === 'object' ? flattenLocale(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]);
  const placeholders = text => (String(text).match(/\{[^}]*\}/g) || []).sort().join(',');
  const english = new Map(flattenLocale(enLocale));
  const localeDir = path.join(root, 'client', 'locales');
  const localeFiles = fs.readdirSync(localeDir).filter(file => file.endsWith('.json') && file !== 'en.json');
  assert.equal(localeFiles.length, 20, 'the app ships 20 languages besides English');
  for (const file of localeFiles) {
    const translated = new Map(flattenLocale(JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf8'))));
    const missing = [...english.keys()].filter(key => !translated.has(key));
    const extra = [...translated.keys()].filter(key => !english.has(key));
    assert.deepEqual(missing, [], `${file} is missing strings`);
    assert.deepEqual(extra, [], `${file} has strings the app no longer uses`);
    for (const [key, text] of english) {
      const value = translated.get(key);
      assert.ok(typeof value === 'string' && value.trim(), `${file} has an empty ${key}`);
      assert.equal(placeholders(value), placeholders(text), `${file} must keep the placeholders of ${key}`);
    }
  }
}
assert.equal(enLocale.outputConsole.ceilingInputLabel, 'True-peak limiter ceiling in dBTP');
assert.match(
  mainWorkspace,
  /patchLimiterSettings\(patch: Record<string, unknown>\)[\s\S]*await server\.patchSettings\(patch\)[\s\S]*saveProject\(\)[\s\S]*function normalizeLimiterCeiling[\s\S]*Math\.max\(-60, Math\.min\(0, value\)\)[\s\S]*function commitLimiterCeiling[\s\S]*patchLimiterSettings\(\{ limiterCeilingDb: db \}\)[\s\S]*function onLimiterCeilingChange[\s\S]*commitLimiterCeiling/,
  'ceiling edits must use the persistent project-settings path',
);
assert.match(
  projectSettingsModal,
  /:value="outputTarget"[\s\S]{0,120}@change="onOutputTargetChange"[\s\S]*function onOutputTargetChange[\s\S]{0,160}applyPatch\(\{ outputTarget: v \}\)/,
);
assert.equal(
  projectSettingsModal.includes('Preview stores the stable hardware name') &&
    projectSettingsModal.includes(':value="previewDeviceId" :options="audioDeviceOptions"') &&
    projectSettingsModal.includes('value: d.display_name'),
  true,
  'preview device settings must persist stable hardware names instead of opened-device ids',
);
assert.match(
  mainWorkspace,
  /step="0\.1"[\s\S]*@pointerdown="startLimiterCeilingDrag"[\s\S]*@pointermove="scrubLimiterCeiling"[\s\S]*@pointerup="finishLimiterCeilingDrag"[\s\S]*@pointercancel="cancelLimiterCeilingDrag"[\s\S]*limiterCeilingDragPixelsPerStep = 6[\s\S]*Math\.round\(deltaY \/ limiterCeilingDragPixelsPerStep\)[\s\S]*steps \* 0\.1[\s\S]*commitLimiterCeiling\(drag\.input\)/,
  'the limiter ceiling must support pointer scrubbing in 0.1 dB steps and commit once on release',
);
assert.match(
  mainWorkspace,
  /class="limiter-ceiling-steppers"[\s\S]*@click="stepLimiterCeiling\(0\.1\)"[\s\S]*@click="stepLimiterCeiling\(-0\.1\)"[\s\S]*\.limiter-ceiling-input\s*\{[\s\S]{0,500}cursor:\s*ns-resize;[\s\S]{0,80}touch-action:\s*none;[\s\S]*\.limiter-ceiling-steppers\s*\{/,
  'the limiter ceiling must expose integrated step arrows and advertise drag adjustment',
);
assert.match(
  stereoMeter,
  /<div v-if="slots\.footer" class="stereo-meter__footer">[\s\S]*<slot name="footer"/,
  'the console meter footer must only consume space when a footer control is supplied',
);
assert.doesNotMatch(
  mainWorkspace,
  /limiterPanelOpen|output-limiter-controls|limiter-panel|limiter-disclosure/,
  'the removed limiter foldout must not consume output-console space',
);
assert.match(
  mainWorkspace,
  /const serverDb = db <= outputConsoleMinDb \? -120 : db;[\s\S]*setOutputChannelGainDb\(leftIndex, serverDb\)[\s\S]*setOutputChannelGainDb\(rightIndex, serverDb\)/,
  'the docked stereo fader must link both channels and make its −∞ detent truly silent',
);
const workspaceOrder = [
  mainWorkspace.indexOf('<OneShotPanel>'),
  mainWorkspace.indexOf('<PlaylistView '),
  mainWorkspace.indexOf('class="output-console"'),
];
assert.ok(
  workspaceOrder.every(position => position >= 0) &&
    workspaceOrder[0] < workspaceOrder[1] && workspaceOrder[1] < workspaceOrder[2],
  'the workspace must order One Shots, playlist, then output console',
);
assert.match(
  mainWorkspace,
  /const newWidth = fromStart \/ zoom;[\s\S]*newWidth < snapThreshold[\s\S]*cartClosed\.value = true[\s\S]*newWidth > container\.offsetWidth - snapThreshold[\s\S]*cartFullscreen\.value = true/,
  'the QuickPlays splitter must snap closed at the start and expanded at the end',
);
assert.match(
  mainWorkspace,
  /'collapsed-left': cartClosed,\s*'collapsed-right': cartFullscreen/,
  'collapsed cart handles must remain reachable on their new edges',
);
assert.match(
  mainWorkspace,
  /&\.collapsed-left\s*\{[\s\S]*inset-inline-start:\s*0;[\s\S]*top:\s*var\(--panel-header-height\);/,
  'the closed-cart resize edge must start below the fixed header toggle',
);
assert.match(
  mainWorkspace,
  /class="workspace-panels"[\s\S]*id="cart-player-panel"[\s\S]*<OneShotPanel>[\s\S]*#header-leading[\s\S]*class="cart-toggle cart-toggle--open"[\s\S]*t\('oneShots\.hide'\)[\s\S]*@click="toggleCart"[\s\S]*<PlaylistView\b[^>]*>[\s\S]*#header-leading[\s\S]*v-if="cartClosed && !cartDetached"[\s\S]*class="cart-toggle(?: [^"]*)?"[\s\S]*t\('oneShots\.show'\)[\s\S]*@click="toggleCart"[\s\S]*function toggleCart\(\)[\s\S]*cartClosed\.value = !cartClosed\.value[\s\S]*cartFullscreen\.value = false/,
  'the One Shots toggle must stay in the active panel header and leave resizing to the splitter',
);
assert.match(
  mainWorkspace,
  /\.cart-toggle\s*\{[\s\S]*flex:\s*0 0 var\(--panel-control-height\);[\s\S]*width:\s*var\(--panel-control-height\);[\s\S]*height:\s*var\(--panel-control-height\);[\s\S]*:focus-visible/,
  'the in-flow cart toggle must share the panel control rail and keyboard focus treatment',
);
assert.doesNotMatch(
  mainWorkspace,
  /cart-toggle-visible|cart-is-closed|\.cart-toggle\s*\{[^}]*position:\s*absolute/,
  'the cart toggle must not use absolute positioning or compensating header classes',
);
assert.match(
  read('client/app/components/OneShotPanel.vue') + playlistView,
  /one-shot-header workspace-panel-header[\s\S]*workspace-panel-header__leading[\s\S]*slot name="header-leading"[\s\S]*playlist-header workspace-panel-header[\s\S]*workspace-panel-header__leading[\s\S]*slot name="header-leading"/,
  'One Shots and playlist headers must expose the same in-flow leading-control lane',
);
assert.doesNotMatch(
  mainWorkspace,
  /cartClosed \? 'chevron_right' : 'chevron_left'/,
  'the cart toggle icon must not flip direction and appear to dance',
);
assert.match(
  mainWorkspace,
  /v-show="recoveryOpen \|\| !cartFullscreen \|\| cartDetached" class="playlist-section"/,
  'detaching a fullscreen cart must reveal the playlist',
);
assert.match(
  mainWorkspace,
  /\.output-console\s*\{[\s\S]*border-left: 1px solid var\(--color-border\)/,
  'the right-side output console must separate itself with a left border',
);
assert.match(
  mainWorkspace,
  /v-if="monitorAssigned"[\s\S]*class="monitor-console output-console"[\s\S]*:left-index="30"[\s\S]*:right-index="31"[\s\S]*onOutputGainInput\(30, 31, db\)[\s\S]*resetOutputGain\(30, 31\)/,
  'an assigned preview device must expose a stereo-linked Monitor strip on master 30/31',
);
assert.match(
  mainWorkspace,
  /const monitorAssigned = computed\(\(\) => !!\(currentProject\.value as any\)\?\.settings\?\.previewDevice\)/,
  'Monitor visibility must follow Preview Device assignment rather than playback state',
);
assert.doesNotMatch(
  mainWorkspace,
  /key:\s*'preview-out'/,
  'preview channels must not reappear in the right-side program output bank',
);
assert.match(
  mainWorkspace,
  /\.monitor-console\s*\{[\s\S]{0,120}border-inline-start:\s*0;[\s\S]{0,120}border-inline-end:\s*1px solid var\(--color-border\)/,
  'the conditional Monitor strip must dock on the logical left edge',
);
assert.doesNotMatch(
  playbackControls,
  /class="output-meters"/,
  'the transport row must not duplicate the docked output bank',
);
const transportOrder = [
  playbackControls.indexOf('class="control-btn panic-btn"'),
  playbackControls.indexOf('class="active-cues"'),
  playbackControls.indexOf('class="control-btn play-next-btn"'),
];
assert.ok(
  transportOrder.every(position => position >= 0) &&
    transportOrder[0] < transportOrder[1] && transportOrder[1] < transportOrder[2],
  'every mode must keep Stop All left and Play Next right of the active-cue lane',
);
assert.match(
  playbackControls,
  /\.playback-controls\s*\{[\s\S]{0,180}--transport-stop-width:\s*clamp\(148px, 12vw, 176px\);[\s\S]{0,100}--transport-next-width:\s*clamp\(264px, 23vw, 416px\);[\s\S]{0,300}grid-template-columns:\s*var\(--transport-stop-width\) minmax\(0, 1fr\) var\(--transport-next-width\);[\s\S]{0,100}grid-template-areas:\s*'panic live next';[\s\S]*\.control-btn\s*\{[\s\S]{0,180}align-self:\s*stretch;[\s\S]{0,100}width:\s*100%;[\s\S]*\.play-next-btn\s*\{[\s\S]{0,100}grid-area:\s*next;[\s\S]*\.panic-zone\s*\{[\s\S]{0,100}grid-area:\s*panic;[\s\S]*\.active-cues\s*\{[\s\S]{0,100}grid-area:\s*live;[\s\S]{0,180}min-width:\s*0;/,
  'aligned console controls must keep dedicated Stop All and Play Next widths around a flexible active-cue lane',
);
assert.match(
  playbackControls,
  /\.active-cues\s*\{[\s\S]{0,220}padding:\s*0;/,
  'active cue cards must not inherit a unique four-pixel inset from the transport grid',
);
assert.match(
  playbackControls,
  /<Teleport v-if="previewingItem" defer to="#preview-lower-panel">[\s\S]*class="preview-cue-card"/,
  'Preview must leave the live transport and render in the lower workspace panel',
);
assert.match(
  mainWorkspace,
  /class="workspace-content"[\s\S]*<div id="preview-lower-panel" class="preview-lower-panel"[\s\S]*\.preview-lower-panel\s*\{[^}]*flex:\s*0 0 auto;[\s\S]*\.preview-lower-panel:empty\s*\{[\s\S]*display:\s*none;/,
  'the Preview target must fit its controls and collapse when unused',
);
assert.match(
  playbackControls,
  /class="preview-cue-card"[\s\S]*preview-status-pill[\s\S]*preview-set-next-btn[\s\S]*handleSetPreviewNext[\s\S]*preview-cue-title[\s\S]*preview-transport[\s\S]*jumpPreview\(-1\)[\s\S]*handlePreviewPause[\s\S]*preview-stop-btn[\s\S]*jumpPreview\(1\)[\s\S]*preview-jump-value[\s\S]*preview-range-marker--in[\s\S]*startPreviewBracketDrag\('in'[\s\S]*commitPreviewTimeInput\('in'[\s\S]*preview-range-marker--out[\s\S]*startPreviewBracketDrag\('out'[\s\S]*commitPreviewTimeInput\('out'[\s\S]*savePreviewTrim/,
  'the lower Preview panel must keep Set Next beside its identity, use an ordered transport, and retain editable trim markers',
);
assert.match(
  playbackControls,
  /preview-playhead-indicator[\s\S]*left: previewProgressPct[\s\S]*preview-start-next-marker[\s\S]*previewStartNextPct[\s\S]*preview-start-next-btn[\s\S]*handleSetPreviewStartNext[\s\S]*item\.startNextEnabled\s*=\s*true[\s\S]*item\.startNextTime\s*=\s*marker[\s\S]*await saveProject\(\{ force: true \}\)/,
  'Preview must show its live playhead and let the operator save that position as the cue Start Next marker',
);
assert.match(
  playbackControls,
  /setPreviewTrimAtPlayhead\('in'\)[\s\S]*setPreviewTrimAtPlayhead\('out'\)[\s\S]*function setPreviewTrimAtPlayhead[\s\S]*setPreviewBracket\(which, previewFileTime\.value, true\)/,
  'Preview Set In and Set Out must capture its playhead through the existing temporary trim path',
);
assert.match(
  waveformTrimmer,
  /mainPlayheadPosition[\s\S]*previewPlayheadPosition[\s\S]*setInPointAtPlayhead[\s\S]*setOutPointAtPlayhead[\s\S]*drawPlayheadMarker[\s\S]*--state-playing[\s\S]*--state-preview/,
  'Properties must keep distinct Main and Preview playheads and capture either playhead into In or Out',
);
assert.match(
  waveformTrimmer,
  /class="audition-set-next"[\s\S]*:aria-pressed="auditionIsNext"[\s\S]*setAuditionAsNext[\s\S]*server\.playItem\(props\.audioItem\.uuid, position\)/,
  'Properties must expose Set As Next and start stopped audition playback at its playhead',
);
assert.match(
  liveplayClient,
  /function playItem\(uuid: string, startSeconds\?: number\)[\s\S]*Number\.isFinite\(startSeconds\)[\s\S]*start_seconds: startSeconds/,
  'the item transport must carry an optional Properties audition start position',
);
assert.match(
  waveformTrimmer,
  /time-field-label-row[\s\S]*t\('properties\.inPoint'\)[\s\S]*setInPointAtPlayhead[\s\S]*t\('actions\.setIn'\)[\s\S]*time-input-with-buttons[\s\S]*time-field-label-row[\s\S]*t\('properties\.outPoint'\)[\s\S]*setOutPointAtPlayhead[\s\S]*t\('actions\.setOut'\)[\s\S]*time-input-with-buttons/,
  'Properties Set In and Set Out actions must sit beside their matching point labels',
);
assert.match(
  propertiesPanel,
  /trimSilence,[\s\S]*const persistPropertyChanges = async[\s\S]*await saveProject\(\)[\s\S]*const handleTrimSilence = async[\s\S]*trimSilence\(item(?: as AudioItem)?\)[\s\S]*await persistPropertyChanges\(\)/,
  'Properties Trim Silence must reuse the shared trim implementation and await persistence',
);
assert.match(
  mainWorkspace + playbackControls + propertiesPanel + waveformTrimmer,
  /selectedItem\.value\.uuid === previewItemUuid\.value[\s\S]*handleOpenPreviewProperties[\s\S]*openItemProperties\(previewItemUuid\.value\)[\s\S]*:preview-mode="uiMode === 'playback'"[\s\S]*class="audition-transport"[\s\S]*handleCanvasPointerDown[\s\S]*previewMode[\s\S]*startPreview\(props\.audioItem\.uuid\)/,
  'Show Mode Preview must open the same cue in Properties and reuse its safe preview path for audition transport and playhead scrubbing',
);
assert.match(
  mainWorkspace,
  /class="lower-workspace-panel"[\s\S]*:style="\{ height: lowerPanelHeight, maxHeight: [^"]+\}"[\s\S]*class="lower-panel-resize-handle"[\s\S]*role="separator"[\s\S]*@pointerdown="startPanelResize"[\s\S]*@keydown="handlePanelResizeKey"/,
  'Settings, Properties, and imports must share the pointer and keyboard resize control',
);
assert.match(
  mainWorkspace,
  /settingsHeight = useState<number \| null>\('ProjectSettingsPanel.height', \(\) => null\);[\s\S]*autoSizeImportPanel = computed\(\(\) => visibleImportPanel\.value === 'delete-selection' \|\| visibleImportPanel\.value === 'repair'\s*\|\| visibleImportPanel\.value === 'import-choice' \|\| visibleImportPanel\.value === 'video-capture'\);[\s\S]*panelHeight = computed\(\(\) => showProjectSettings\.value \? settingsHeight\.value\s*: autoSizeImportPanel\.value \? null\s*: visibleImportPanel\.value \? importHeight\.value : propertiesHeight\.value\);/,
  'each lower panel must fit its contents until the operator resizes it',
);
assert.ok(mainWorkspace.includes('<DeleteSelectionPanel v-if="visibleImportPanel === \'delete-selection\'" />')
  && !/\bconfirm\(t\('actions\.confirmDelete'/.test(playlistItem),
  'playlist deletes must use the lower panel instead of a blocking native confirmation');
assert.match(
  mainWorkspace,
  /\.workspace-content\s*\{[^}]*min-height:\s*calc\(var\(--panel-header-height\) \+ var\(--reserved-playlist-row-height\)[^}]*\}[\s\S]*\.lower-workspace-panel\s*\{[^}]*flex:\s*0 1 auto;/,
  'the lower panel must give up space before the playlist loses a cue row',
);
assert.match(
  waveformTrimmer,
  /const canvasHeight = Math\.max\(120, waveformContainer\.value\?\.clientHeight \?\? 120\);[\s\S]*new ResizeObserver[\s\S]*\.waveform-container\s*\{[\s\S]{0,160}flex:\s*1;[\s\S]{0,80}min-height:\s*120px;/,
  'the Properties waveform must use the available panel height and redraw at that measured size',
);
assert.match(
  activeCueItem,
  /class="cue-meter"[\s\S]*<StereoMeter[\s\S]*:cue-id="serverCueId"/,
  'active cue cards must retain their server-driven stereo meter',
);
assert.match(
  playbackControls,
  /class="preview-cue-meter"[\s\S]*<StereoMeter[\s\S]*:left-index="30"[\s\S]*:right-index="31"/,
  'preview cue meters must match the active cue meter layout',
);
assert.match(
  canvasFader,
  /dbToConsolePosition[\s\S]*consolePositionToDb[\s\S]*dragStartNorm/,
  'fader drawing and interaction must share the console taper',
);
assert.match(
  stereoMeter,
  /const meterMinDb = -60;[\s\S]*const meterMaxDb = 0;[\s\S]*meterPosition[\s\S]*dbToConsolePosition\(db, meterMinDb, meterMaxDb\)[\s\S]*function fillStyle[\s\S]*meterPosition\(db\)/,
  'signal meters must use their own −60…0 dB calibration instead of the +40 dB fader-gain scale',
);
assert.match(
  stereoMeter,
  /const meterGradient = computed[\s\S]*METER_COLORS\.green[\s\S]*METER_COLORS\.yellow[\s\S]*METER_COLORS\.red[\s\S]*background:\s*meterGradient\.value/,
  'meter fills must reveal fixed safe, warning, and danger zones',
);
assert.match(
  stereoMeter,
  /\.stereo-meter:not\(\.stereo-meter--strip\)[\s\S]*width:\s*26px;[\s\S]*padding:\s*0;[\s\S]*background:\s*transparent;[\s\S]*border:\s*0;[\s\S]*grid-template-rows:\s*6px minmax\(0, 1fr\);[\s\S]*padding:\s*1px 0;/,
  'compact cue meters must use their height for signal without nested strip chrome',
);
assert.match(
  stereoMeter,
  /const candidates = \[[\s\S]*maxDb,[\s\S]*20,[\s\S]*10,[\s\S]*5,[\s\S]*0,[\s\S]*-5,[\s\S]*-10,[\s\S]*-20,[\s\S]*-40,[\s\S]*minDb,/,
  'the docked meter scale must show the full console reference range',
);
assert.match(
  stereoMeter,
  /label:\s*db > 0 \? `\+\$\{Math\.round\(db\)\}`/,
  'positive shared-scale values must include + so their tick cannot read as a minus',
);
const meterTemplate = stereoMeter.slice(0, stereoMeter.indexOf('<script setup'));
assert.match(
  meterTemplate,
  /holdL\.clipped\.value[\s\S]*@click="holdL\.resetClip"[\s\S]*holdR\.clipped\.value[\s\S]*@click="holdR\.resetClip"/,
  'left and right clip latches must reset independently',
);
assert.doesNotMatch(
  meterTemplate,
  /holdL\.clipped\.value \|\| holdR\.clipped\.value/,
  'one clipped channel must not light both clip indicators',
);
assert.match(
  stereoMeter,
  /Left clip indicator, clipped\. Activate to reset[\s\S]*Right clip indicator, clipped\. Activate to reset[\s\S]*&::before\s*\{[\s\S]*inset:\s*-7px -6px/,
  'clip reset lamps must expose their state and retain a practical pointer target',
);
assert.match(
  stereoMeter,
  /const bodyL = computed\(\(\) => meterMode\.value === 'LUFS'[\s\S]*function peakCapStyle[\s\S]*const rmsStyleL\s*= computed\(\(\) => fillStyle\(bodyL\.value\)\)[\s\S]*&__rms-fill[\s\S]*opacity:\s*0\.72[\s\S]*&__peak-cap[\s\S]*background:\s*currentColor[\s\S]*&__hold[\s\S]*background:\s*var\(--color-text-primary\)/,
  'meters must render a readable body, a precise peak cap, and a separate held peak line',
);
assert.match(
  stereoMeter,
  /&__track::after[\s\S]*repeating-linear-gradient\([\s\S]*transparent 0 4px,[\s\S]*var\(--color-control\) 4px 6px/,
  'meter tracks must keep consistent segment guides across lit and unlit levels',
);
assert.match(
  meterTemplate,
  /stereo-meter__bars[\s\S]*stereo-meter__gr-lane[\s\S]*role="meter"[\s\S]*Maximum gain reduction of independent left and right limiters[\s\S]*stereo-meter__scale/,
  'output strips must keep an always-visible, truthfully labelled GR lane between signal and fader scale',
);
assert.doesNotMatch(
  stereoMeter,
  /showGainReduction/,
  'limiter reduction must never disappear while the meter strip is visible',
);
assert.doesNotMatch(
  stereoMeter,
  /stereo-meter__gr-text|gainReductionLabel|GR MAX/,
  'gain-reduction numbers belong on the limiter button, not inside either meter',
);
assert.match(
  stereoMeter,
  /const worstGainReductionDb = computed\(\(\) => Math\.min\([\s\S]*leftStream\.gainReduction\.value,[\s\S]*rightStream\.gainReduction\.value,[\s\S]*const gainReductionFloorDb = computed\(\(\) => Math\.min\(props\.minDb, 0\)\)[\s\S]*dbToConsolePosition\(clamped, floor, 0\)/,
  'the single GR lane must show the signed worst L/R limiter and run from 0 at the top through the shared negative taper',
);
assert.match(
  stereoMeter,
  /&__bars\s*\{[^}]*grid-column:\s*1;/,
  'the shared scale must sit to the right of the meter bars',
);
assert.match(
  stereoMeter,
  /&__gr-lane\s*\{[^}]*grid-column:\s*2;/,
  'the GR lane must occupy its own strip column',
);
assert.match(
  stereoMeter,
  /&__scale\s*\{[^}]*grid-column:\s*3;/,
  'the GR lane must sit between the meter bars and the shared scale/fader column',
);
const meterMarkOrder = [
  meterTemplate.indexOf('class="stereo-meter__mark-text"'),
  meterTemplate.indexOf('class="stereo-meter__mark-tick"'),
];
assert.ok(
  meterMarkOrder.every(position => position >= 0) && meterMarkOrder[0] < meterMarkOrder[1],
  'shared values must sit between the meter bars and the overlaid fader rail',
);
assert.match(
  volumeSlider,
  /<CanvasFader[\s\S]*class="volume-slider__label-wrap"/,
  'the output gain value must remain below the fader',
);
assert.match(
  mainWorkspace,
  /<template #scale-control>[\s\S]{0,200}<VolumeSlider[\s\S]{0,100}class="output-pair__fader"[\s\S]{0,100}:inline-scale="true"[\s\S]*\.output-pair__fader\s*\{[\s\S]*display:\s*contents/,
  'the output fader must occupy the meter scale grid cell instead of another column',
);
assert.match(
  canvasFader,
  /width:\s*48px[\s\S]*cursor:\s*ns-resize/,
  'the output fader must keep a full-width, vertically draggable grab target',
);
assert.match(
  canvasFader,
  /Purpose-built console rail[\s\S]*const capW = Math\.min\(34, w - 8\)[\s\S]*const capH = 18[\s\S]*ctx\.fillStyle = surfaceRaised[\s\S]*ctx\.strokeStyle = borderStrong[\s\S]*ctx\.strokeStyle = props\.db > 0\.05[\s\S]*warning[\s\S]*success[\s\S]*accent/,
  'the aligned console fader must retain a substantial grab cap with precise control-surface styling',
);
assert.doesNotMatch(
  canvasFader,
  /createLinearGradient|shadowBlur = 5/,
  'the output fader must not reintroduce the old three-dimensional rack chrome',
);
assert.match(
  canvasFader,
  /<div\b(?=[^>]*class="canvas-fader")(?=[^>]*role="slider")(?=[^>]*tabindex="0")(?=[^>]*aria-orientation="vertical")(?=[^>]*:aria-label)(?=[^>]*:aria-valuemin)(?=[^>]*:aria-valuemax)(?=[^>]*:aria-valuenow)(?=[^>]*:aria-valuetext)(?=[^>]*@keydown="onKeyDown")[^>]*>/,
  'the custom fader must expose a complete named slider value to assistive technology',
);
assert.match(
  canvasFader,
  /function onKeyDown[\s\S]*ArrowUp[\s\S]*ArrowDown/,
  'the custom fader must remain keyboard-operable',
);
assert.match(
  canvasFader,
  /function onWheel[\s\S]*const current = Math\.max\(props\.minDb, props\.db\);[\s\S]*function onKeyDown[\s\S]*const current = Math\.max\(props\.minDb, props\.db\);/,
  'wheel and keyboard movement must recover cleanly from the server −120 dB mute value',
);
assert.match(
  stereoMeter,
  /grid-template-rows:\s*6px minmax\(40px, 1fr\);[\s\S]*&--strip &__body\s*\{[\s\S]*grid-template-columns:\s*28px 8px 72px;[\s\S]*grid-template-rows:\s*6px minmax\(40px, 1fr\) 20px;[\s\S]*column-gap:\s*8px;[\s\S]*row-gap:\s*2px;[\s\S]*&__scale\s*\{[\s\S]*grid-row:\s*2;[\s\S]*margin:\s*10px 0;[\s\S]*&__bars\s*\{[\s\S]*grid-row:\s*2;[\s\S]*padding:\s*10px 0;[\s\S]*&__gr-lane\s*\{[\s\S]*grid-row:\s*2;[\s\S]*margin:\s*10px 0;/,
  'meter tracks and the shared scale must use the same vertical pixel box',
);
assert.match(
  canvasFader,
  /const trackPadding = 10;[\s\S]*host\.clientHeight - trackPadding \* 2/,
  'fader travel must use the same 10px endpoints as the meter and scale',
);
assert.match(
  volumeSlider,
  /volume-slider--inline[\s\S]*display:\s*contents;[\s\S]*grid-column:\s*3;[\s\S]*grid-row:\s*2;[\s\S]*volume-slider__label-wrap[\s\S]*grid-column:\s*3;[\s\S]*grid-row:\s*3;[\s\S]{0,80}justify-self:\s*end;[\s\S]{0,80}height:\s*20px;[\s\S]{0,80}width:\s*64px;/,
  'the editable fader value must sit under the aligned 64-pixel console readout lane',
);
assert.match(
  volumeSlider,
  /volume-slider--inline \.volume-slider__label\s*\{[\s\S]{0,160}width:\s*64px;[\s\S]{0,100}padding:\s*2px 4px;[\s\S]*volume-slider--inline \.volume-slider__input\s*\{[\s\S]{0,220}right:\s*0;[\s\S]{0,260}width:\s*64px;[\s\S]{0,120}padding:\s*0 4px;[\s\S]{0,80}text-align:\s*right;[\s\S]*\.volume-slider__label\s*\{[\s\S]{0,160}display:\s*grid;[\s\S]{0,100}grid-template-columns:\s*minmax\(0, 1fr\) auto;[\s\S]{0,80}gap:\s*3px;[\s\S]{0,180}min-width:\s*64px;[\s\S]{0,100}padding:\s*3px 4px;[\s\S]{0,260}font-size:\s*12px;[\s\S]*\.volume-slider__value\s*\{[\s\S]{0,100}text-align:\s*right;[\s\S]*\.volume-slider__unit\s*\{[\s\S]{0,140}font-size:\s*11px;[\s\S]{0,120}text-transform:\s*none;/,
  'the displayed and edited fader values must fit one legible 64-pixel console column',
);
assert.match(
  projectHeader,
  /const primaryActiveCue = computed\(\(\) => \[\.\.\.activeCues\.value\.values\(\)\]\.at\(-1\)[\s\S]*const displayedRemainingSeconds = computed<number \| null>[\s\S]*Number\.isFinite\(cue\.duration\)[\s\S]*Number\.isFinite\(cue\.currentTime\)[\s\S]*Math\.max\(0, Math\.ceil\(cue\.duration - cue\.currentTime\)\)/,
  'the header countdown must follow the newest active cue and never go negative',
);
assert.match(
  projectHeader,
  /t\('project\.timeLeft'\)[\s\S]*:style="\{ color: timeLeftColor \?\? undefined \}"[\s\S]*\{\{ timeLeft \}\}[\s\S]*countdownColorForSeconds\([\s\S]*displayedRemainingSeconds\.value[\s\S]*countdownColorBands[\s\S]*\.clock--large \.clock-value\s*\{[\s\S]*font-size:\s*var\(--type-clock-size\)/,
  'the header must retain the large Time Left clock',
);
assert.match(
  projectSettingsModal,
  /addCountdownBand[\s\S]*countdownColorBands[\s\S]*type="number"[\s\S]*<InlineColorPicker[\s\S]*removeCountdownBand[\s\S]*saveProject/,
  'countdown colour thresholds must be editable, addable, removable, and saved with the project',
);
assert.doesNotMatch(projectSettingsModal + read('client/app/components/TestCardControls.vue'),
  /type\s*[:=]\s*['"]color['"]/,
  'Time Left and Test Card colors must not open native color dialogs');
assert.match(
  projectSettingsModal,
  /regular-playlist-row-height[\s\S]*type="range"[\s\S]*PLAYLIST_ROW_HEIGHTS\.regular[\s\S]*show-playlist-row-height[\s\S]*type="range"[\s\S]*PLAYLIST_ROW_HEIGHTS\.show[\s\S]*folder-playlist-row-height[\s\S]*type="range"[\s\S]*PLAYLIST_ROW_HEIGHTS\.folder[\s\S]*onPlaylistRowHeightInput/,
  'User Interface settings must expose independent regular, Show Mode, and folder row-height controls',
);
assert.match(
  projectSettingsModal,
  /playlist-waveform-opacity[\s\S]*type="range"[\s\S]*WAVEFORM_OPACITY\.min[\s\S]*WAVEFORM_OPACITY\.max[\s\S]*onWaveformOpacityInput/,
  'User Interface settings must expose the waveform opacity control',
);
assert.match(
  projectSettingsModal,
  /let settingsPatchQueue = Promise\.resolve\(\);[\s\S]*const queued = settingsPatchQueue\.then[\s\S]*currentProject\.value !== project[\s\S]*await server\.patchSettings\(patch\)[\s\S]*project\.settings = restored[\s\S]*await saveProject\(\)[\s\S]*settingsPatchQueue = queued\.then/,
  'settings edits must serialize acknowledgements, restore rejected values, and retain project identity through save',
);
assert.match(
  projectSettingsModal,
  /:checked="cycleTrackColors"[\s\S]{0,200}@change="onCycleTrackColorsChange"/,
  'project settings must expose persisted track-color cycling',
);

const transpiledProject = ts.transpileModule(
  read('client/app/types/project.ts'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const projectRuntime = { exports: {} };
Function('exports', 'module', transpiledProject)(projectRuntime.exports, projectRuntime);
const {
  CART_SLOT_COUNT_LIMITS,
  DEFAULT_COUNTDOWN_COLOR_BANDS,
  DEFAULT_PROJECT_SETTINGS,
  PRESET_COLORS,
  colorForNewAudioItem,
  normalizeCartSlotCount,
  normalizeCountdownColorBands,
  countdownColorForSeconds,
  countdownInk,
} = projectRuntime.exports;
assert.deepEqual(CART_SLOT_COUNT_LIMITS, { min: 1, max: 64, default: 16 });
assert.equal(DEFAULT_PROJECT_SETTINGS.cartSlotCount, 16);
assert.equal(DEFAULT_PROJECT_SETTINGS.cycleTrackColors, true);
assert.equal(PRESET_COLORS.includes('#FF0000'), false);
assert.equal(PRESET_COLORS.includes('#CC0000'), false);
assert.equal(colorForNewAudioItem(undefined, 0), PRESET_COLORS[0]);
assert.equal(colorForNewAudioItem(undefined, 1), PRESET_COLORS[1]);
assert.equal(colorForNewAudioItem(undefined, PRESET_COLORS.length), PRESET_COLORS[0]);
assert.equal(colorForNewAudioItem({ cycleTrackColors: false }, 5), PRESET_COLORS[0]);
assert.equal(normalizeCartSlotCount(undefined), 16);
assert.equal(normalizeCartSlotCount(999), 64);
assert.equal(normalizeCartSlotCount(4, [{ slot: 31 }]), 32);
assert.equal(normalizeCartSlotCount(4, [], { 31: {} }), 32);
assert.equal(normalizeCartSlotCount(4, [{ slot: -1 }, { slot: 1.5 }, { slot: 63 }]), 64);
assert.deepEqual(DEFAULT_COUNTDOWN_COLOR_BANDS, [
  { startSeconds: 11, color: '#35A96B' },
  { startSeconds: 6, color: '#D8AD35' },
  { startSeconds: 0, color: '#E54855' },
]);
assert.deepEqual(
  normalizeCountdownColorBands([
    { startSeconds: 6, color: '#abcdef' },
    { startSeconds: 20, color: '#123456' },
  ]),
  [
    { startSeconds: 20, color: '#123456' },
    { startSeconds: 6, color: '#ABCDEF' },
    { startSeconds: 0, color: '#E54855' },
  ],
);
assert.deepEqual(
  normalizeCountdownColorBands([{ startSeconds: 'bad', color: 'red' }]),
  DEFAULT_COUNTDOWN_COLOR_BANDS,
);
// The countdown is a stop light of its own: green, then yellow, then red.
assert.equal(countdownColorForSeconds(11, undefined), '#35A96B');
assert.equal(countdownColorForSeconds(30, [
  { startSeconds: 11, color: '#123456' }, { startSeconds: 0, color: '#E54855' },
]), '#123456');
assert.equal(countdownColorForSeconds(10, undefined), '#D8AD35');
assert.equal(countdownColorForSeconds(6, undefined), '#D8AD35');
assert.equal(countdownColorForSeconds(5, undefined), '#E54855');
assert.equal(countdownColorForSeconds(0, undefined), '#E54855');
assert.equal(countdownColorForSeconds(10.1, undefined), '#35A96B');
assert.equal(countdownColorForSeconds(null, undefined), null);
// On the light console the digits are deepened so green and yellow still read.
assert.equal(countdownInk('#D8AD35', 'dark'), '#D8AD35');
assert.equal(countdownInk('#D8AD35', 'light'), 'color-mix(in srgb, #D8AD35 60%, #000000)');
assert.equal(countdownInk(null, 'light'), null);

const transpiledAudio = ts.transpileModule(
  read('client/app/utils/audio.ts'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const audioRuntime = { exports: {} };
Function('exports', 'module', transpiledAudio)(audioRuntime.exports, audioRuntime);
const {
  applyTruePeakCeiling,
  dbToConsolePosition,
  consolePositionToDb,
  exceedsTruePeakCeiling,
} = audioRuntime.exports;
const peakAnalysis = { analysis_version: 2, true_peak_dbtp: 0.9 };
assert.equal(exceedsTruePeakCeiling(
  { duration: 60, inPoint: 0, outPoint: 60, volume: 1, waveform: { ...peakAnalysis, duration: 60 } },
  -0.1,
), true);
assert.equal(exceedsTruePeakCeiling(
  { duration: 60, inPoint: 0, outPoint: 60, volume: 0.5, waveform: { ...peakAnalysis, duration: 60 } },
  -0.1,
), false);
const reducedPeakItem = { volume: 1 };
assert.equal(applyTruePeakCeiling(reducedPeakItem, peakAnalysis, -1), true);
assert.ok(Math.abs(peakAnalysis.true_peak_dbtp
  + 20 * Math.log10(reducedPeakItem.volume) - (-1)) < 1e-9);
assert.equal(applyTruePeakCeiling(reducedPeakItem, peakAnalysis, -1), false);
assert.equal(applyTruePeakCeiling(
  { volume: 1 },
  { analysis_version: 2, true_peak_dbtp: -120 },
  -1,
), false);
const consoleDbValues = [-60, -40, -20, -10, 0, 10, 40];
const consolePositions = consoleDbValues.map(
  db => dbToConsolePosition(db, -60, 40),
);
for (let i = 1; i < consolePositions.length; i++) {
  assert.ok(consolePositions[i] > consolePositions[i - 1],
    'console taper must increase monotonically');
}
for (let i = 0; i < consoleDbValues.length; i++) {
  assert.ok(Math.abs(
    consolePositionToDb(consolePositions[i], -60, 40) - consoleDbValues[i],
  ) < 1e-9, 'console taper must round-trip every reference level');
}
assert.ok(consolePositions[4] > 0.7 && consolePositions[4] < 0.9,
  'console taper must reserve most fader travel for levels around unity');
assert.match(
  welcome,
  /watch\(stage,[\s\S]*queueStageFocus\(s\)[\s\S]*function queueStageFocus[\s\S]*remoteAddressInput[\s\S]*newProjectButton/,
  'welcome-stage changes must place keyboard focus in the newly rendered stage',
);

const playbackItem = read('server/src/audio/playback_item.cpp');
const renderBlockStart = playbackItem.indexOf('std::size_t PlaybackItem::render_block');
const renderBlockEnd = playbackItem.indexOf(
  'bool PlaybackItem::take_natural_end', renderBlockStart);
const itemRender = playbackItem.slice(renderBlockStart, renderBlockEnd);
const decodeFailureStart = itemRender.indexOf(
  'stop_for_decode_error(decoder_result)');
const naturalEndStart = itemRender.indexOf(
  'if (natural_end) handle_natural_end()');
assert.ok(decodeFailureStart >= 0 && naturalEndStart > decodeFailureStart,
  'queued decoder failure and natural-end branches must both exist in order');
const decodeFailureHandlerStart = playbackItem.indexOf(
  'void PlaybackItem::stop_for_decode_error');
const decodeFailureHandlerEnd = playbackItem.indexOf(
  'void PlaybackItem::handle_natural_end', decodeFailureHandlerStart);
const decodeFailurePath = playbackItem.slice(
  decodeFailureHandlerStart, decodeFailureHandlerEnd);
assert.match(decodeFailurePath, /transport_\.store\(TransportState::Stopped/,
  'an unexpected decoder read failure must stop the cue');
assert.match(itemRender.slice(decodeFailureStart, naturalEndStart), /return 0;/,
  'an unexpected decoder read failure must return before natural-end/follow logic');

const projectStateHeader = read('server/include/liveplay/core/project_state.hpp');
const projectState = read('server/src/core/project_state.cpp');
const atomicFile = read('server/include/liveplay/util/atomic_file.hpp');
assert.match(
  projectState,
  /bool ProjectState::start_preview[\s\S]*out_point = it\.value\("outPoint", 0\.0\);[\s\S]*endBehavior[\s\S]*== "loop"[\s\S]*set_out_point_seconds\(out_point > in_point \? out_point : 0\.0\);[\s\S]*set_loop\(loop, in_point\);[\s\S]*prime\(2\.0, in_point\)/,
  'Preview must inherit the selected track’s permanent In/Out and loop behavior before playback starts',
);
const sequencerStart = projectState.indexOf('void ProjectState::sequencer_loop()');
const sequencerEnd = projectState.indexOf('void ProjectState::execute_custom_action', sequencerStart);
const sequencer = projectState.slice(sequencerStart, sequencerEnd);
assert.ok(sequencer.indexOf('take_decode_error()') >= 0 &&
          sequencer.indexOf('take_decode_error()') <
            sequencer.indexOf('if (pi->take_natural_end())'),
  'the sequencer must consume decoder failures before natural-end/follow checks');
assert.match(sequencer, /case PendingAction::Kind::PlaybackError:[\s\S]*follow action suppressed/,
  'decoder failures must have a dedicated non-follow event path');
assert.match(projectState,
  /bool ProjectState::save[\s\S]*util::replace_file_atomically\(tmp, path, ec\)/,
  'project save must use the shared cross-platform atomic replacement helper');
assert.match(atomicFile,
  /MoveFileExW[\s\S]*MOVEFILE_REPLACE_EXISTING/,
  'Windows project replacement must atomically replace the existing save');

const controlServer = read('server/src/net/control_server.cpp');
const projectFileHeader = read('server/include/liveplay/core/project_file.hpp');
const projectFile = read('server/src/core/project_file.cpp');
const projectArchive = read('server/src/net/project_archive.cpp');
const controlSecurity = read('server/include/liveplay/net/control_security.hpp');
assert.match(
  projectFileHeader,
  /kNativeProjectExtension = "\.dwcue"[\s\S]*kNativeArchiveExtension = "\.dwcuepack"/,
  'native show and archive extensions must remain explicit',
);
assert.match(
  projectFile,
  /lower_extension[\s\S]*std::tolower[\s\S]*bool is_native_project[\s\S]*kNativeProjectExtension[\s\S]*bool is_native_archive[\s\S]*kNativeArchiveExtension/,
  'project and archive extension classification must remain case-insensitive',
);
assert.match(
  projectFile,
  /bool write_new_canonical_project[\s\S]*CreateFileW\([\s\S]*CREATE_NEW[\s\S]*O_EXCL/,
  'new native shows must use exclusive creation on every platform',
);
assert.match(
  projectArchive,
  /normalize_archive_entry_path\(raw_name\)[\s\S]*archive_entry_type_is_safe[\s\S]*charge_archive_entry[\s\S]*archive_destination_is_safe/,
  'archive extraction must reject traversal, links, special entries, and budget overruns before writing',
);
assert.match(
  projectArchive,
  /bool archive_destination_is_safe[\s\S]*symlink_status[\s\S]*is_symlink[\s\S]*canonical_path_is_within/,
  'archive extraction must reject symlink and canonical-path escapes',
);
assert.match(
  `${atomicFile}\n${projectArchive}`,
  /inline bool rename_no_replace[\s\S]*MoveFileExW\(source\.c_str\(\), target\.c_str\(\), MOVEFILE_WRITE_THROUGH\)[\s\S]*renamex_np\(source\.c_str\(\), target\.c_str\(\), RENAME_EXCL\)[\s\S]*SYS_renameat2[\s\S]*kRenameNoReplace[\s\S]*OperationResult reserve_and_publish[\s\S]*if \(!state\.exists\)[\s\S]*rename_no_replace\(staging, destination, error\)[\s\S]*error == std::errc::file_exists[\s\S]*rename_no_replace\(destination, empty_placeholder, error\)[\s\S]*symlink_status\(empty_placeholder, error\)[\s\S]*is_directory\(placeholder_status\)[\s\S]*!fs::is_symlink\(placeholder_status\)[\s\S]*is_empty\(empty_placeholder, error\)[\s\S]*rename_no_replace\(empty_placeholder, destination, restore_error\)[\s\S]*rename_no_replace\(staging, destination, error\)[\s\S]*rename_no_replace\(empty_placeholder, destination, restore_error\)[\s\S]*is_directory\(final_status\)[\s\S]*!fs::is_symlink\(final_status\)[\s\S]*is_empty\(empty_placeholder, error\)/,
  'archive import publication must use native no-replace moves, preserve empty destinations, and restore only into unused names',
);
const mainCpp = read('server/src/main.cpp');
assert.match(
  projectStateHeader + projectState + controlServer,
  /start_position_override_sec[\s\S]*std::clamp\(start_position_override_sec, in_point,[\s\S]*playback->prime\(2\.0, play_start\)[\s\S]*start_seconds must be a number[\s\S]*start_seconds requires an audio item[\s\S]*state\.play_item\(uuid, -1\.0, audio::CueId\{\}, \*start_seconds, expected_stop_revision\)/,
  'the server must validate and clamp Properties audition starts before priming audio',
);
assert.match(
  controlServer,
  /wait_for_server_start[\s\S]*if \(!impl_->app\.is_bound\(\)\)[\s\S]*return false/,
  'the server must confirm Crow actually bound before publishing startup success',
);
assert.match(
  controlServer,
  /type == "preview_range"[\s\S]*current_preview_cue_id\(\)[\s\S]*out_seconds <= in_seconds[\s\S]*set_out_point_seconds\(out_seconds\)[\s\S]*set_loop\(j\.value\("loop", false\), in_seconds\)/,
  'temporary Preview ranges must be validated and applied only to the active Preview cue',
);
assert.match(
  projectArchive,
  /bool output_is_excluded[\s\S]*paths_equivalent\(candidate, output_zip\)[\s\S]*paths_equivalent\(candidate, excluded_final_output\)[\s\S]*output_is_excluded\(\s*it->path\(\), output_zip, excluded_final_output\)[\s\S]*continue;/,
  'project exports must skip both staging and final archive outputs during zip creation',
);
assert.match(
  projectArchive,
  /is_chunked_upload_staging_name\(filename\)[\s\S]*is_export_staging_name\(filename\)[\s\S]*output_is_excluded[\s\S]*paths_equivalent\(it->path\(\), active_project\)[\s\S]*continue;/,
  'project exports must skip upload staging, orphan export staging, output archives, and duplicate project roots',
);
assert.match(
  controlServer,
  /CROW_ROUTE\(app, "\/api\/upload\/start"\)[\s\S]*kChunkedUploadChunkBytes[\s\S]*CROW_ROUTE\(app, "\/api\/upload\/<string>"\)\.methods\(crow::HTTPMethod::Put\)[\s\S]*offset != session\.received_bytes[\s\S]*chunk_bytes >[\s\S]*session\.expected_bytes - session\.received_bytes/,
  'chunked uploads must advertise a bounded chunk and enforce sequential declared-size writes',
);
assert.match(
  controlServer,
  /out = tmp \/ \(download_token \+ "\.dwcuepack"\);[\s\S]*download_token/,
  'temporary archive exports should use generated tokens, not projectName-derived paths',
);
const downloadRouteStart = controlServer.indexOf('CROW_ROUTE(app, "/api/file/download")');
const downloadRouteEnd = controlServer.indexOf('CROW_ROUTE(app, "/api/project/import")', downloadRouteStart);
const downloadRoute = controlServer.slice(downloadRouteStart, downloadRouteEnd);
assert.match(
  downloadRoute,
  /const char\* token = req\.url_params\.get\("token"\);[\s\S]*claim_download_token\(token\)/,
  'GET download must claim a token before streaming file contents',
);
assert.match(
  downloadRoute,
  /if \(req\.method == crow::HTTPMethod::Delete\)[\s\S]*complete_download_token\(token\)/,
  'DELETE /api/file/download should mark one-shot token complete',
);
assert.match(
  downloadRoute,
  /set_static_file_info_unsafe\(/,
  'streaming download should use static file serving for exports',
);

const exportRouteStart = controlServer.indexOf('CROW_ROUTE(app, "/api/project/export")');
const exportRouteEnd = controlServer.indexOf('CROW_ROUTE(app, "/api/file/download")', exportRouteStart);
const exportRoute = controlServer.slice(exportRouteStart, exportRouteEnd);
assert.match(
  exportRoute,
  /out = tmp \/ \(download_token \+ "\.dwcuepack"\);/,
  'temporary canonical archive output must be token-named instead of projectName-derived',
);
assert.match(
  exportRoute,
  /const std::string default_name = safe_download_filename\(\s*j.value\("projectName"/,
  'projectName must only drive the user-facing default filename, not filesystem paths',
);
assert.match(
  controlServer,
  /static std::string safe_download_filename[\s\S]*security::canonical_archive_download_filename\(name\)/,
  'archive download names must use the canonical security helper',
);
assert.match(
  controlSecurity,
  /sanitize_upload_filename[\s\S]*while \(cut > 0[\s\S]*0xc0u[\s\S]*base.resize[\s\S]*name = std::move\(base\) \+ extension[\s\S]*canonical_archive_download_filename[\s\S]*stem \+ "\.dwcuepack", "project\.dwcuepack"/,
  'suggested canonical archive filenames must retain the .dwcuepack suffix without splitting valid UTF-8',
);
assert.match(
  exportRoute,
  /staged_out[\s\S]*project_archive::export_project\(\s*src, active_project, staged_out, out\)[\s\S]*replace_file_atomically\(\s*staged_out, out/,
  'exports must stage completely before atomically replacing the destination',
);

const importRouteStart = controlServer.indexOf('CROW_ROUTE(app, "/api/project/import")');
const importRouteEnd = controlServer.indexOf('CROW_ROUTE(app, "/api/mixers")', importRouteStart);
const importRoute = controlServer.slice(importRouteStart, importRouteEnd);
assert.match(
  importRoute,
  /trusted_archive_filename =\s*[\s\S]*sanitize_upload_filename\([\s\S]*filename_it->second[\s\S]*is_native_archive\(trusted_archive_filename\)[\s\S]*archive_path = tmp \/ \(make_download_token\(\) \+ "\.part"\);/,
  'multipart imports must validate the trusted source filename classification before random-token .part staging',
);
assert.match(
  controlServer,
  /const fs::path dest = unused_media_path\(media, safe_name\);/m,
  'uploaded media imports should route through collision-avoiding naming',
);
assert.match(
  controlServer,
  /dest = unused_media_path\(media, src\.filename\(\)\);/m,
  'media copy imports should avoid overwriting existing files',
);
assert.match(
  controlServer,
  /impl_->waveform_stop = true;[\s\S]*impl_->waveform_q.clear\(\);/m,
  'server stop must clear queued waveform work before worker shutdown',
);
assert.match(
  importRoute,
  /std::lock_guard import_lock\{g_media_import_mutex\};[\s\S]*project_archive::import_project\(/,
  'archive imports must share the media snapshot lock with exports',
);
assert.match(
  projectArchive,
  /ImportResult import_project[\s\S]*extract_zip_to\(archive_path, staging\)/,
  'locked archive imports must extract only through the validated staging implementation',
);

// The pidfile should be written atomically before any start delay so a crash
// restart can reattach to the fresh process instead of relaunching itself.
const pidPublishStart = mainCpp.indexOf('if (!opts.pidfile.empty()) {');
const pidPublishReplace = mainCpp.indexOf(
  'replace_file_atomically(temporary, pidfile_path, replace_ec)',
  pidPublishStart,
);
const startDelay = mainCpp.indexOf('if (opts.start_delay_ms > 0)');
assert.ok(
  pidPublishStart >= 0 &&
  pidPublishReplace > pidPublishStart &&
  startDelay > pidPublishReplace,
  'pidfile identity must be atomically written before crash-restart delay',
);
const serverStart = mainCpp.indexOf('if (!server->start())');
const canonicalPidPublish = mainCpp.indexOf('write_pidfile();', serverStart);
assert.ok(
  serverStart >= 0 && canonicalPidPublish > serverStart,
  'the bound server must republish its pidfile as the canonical generation',
);
const bannerStart = mainCpp.indexOf('void print_banner(');
const bannerEnd = mainCpp.indexOf('struct CliOptions', bannerStart);
assert.doesNotMatch(
  mainCpp.slice(bannerStart, bannerEnd),
  /disable_crash_restart/,
  'normal startup must leave crash restart enabled',
);
assert.match(
  mainCpp.slice(mainCpp.indexOf('while (should_keep_running())')),
  /disable_crash_restart\(\);[\s\S]*Shutdown signal received/,
  'intentional shutdown must disable crash restart before teardown',
);

const electron = read('client/electron/main.js');
const audioImportModal = read('client/app/components/AudioImportModal.vue');
const aboutContent = read('client/app/components/AboutContent.vue');
const cspHashStart = electron.indexOf('function cspHashesForInlineScripts');
const cspHashEnd = electron.indexOf(
  '\n}\n\nfunction configureSessionSecurity', cspHashStart) + 2;
const cspHashesForInlineScripts = Function(
  'crypto',
  `return (${electron.slice(cspHashStart, cspHashEnd)})`,
)(crypto);
assert.deepEqual(
  cspHashesForInlineScripts(
    '<script>window.test=1</script><script src="app.js"></script><script></script>'),
  ["'sha256-IjvDqPrZ3P5+z347XtESKmYstci13dwYLZbxMZvN2+8='"],
  'production CSP must hash inline boot scripts without allowing arbitrary inline code',
);
assert.match(
  electron,
  /inlineScriptHashes = cspHashesForInlineScripts\(rendererHtml\)\.join\(' '\)[\s\S]*script-src 'self' file: \$\{inlineScriptHashes\}/,
  'packaged renderer CSP must include hashes from its exact generated HTML',
);
assert.match(
  audioImportModal,
  /\.modal\s*\{[\s\S]{0,140}max-height:\s*calc\(100vh - 32px\);[\s\S]{0,60}overflow-y:\s*auto;/,
  'the standalone audio import header and close control must remain reachable',
);
assert.match(
  audioImportModal,
  /v-if="singleFile">\s*<ServerFilePickerModal docked[\s\S]*?@pick="onServerPick\(\[\$event\]\)"[\s\S]*?<template v-else-if="server\.isLocalServer && hasElectron">/,
  'single-file import must browse in the dock instead of opening the native chooser',
);
assert.match(
  audioImportModal,
  /selectedOfTotal[\s\S]*uploadedSizes[\s\S]*class="import-plan"[\s\S]*mediaDestination[\s\S]*importSettings/,
  'local imports must show their destination, processing, selection count, and uploaded file sizes',
);
assert.match(
  waveformTrimmer,
  /class="volume-slider-vertical"[\s\S]*class="waveform-scrollbar"[\s\S]*class="scroll-slider"[\s\S]*@input="handleScrollInput"[\s\S]*class="zoom-control"[\s\S]*class="zoom-slider"[\s\S]*const handleScrollInput[\s\S]*scrollPosition\.value = Math\.max/,
  'Properties must pair its wired view-position control with the zoom controls at the bottom of the waveform',
);
assert.match(
  waveformTrimmer,
  /:style="\{ '--volume-handle-color': trackColor \}"[\s\S]*\.volume-slider-vertical::-webkit-slider-thumb\s*\{[\s\S]{0,260}var\(--volume-handle-color,[\s\S]*\.zoom-slider,[\s\S]*\.scroll-slider\s*\{[\s\S]{0,320}var\(--color-accent\)[\s\S]*\.scroll-slider:disabled/,
  'Properties controls must use the cue colour on the fader accent and retain the cue-position control disabled state',
);
assert.match(
  liveplayClient,
  /uploadFile[\s\S]*file\.slice\(offset, offset \+ length\)/,
  'remote audio uploads must send bounded file-backed slices',
);
assert.match(
  liveplayClient,
  /importProjectArchiveFromClientPath[\s\S]*getBinaryFileInfo[\s\S]*readBinaryFileChunk/,
  'remote project imports must read local archives in bounded chunks',
);
assert.match(
  liveplayClient,
  /if \(osPath && isLocalServer\.value\)/,
  'remote drops must never ask the server to copy a client-only OS path',
);
assert.match(
  audioImportModal,
  /class="upload-drop"[^>]*@drop\.stop\.prevent="selectForUpload\(\$event\.dataTransfer\)"[\s\S]*webkitGetAsEntry[\s\S]*server\.uploadFile\(file, file\.name, session\)/,
  'remote audio import must accept file-backed files and folders in the dock',
);
assert.doesNotMatch(
  audioImportModal,
  /type="file"|show(OpenFile|Directory)Picker/,
  'remote audio import must keep selection inside the dock',
);
assert.match(
  electron,
  /async function terminateLiveplayPid\(pid, port, instanceToken,\s*legacy = false\)[\s\S]*const identityMatches = async \(\) =>/,
  'the shared termination path must verify the live server identity before signalling',
);
assert.ok(
  electron.indexOf('if (!(await identityMatches())) return false;') > electron.indexOf('if (process.platform === \'win32\')'),
  'forced termination must re-check identity after the graceful-shutdown wait',
);
assert.match(electron, /healthMatchesIdentity\(health, lock\)/,
  'reattachment must verify the health endpoint process identity');
assert.doesNotMatch(
  electron.slice(
    electron.indexOf('async function tryReattachLiveplayServer'),
    electron.indexOf('async function startLiveplayServer()'),
  ),
  /terminateLiveplayPid/,
  'an unhealthy or stale lock PID must never be signalled',
);
assert.match(electron, /let liveplayServerStartPromise = null/, 'concurrent start requests must share one launch');
assert.match(electron, /if \(liveplayServerStartPromise\) return liveplayServerStartPromise/, 'concurrent start requests must not spawn twice');
assert.match(
  electron,
  /await pollPidfileForServerPid\(\s*lockPath, instanceToken, accessToken, port, launchState/,
  'a launch must adopt its PID before it is considered complete',
);
assert.match(
  electron,
  /async function pollPidfileForServerPid[\s\S]*healthMatchesIdentity\(health, lock\)/,
  'fresh launches must verify the pidfile against the health endpoint',
);
assert.match(
  electron,
  /async function reconcileLiveplayServerIdentity[\s\S]*adoptLiveplayIdentity\(verifiedLock\)/,
  'lifecycle operations must reconcile crash-restarted server identities',
);
assert.match(electron, /async function stopLiveplayServer\(\)[\s\S]*runLiveplayServerOperation\(stopLiveplayServerOnce\)/, 'shutdown must run after earlier lifecycle actions');
assert.match(electron, /const pending = liveplayServerLifecyclePromise\.then\(operation\)/, 'server lifecycle actions share one ordered chain');
assert.match(electron, /async function stopVerifiedLiveplayServer\([\s\S]*await terminateLiveplayPid\(/, 'normal shutdown must wait for verified termination');
assert.match(electron, /ipcMain\.handle\('app:confirm-quit', async[\s\S]*await stopLiveplayServer\(\)/, 'confirmed shutdown must finish before Electron exits');
assert.match(electron, /ipcMain\.handle\('liveplay-server:restart', async[\s\S]*runLiveplayServerOperation\(async[\s\S]*await stopLiveplayServerOnce\(\)[\s\S]*await startLiveplayServerOnce\(\)/, 'restart must not overlap two servers');
assert.match(
  electron,
  /ipcMain\.handle\('install-update', async \(event\) =>[\s\S]*requireTrustedIpc\(event\);[\s\S]*return installDownloadedUpdate\(\);/,
  'installing an update must use the guarded install helper',
);
const electronSourceFile = ts.createSourceFile(
  'electron-main.js', electron, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS,
);
const electronFunctionSource = (name) => {
  const declaration = electronSourceFile.statements.find(
    statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  assert.ok(declaration, `Electron main must define ${name}`);
  return electron.slice(declaration.getStart(electronSourceFile), declaration.end);
};
const updateInstallation = electronFunctionSource('installDownloadedUpdate');
const terminalPreparation = electronFunctionSource('prepareForTerminalAction');
assert.match(
  updateInstallation,
  /await prepareForTerminalAction\(\)[\s\S]*autoUpdater\.quitAndInstall/,
  'installing an update must run shared terminal preparation before relaunch',
);
assert.match(
  terminalPreparation,
  /await cancelAllSpotifyDownloads\(true\);[\s\S]*await cancelAllYouTubeDownloads\(\);/,
  'terminal preparation must await active media import cleanup',
);
assert.match(
  electron,
  /app\.setPath\('userData', [\s\S]{0,80}path\.join\(app\.getPath\('appData'\), 'LivePlay'\)\)/,
  'the rebrand must preserve the installed LivePlay profile and detached-server lock',
);
assert.doesNotMatch(electron, /function deleteLiveplayLock/,
  'Electron must not unlink a pidfile that a crash replacement can update concurrently');
assert.match(
  electron,
  /processRunsLegacyServer[\s\S]*server-bin[\s\S]*--pidfile[\s\S]*liveplayLockPath/,
  'a tokenless legacy server must be identified by its packaged executable and exact pidfile arguments',
);
assert.match(
  electron,
  /processInfoHasArgPair\(info, '--instance-token', instanceToken\)/,
  'Windows crash-restart identity checks must accept quoted argv pairs',
);
const commandPairSource = electron.slice(
  electron.indexOf('function commandLineHasArgPair'),
  electron.indexOf('function sameExecutablePath'),
).trim();
const commandLineHasArgPair = Function(`return (${commandPairSource})`)();
assert.equal(commandLineHasArgPair(
  '"dwcue-server.exe" "--instance-token" "0123456789abcdef0123456789abcdef"',
  '--instance-token',
  '0123456789abcdef0123456789abcdef',
), true, 'quoted Windows crash-restart argv must match');
assert.equal(commandLineHasArgPair(
  'dwcue-server --pidfile /Users/Test User/LivePlay/liveplay-server.lock --port 4480',
  '--pidfile',
  '/Users/Test User/LivePlay/liveplay-server.lock',
), true, 'pidfile argv with spaces must match');
assert.equal(commandLineHasArgPair(
  'dwcue-server --instance-token ffffffffffffffffffffffffffffffff',
  '--instance-token',
  '0123456789abcdef0123456789abcdef',
), false, 'a different generation token must not match');
assert.match(electron, /launcher\.once\('error'/,
  'detached launcher failures must have an error listener');
assert.doesNotMatch(
  electron,
  /tell application "Terminal"|spawn\(\s*'osascript'/,
  'macOS local-server startup must remain headless',
);
assert.match(
  electron,
  /spawn the server directly and headless[\s\S]*spawn\(exePath, serverArgs,[\s\S]*stdio: 'ignore',[\s\S]*detached: true/,
  'macOS must launch the detached server directly with no terminal',
);
assert.equal(
  pkg.build.mac.extendInfo?.NSAppleEventsUsageDescription,
  undefined,
  'headless macOS startup must not request Terminal automation permission',
);
assert.doesNotMatch(
  read('client/build/entitlements.mac.plist'),
  /automation\.apple-events/,
  'headless macOS startup must not retain the Apple Events entitlement',
);
assert.match(
  electron,
  // The readiness wait moved into its own function so it can run again after
  // an unresponsive server is restarted; ensure-running must still go through it.
  /async function awaitLiveplayServerHealthy[\s\S]*healthMatchesIdentity\(health, lock\)[\s\S]*async function ensureLiveplayServerRunning[\s\S]*awaitLiveplayServerHealthy\(cfg, 10000\)[\s\S]*'liveplay-server:ensure-running'[\s\S]*ensureLiveplayServerRunning\(\)/,
  'ensure-running must match the configured port health to the managed pidfile generation',
);
assert.match(
  electron,
  /read-binary-file-chunk[\s\S]*length > MAX_BINARY_CHUNK_BYTES[\s\S]*handle\.read/,
  'local archive IPC reads must enforce the server-sized chunk ceiling',
);
assert.match(
  electron,
  /download-archive-to-file[\s\S]*pipeline\([\s\S]*Readable\.fromWeb[\s\S]*fs\.promises\.link/,
  'archive downloads must stream to a temp file before publishing without replacing an existing file',
);
assert.doesNotMatch(
  electron,
  /path\.basename\(destination\)[^\n]*dwcue-download/,
  'archive staging names must not inherit destination basename length',
);
assert.doesNotMatch(
  electron,
  /read-audio-file|write-binary-file/,
  'whole-file binary IPC paths must not return',
);
assert.doesNotMatch(
  electron,
  /checkForManualUpdate|manual-update-available|github\.io\/liveplay\/package\.json/,
  'DonWells Cue must never install or advertise upstream LivePlay updates',
);
assert.doesNotMatch(
  aboutContent,
  /isManualUpdate|downloadUrl|github\.io\/liveplay/,
  'the update UI must not fall back to upstream LivePlay downloads',
);
// The branded release feed now exists: updates are ON, pinned to this
// repository's GitHub Releases. The gate asserts the pin so the updater can
// never silently retarget at some other repo's binaries, and the update
// handlers still fail closed if the switch is ever turned off.
assert.match(
  electron,
  /autoUpdater\.setFeedURL\(\{\s*provider: 'github',\s*owner: 'donwellsav',\s*repo: 'dwcue',\s*\}\)/,
  'the update feed must be pinned to donwellsav/dwcue',
);
assert.match(
  electron,
  /const DWCUE_UPDATES_CONFIGURED = true/,
  'updates must be enabled for the branded release feed',
);
assert.match(
  electron,
  /ipcMain.handle\('check-for-updates'[\s\S]{0,400}if \(!DWCUE_UPDATES_CONFIGURED/,
  'the manual update check must fail closed when updates are disabled',
);
assert.match(
  electron,
  /const isLinuxAppImage =[\s\S]{0,300}const updatesInstallSupported =[\s\S]{0,300}if \(process\.platform === 'linux' && app\.isPackaged && !isLinuxAppImage\) \{[\s\S]{0,120}autoUpdater\.forceDevUpdateConfig = true;/,
  'packaged non-AppImage Linux installs must keep update discovery active',
);
assert.match(
  electron,
  /download-update[\s\S]{0,500}if \(!updatesInstallSupported\)[\s\S]{0,120}updates-unsupported-package/,
  'non-AppImage Linux installs must not self-install downloaded updates',
);
assert.match(
  electron,
  /autoUpdater\.autoDownload = false/,
  'updates must wait for explicit download consent',
);
assert.match(
  electron,
  /autoUpdater\.autoInstallOnAppQuit = false/,
  'updates must wait for an explicit install-on-now or install-on-exit choice',
);
assert.match(updateInstallation, /if \([^\n]*!downloadedUpdateVersion\) return false;/,
  'install requests without a staged update must leave the engine running');
assert.match(appVue, /showHeaderWarning\(message, 'advisory', 5\)/,
  'startup update notices belong in the header for five seconds');
assert.match(
  electron,
  /async function installDownloadedUpdate\([\s\S]{0,900}const shouldRunAfterInstall = runAfterInstall !== false[\s\S]{0,500}autoUpdater\.autoRunAppAfterInstall = shouldRunAfterInstall[\s\S]{0,180}autoUpdater\.quitAndInstall\(!shouldRunAfterInstall, shouldRunAfterInstall\)/,
  'Install Now and Install on Exit must preserve the requested post-install relaunch mode',
);
assert.match(
  electron,
  /autoUpdater\.on\('error', \(err\) => \{[\s\S]{0,400}if \(updateInstallAttemptActive\) \{[\s\S]{0,200}updateInstallAttemptActive = false;[\s\S]{0,200}quitConfirmed = false;[\s\S]{0,200}autoUpdater\.autoRunAppAfterInstall = true;/,
  'failed installer launches must release the close veto and restore normal relaunch behavior',
);
assert.match(
  electron,
  /updateInstallAttemptActive = true;[\s\S]{0,120}quitConfirmed = true;[\s\S]{0,120}autoUpdater\.quitAndInstall/,
  'update installs must track the active attempt before lifting the close veto',
);
const readyStart = electron.indexOf('app.whenReady().then');
const readyEnd = electron.indexOf('\\n  });', readyStart);
const readyPath = electron.slice(readyStart, readyEnd);
assert.ok(
  readyPath.indexOf('createWindow();') >= 0 && !readyPath.includes('setupFfmpeg'),
  'startup must not probe or download FFmpeg; the importers fetch it on demand',
);
assert.match(
  electron,
  /execFilePromise\(toolPath, \['-version'\], \{ timeout, windowsHide: true \}\)/,
  'FFmpeg probes must have a hard timeout',
);
// The audio engine carries its own FFmpeg. A second copy for the importers
// must not return to the installer: it is downloaded, pinned, on first import.
for (const name of ['@ffmpeg-installer/ffmpeg', '@ffprobe-installer/ffprobe', 'fluent-ffmpeg']) {
  assert.ok(!(name in pkg.dependencies), `${name} must not be packaged with the app`);
}
assert.ok(
  !pkg.build.asarUnpack.some(pattern => /ffmpeg|ffprobe/.test(pattern)),
  'no FFmpeg program is unpacked into the installed app',
);
assert.doesNotMatch(electron, /require\(['"]@ff(mpeg|probe)-installer/,
  'the app must not load a bundled FFmpeg');
assert.match(
  electron,
  /await downloadToFile\(net\.fetch, pinned\.url, archivePath\);\s+if \(!await fileMatchesIntegrity\(archivePath, pinned\.integrity\)\) \{\s+throw/,
  'a downloaded FFmpeg archive must pass its pinned integrity check before it is unpacked',
);
assert.match(
  electron,
  /ffmpegSetupPromise = initializeFfmpeg\(\)\.then\(\(ready\) => \{\s+if \(!ready\) ffmpegSetupPromise = null;/,
  'a failed FFmpeg setup must be retried by the next import, not kept until restart',
);
assert.doesNotMatch(electron, /Please restart the application/,
  'import failures must not tell the operator to restart the app');
const { validatedSpotifyUrl } = require('../client/electron/spotify-import-reliability');
assert.match(
  validatedSpotifyUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=test'),
  /^https:\/\/open\.spotify\.com\/playlist\//,
  'Spotify playlist URLs must be accepted',
);
assert.match(
  validatedSpotifyUrl('https://spotify.link/AbCd1234'),
  /^https:\/\/spotify\.link\//,
  'Spotify share links must be accepted',
);
assert.throws(
  () => validatedSpotifyUrl(
    'https://open.spotify.com.evil.example/playlist/37i9dQZF1DXcBWIGoYBM5M'),
  /Spotify/,
  'lookalike Spotify hosts must be rejected',
);
const spotifyModal = read('client/app/components/SpotifyImportModal.vue');
const normalizeSpotifyUrlStart = spotifyModal.indexOf('function normalizeSpotifyUrl');
const normalizeSpotifyUrlEnd = spotifyModal.indexOf(
  '\n}\n\nasync function startDownload', normalizeSpotifyUrlStart) + 2;
const normalizeSpotifyUrl = Function(
  `return (${spotifyModal
    .slice(normalizeSpotifyUrlStart, normalizeSpotifyUrlEnd)
    .replace('function normalizeSpotifyUrl(raw: string): string',
      'function normalizeSpotifyUrl(raw)')})`,
)();
assert.equal(
  normalizeSpotifyUrl('https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF?si=test'),
  'https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF',
  'the Spotify modal must accept artist links',
);
assert.match(
  normalizeSpotifyUrl('https://spotify.link/AbCd1234'),
  /^https:\/\/spotify\.link\//,
  'the Spotify modal must accept share links',
);
assert.match(
  electron,
  /SPOTDL_RELEASE[\s\S]*spotdl-4\.5\.2-darwin[\s\S]*0e6a1b704253eda7dda7e85e2a8137b024fdd09cf94e9ab6286350dee95fcabc/,
  'Spotify import must install a pinned, checksum-verified helper',
);
assert.match(
  electron,
  /download-spotify-audio[\s\S]*requireTrustedIpc\(event\)[\s\S]*requireAuthorizedIpcPath\([\s\S]*destinationParentPath/,
  'Spotify downloads must require trusted IPC and an authorized destination',
);
// Literal argv, spawn failures and deadline cancellation are exercised by
// spotify-import-reliability.test.js against the production runTracked body.
assert.match(
  electron,
  /runTracked\(spotDlPath, \[[\s\S]{0,180}'url',[\s\S]{0,180}'--audio', \.\.\.SPOTIFY_AUDIO_PROVIDERS/,
  'Spotify metadata matching must retain its guarded provider fallback chain',
);
assert.match(
  electron,
  /createSpotifyProjectFolder\([\s\S]*playlistName[\s\S]*normalizeSpotifyRecovery\([\s\S]*pendingFiles: files[\s\S]*spotifyRecovery: recovery/,
  'Spotify imports must persist recoverable file identities and their named collection folder',
);
assert.doesNotMatch(
  electron,
  /completedTitles\s*=\s*new Set/,
  'Spotify progress must not collapse duplicate track titles',
);
assert.match(
  electron,
  /async function copySpotifyOutputsToMedia[\s\S]*createWriteStream\(destination, \{ flags: 'wx' \}\)[\s\S]*job\.abortController\.signal/,
  'Spotify downloads must use cancellable, collision-safe media copies',
);
assert.match(
  electron,
  /ipcMain\.handle\('write-file'[\s\S]*\.dwcue-write-[\s\S]*flag: 'wx'[\s\S]*fs\.promises\.rename\(tempPath, checkedPath\)[\s\S]*finally[\s\S]*unlink\(tempPath\)/,
  'project documents must be staged to a sibling file before atomic replacement',
);
assert.match(
  electron,
  /cancel-spotify-download[\s\S]*cancelSpotifyDownload\(jobId, event\.sender\.id\)/,
  'playlist downloads must expose renderer-scoped cancellation IPC',
);
assert.match(
  electron,
  /function cancelSpotifyDownload[\s\S]*job\.children[\s\S]*terminateSpotifyChild\(tracked\)/,
  'playlist cancellation must terminate every tracked matching and download process',
);
assert.match(
  electron,
  /async function cancelAllSpotifyDownloads[\s\S]*await cancelSpotifyDownload[\s\S]*await job\.done[\s\S]*job\.stagingCleaned = true[\s\S]*job\.resolveDone/,
  'app shutdown must wait for each Spotify transaction and staging cleanup',
);
assert.match(
  electron,
  /\['destroyed', 'render-process-gone', 'did-start-navigation'\][\s\S]*cancelSpotifyDownload\(jobId, null, true\)/,
  'renderer reloads and crashes must release Spotify jobs without risking saved media',
);
assert.match(
  electron,
  /failed to remove staging directory/,
  'staging cleanup must not override a completed Spotify IPC transaction',
);
assert.match(
  electron,
  /finalize-spotify-import[\s\S]*job\.senderId !== event\.sender\.id[\s\S]*!job\.awaitingImport[\s\S]*job\.awaitingImport = false/,
  'only the originating renderer may finalize an awaiting Spotify import once',
);
assert.match(
  spotifyModal,
  /await props\.importFiles\(downloadResult\.files, importController\.signal, \{[\s\S]*groupName: downloadResult\.playlistName[\s\S]*templateFolderPath: downloadResult\.projectFolderPath[\s\S]*await api\.finalizeSpotifyImport\(jobId, keepFiles\)[\s\S]*resultState\.value = downloadResult/,
  'Spotify completion must wait for cue persistence and media commit',
);
assert.match(
  spotifyModal,
  /<ServerFilePickerModal[^>]*\bdocked\b[^>]*mode="directory"[^>]*@pick="saveDestination"[\s\S]*api\.setSpotifyImportDestination\(selected\)[\s\S]*api\.downloadSpotifyAudio\([\s\S]*destinationParentPath/,
  'Spotify imports must use the docked browser and keep the authorized destination in the job',
);
assert.match(
  spotifyModal,
  /sourceTypeText[\s\S]*:value="audioBitrate"[\s\S]*destinationParentPath[\s\S]*cueProcessingSettings/,
  'Spotify imports must disclose their source and let operators edit bitrate, destination, and cue processing',
);
assert.match(
  spotifyModal,
  /v-if="!reviewState && progressState\?\.playlistName"[\s\S]{0,180}v-if="progressState\?\.message && isActive"[\s\S]*resultState\?\.projectFolderPath[\s\S]*openResultFolder/,
  'Spotify progress must keep the collection, current operation, result path, and reveal action visible',
);
assert.match(
  spotifyModal,
  /finalizeKeepFiles = keepFiles[\s\S]*if \(needsFinalize\)[\s\S]*finalizeSpotifyImport\(jobId, finalizeKeepFiles\)/,
  'a retry after ambiguous finalization must preserve the chosen media-retention policy',
);
assert.match(
  spotifyModal,
  /const projectFolderPath = props\.projectFolderPath[\s\S]*const projectEpoch = props\.projectEpoch[\s\S]*props\.projectFolderPath !== projectFolderPath[\s\S]*currentEpoch\.value !== projectEpoch/,
  'a Spotify job must stay bound to the project generation that started it',
);
const oneShotPanel = read('client/app/components/OneShotPanel.vue');
const oneShotTile = read('client/app/components/OneShotTile.vue');
const youtubeImport = read('client/app/components/YouTubeImportModal.vue');
const controlConfig = read('client/app/components/ControlConfigModal.vue');
const midiController = read('client/app/composables/useMidiController.ts');
const button = read('client/app/components/Btn.vue');
const actionButton = read('client/app/components/ActionButton.vue');
const globalStyles = read('client/assets/styles/main.scss');
assert.match(
  globalStyles,
  /--workspace-gutter:\s*var\(--spacing-sm\);[\s\S]*--app-header-height:\s*52px;[\s\S]*--playback-controls-height:\s*104px;[\s\S]*--panel-header-height:\s*44px;[\s\S]*--panel-control-height:\s*34px;[\s\S]*--output-strip-width:\s*192px;[\s\S]*--output-console-width:\s*calc\(/,
  'workspace bands must include their one-pixel border without squeezing their controls',
);
assert.match(
  globalStyles,
  /--resize-handle-width:\s*1px;[\s\S]{0,240}--playlist-split-min-width:\s*577px;/,
  'the splitter must use a one-pixel structural seam and reserve the regular row grid plus its gutters',
);
assert.match(
  projectHeader,
  /min-height:\s*var\(--app-header-height\);[\s\S]*\.header-right\s*\{[^}]*gap:\s*6px;[\s\S]*\.autosave-toggle\s*\{[\s\S]{0,260}min-height:\s*32px;[\s\S]{0,180}padding:\s*4px var\(--spacing-sm\);/,
  'header controls must use a compact aligned rhythm inside a band tall enough for the clocks',
);
assert.match(
  projectHeader,
  /\.digital-clock\.clock--large\s*\{[\s\S]{0,120}width:\s*clamp\(148px, 13vw, var\(--output-strip-width\)\);[\s\S]{0,120}min-width:\s*clamp\(148px, 13vw, var\(--output-strip-width\)\);/,
  'the clocks must stay responsive while remaining aligned to the console rail scale',
);
assert.match(
  mainWorkspace,
  /\.output-console__strips\s*\{[\s\S]{0,220}gap:\s*var\(--spacing-sm\);[\s\S]{0,160}padding:\s*var\(--spacing-sm\);[\s\S]*&\.collapsed-left\s*\{[\s\S]{0,180}top:\s*var\(--panel-header-height\);/,
  'workspace panel gutters, dividers, and the cart toggle must land on shared header edges',
);
assert.match(
  mainWorkspace,
  /class="playlist-section">[\s\S]*\.playlist-section\s*\{[\s\S]{0,100}flex:\s*1 1 0;[\s\S]{0,80}width:\s*auto;[\s\S]*\.output-console\s*\{[\s\S]{0,180}flex:\s*0 0 var\(--output-console-width\);[\s\S]{0,80}width:\s*var\(--output-console-width\);/,
  'the cart splitter, playlist, and output rail must share one deterministic width equation',
);
assert.match(
  mainWorkspace,
  /\.cart-section\s*\{[^}]*flex:\s*0 0 auto;[^}]*max-width:\s*var\(--cart-max-width\);/,
  'the splitter width must respect the workspace bound',
);
assert.match(
  mainWorkspace,
  /const zoom = rect\.width \/ container\.offsetWidth \|\| 1;[\s\S]{0,260}const newWidth = fromStart \/ zoom;[\s\S]*cartWidth\.value = Math\.round\(newWidth\);/,
  'the splitter must track the pointer at the current interface scale',
);
assert.match(
  mainWorkspace,
  /\.main-workspace\.show-mode\s*\{[\s\S]{0,240}--playlist-split-min-width:\s*637px;[\s\S]*\.playlist-section\s*\{[\s\S]{0,140}min-width:\s*var\(--playlist-split-min-width\);[\s\S]*\.cart-section\s*\{[^}]*--cart-max-width:\s*calc\(100% - var\(--playlist-split-min-width\) - var\(--resize-handle-width\)\);[^}]*&\.cart-section--fullscreen\s*\{[^}]*max-width:\s*none;/,
  'the split view must stay usable while fullscreen cart remains unconstrained',
);
assert.match(
  mainWorkspace,
  /@container \(max-width: 940px\)\s*\{\s*\.playlist-section\s*\{\s*min-width:\s*0;\s*\}\s*\.cart-section:not\(\.cart-section--fullscreen\)\s*\{\s*--cart-max-width:\s*min\(32%, 280px\);/,
  'the narrow QuickPlays bank must share workspace width with the playlist',
);
assert.match(
  mainWorkspace,
  /&\.collapsed-left\s*\{[\s\S]{0,180}top:\s*var\(--panel-header-height\);[\s\S]*&\.collapsed-right\s*\{[\s\S]{0,180}top:\s*var\(--panel-header-height\);/,
  'collapsed cart dividers must begin below the shared panel header',
);
assert.match(
  mainWorkspace,
  /\.output-console__header\s*\{[\s\S]{0,100}padding-block:\s*2px;[\s\S]*\.limiter-ceiling-control\s*\{[\s\S]{0,180}height:\s*calc\(var\(--panel-control-height\) \+ 6px\);[\s\S]*\.limiter-toggle\s*\{[\s\S]{0,220}height:\s*calc\(var\(--panel-control-height\) \+ 6px\);[\s\S]*\.output-pair\s*\{[\s\S]{0,120}flex:\s*0 0 var\(--output-strip-width\);/,
  'the limiter header and meter body must use the same output-rail geometry',
);
assert.match(
  mainWorkspace,
  /\.output-console__header-controls\s*\{[\s\S]*gap:\s*var\(--spacing-sm\);[\s\S]*\.limiter-ceiling-control\s*\{[\s\S]*flex:\s*1 1 0;[\s\S]*\.limiter-ceiling-value\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) 20px;[\s\S]*width:\s*100%;[\s\S]*\.limiter-ceiling-input\s*\{[\s\S]*width:\s*100%;[\s\S]*font-size:\s*14px;[\s\S]*\.limiter-toggle\s*\{[\s\S]*flex-direction:\s*column;[\s\S]*min-width:\s*92px;[\s\S]*\.limiter-toggle__label\s*\{[\s\S]*font-size:\s*13\.5px;[\s\S]*\.limiter-toggle__gr\s*\{[\s\S]*font-size:\s*11px;/,
  'the output header controls must use readable, aligned live-operation spacing and type',
);
assert.match(
  playlistView,
  /\.playlist-content\s*\{[\s\S]*scrollbar-color:\s*var\(--color-border-strong\) transparent;[\s\S]*::-webkit-scrollbar\s*\{[\s\S]*width:\s*12px;[\s\S]*::-webkit-scrollbar-thumb\s*\{[\s\S]*min-height:\s*44px;/,
  'the playlist scrollbar must remain visible and grabbable in long show files',
);
assert.match(
  playbackControls,
  /\.panic-btn:disabled\s*\{[\s\S]{0,160}opacity:\s*1;[\s\S]{0,100}background-color:\s*var\(--color-control\);[\s\S]{0,120}color:\s*var\(--color-text-disabled\);/,
  'disabled Stop All must use a neutral surface instead of looking armed',
);
assert.match(
  mainWorkspace,
  /\.output-console__strips\s*\{[\s\S]{0,260}background:\s*var\(--color-background\);[\s\S]{0,60}box-shadow:\s*none;[\s\S]*\.limiter-ceiling-control\s*\{[\s\S]{0,420}background:\s*var\(--color-control\);[\s\S]*\.output-pair :deep\(\.stereo-meter--strip\)\s*\{[\s\S]{0,180}background:\s*var\(--color-surface\);[\s\S]{0,100}box-shadow:\s*none;/,
  'the output rail must reuse the app panel and control surfaces instead of separate rack chrome',
);
assert.match(
  stereoMeter,
  /&--strip\s*\{\s*width:\s*var\(--output-strip-width,\s*192px\);[\s\S]{0,120}padding:\s*6px 8px;[\s\S]{0,80}gap:\s*6px;[\s\S]*&--strip &__label\s*\{[\s\S]{0,240}font-size:\s*15px;[\s\S]{0,80}font-weight:\s*700;[\s\S]{0,120}min-height:\s*36px;[\s\S]{0,120}justify-content:\s*flex-start;[\s\S]{0,80}text-align:\s*left;/,
  'the stereo meter strip must inherit the shared output-rail width',
);
assert.doesNotMatch(
  stereoMeter,
  /stereo-meter__chan-labels/,
  'stereo meter channel labels must not consume footer space',
);
assert.match(
  stereoMeter,
  /&__peak-text\s*\{[\s\S]{0,100}grid-column:\s*1 \/ -1;[\s\S]{0,60}grid-row:\s*3;[\s\S]{0,140}padding-right:\s*64px;[\s\S]{0,180}font-size:\s*12px;[\s\S]{0,120}font-variant-numeric:\s*tabular-nums;/,
  'the live meter value must keep its row and reserve the aligned 64-pixel fader readout lane',
);
assert.match(
  stereoMeter,
  /&__gr-track\s*\{[\s\S]{0,140}border:\s*1px solid var\(--color-border\);[\s\S]{0,100}background:\s*var\(--color-control\);[\s\S]*&__track\s*\{[\s\S]{0,220}border:\s*1px solid var\(--color-border\);[\s\S]{0,100}background:\s*var\(--color-control\);/,
  'the shared output meter wells must use flat control surfaces while retaining live level data',
);
assert.doesNotMatch(
  stereoMeter,
  /&__(?:gr-track|track)\s*\{[^}]*box-shadow:/,
  'meter wells must not regain decorative rack shadows',
);
assert.match(
  oneShotPanel,
  /v-else-if="slotErrors\[index\]"[\s\S]{0,220}role="alert"[\s\S]{0,700}clearSlotError\(index\)/,
  'One Shot import warnings must stay visible until the operator explicitly clears them',
);
assert.match(
  oneShotTile,
  /v-if="!showMode"[\s\S]*class="one-shot-control one-shot-remove"[\s\S]*<Teleport defer :to="[^"]*#workspace-import-host[^"]*">[\s\S]*v-if="menuOpen"\s*class="quickplay-settings"[\s\S]*v-if="removeOpen"\s*class="quickplay-remove"[\s\S]*@click="confirmRemove"/,
  'QuickPlay settings and the edit-mode removal confirmation must share the nonmodal dock',
);
assert.match(
  oneShotPanel,
  /defer :to="isDetachedWindow \? '#detached-quickplay-dock' : '#workspace-import-host'"[\s\S]*?<AudioImportModal :key="importSlot" docked single-file/,
  'QuickPlay import must use the single-file dock in either window',
);
assert.match(
  propertiesPanel,
  /class="properties-header workspace-panel-header"[\s\S]{0,180}class="workspace-panel-header__title"[\s\S]*\.close-btn\s*\{[\s\S]{0,100}width:\s*var\(--panel-control-height\);[\s\S]{0,80}height:\s*var\(--panel-control-height\);/,
  'the properties panel must reuse the workspace header rail',
);
assert.match(
  propertiesPanel + waveformTrimmer,
  /class="tab-panel playback-panel"[\s\S]*id="properties-transport-host"[\s\S]{0,100}class="properties-playback-info"[\s\S]*<Teleport v-if="!multiSelect" defer to="#properties-transport-host">[\s\S]{0,160}class="audition-transport"[\s\S]*class="audition-time"/,
  'Properties transport and timecode must stay in the information rail below the waveform',
);
assert.match(
  propertiesPanel,
  /v-if="selectedItem\.type === 'audio'" class="properties-tabs"[\s\S]*<section v-if="activeTab === 'basic'" class="property-column cue-behaviors">[\s\S]*playback-behavior--ducking[\s\S]*playback-behavior--start[\s\S]*playback-behavior--end[\s\S]*newItem\.type === 'group'\) \{\s*activeTab\.value = 'basic'/,
  'group properties must show both behavior controls together even when switching from an audio tab',
);
assert.doesNotMatch(
  propertiesPanel,
  /\{ id: '(?:media|ducking)', label:/,
  'media and ducking must not return as separate audio-property tabs',
);
assert.match(
  playbackControls,
  /\.playback-controls\.show-mode :deep\(\.active-cue-item \.action-btn\)\s*\{[\s\S]{0,100}width:\s*32px;[\s\S]{0,80}height:\s*32px;/,
  'preview and active-cue actions must share one Show Mode control tier',
);
assert.match(
  globalStyles,
  /--modal-width:\s*560px;[\s\S]{0,80}--modal-max-height:\s*90vh;/,
  'settings dialogs must share one shell geometry',
);
assert.match(
  mainWorkspace,
  /<ShortcutsBar\b[^>]*>[\s\S]*<ProjectSettingsModal :open="showProjectSettings"[\s\S]*<PropertiesPanel v-if="showCueProperties"[\s\S]*id="workspace-import-host"[\s\S]*const showCueProperties = computed\(\(\) =>\s*!showProjectSettings\.value && !visibleImportPanel\.value/,
  'Settings, cue Properties, and imports must share the lower workspace without stacking',
);
assert.match(
  projectSettingsModal,
  /class="project-settings-panel"[\s\S]*class="workspace-panel-header settings-header"[\s\S]*<ControlConfigModal v-if="activeTab === 'shortcuts' \|\| activeTab === 'midi'"[\s\S]*?\/>[\s\S]*\.project-settings-panel\s*\{[^}]*flex:\s*1;/,
  'Settings must fit the resizable workspace panel and host the same shortcuts editor',
);
assert.doesNotMatch(
  projectSettingsModal + controlConfig,
  /(?:project-settings-backdrop|control-config-overlay)/,
  'Settings and Shortcuts must not use a full-window backdrop',
);
assert.match(
  controlConfig,
  /\.config-body\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);[\s\S]*\.action-label\s*\{\s*grid-column:\s*1;[\s\S]*\.action-binding\s*\{\s*grid-column:\s*2;[\s\S]*\.clear-key-btn\s*\{\s*grid-column:\s*3;/,
  'each shortcut must keep its label, binding and Clear action together',
);
assert.doesNotMatch(
  `${controlConfig}\n${projectSettingsModal}\n${propertiesPanel}`,
  /border-radius:\s*(?:3px|4px|5px)/,
  'rectangular settings, shortcut, and properties controls must share the control radius',
);
assert.match(
  projectSettingsModal,
  /\.settings-tabs\s*\{[^}]*grid-auto-columns:\s*minmax\(0, 1fr\);[^}]*align-self:\s*stretch;[^}]*min-width:\s*0;/,
  'settings tabs must share the available header width',
);
assert.match(
  projectSettingsModal,
  /\.settings-content\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);[\s\S]*\.settings-content--playback > \.settings-rows\s*\{[^}]*grid-template-rows:\s*subgrid;/,
  'settings columns must share a grid and Playback Behaviour must align its corresponding rows',
);
assert.match(
  playbackControls,
  /\.playback-controls\s*\{[\s\S]{0,420}display:\s*grid;[\s\S]{0,140}grid-template-columns:\s*var\(--transport-stop-width\) minmax\(0, 1fr\) var\(--transport-next-width\);[\s\S]{0,100}grid-template-areas:\s*'panic live next';[\s\S]{0,180}padding:\s*var\(--workspace-gutter\);/,
  'Stop All, active cues, and Play Next must stay aligned on one named three-column console grid',
);
assert.match(
  playlistView,
  /\.playlist-content\s*\{[\s\S]{0,100}padding:\s*0 var\(--workspace-gutter\) var\(--workspace-gutter\);[\s\S]*\.item-list\s*\{[\s\S]{0,140}padding-top:\s*var\(--workspace-gutter\);/,
  'sticky folder headers must land flush while initial playlist content keeps its gutter',
);
assert.match(
  playlistView,
  /\.playlist-actions\s*\{[^}]*flex:\s*1 1 auto;[^}]*overflow-x:\s*auto;[^}]*container:\s*playlist-actions \/ inline-size;[\s\S]*@container playlist-actions \(max-width: 500px\)/,
  'playlist actions must stay bounded by the shared header at every supported width',
);
assert.match(
  projectHeader,
  /class="header-name-line">\s*<h2\s+v-if="silenceSeconds === null && !warning"\s+class="project-name"[\s\S]*?<\/h2>\s*<div class="header-warning-line">[\s\S]*?class="silence-warning"[\s\S]*?id="project-header-warnings"/,
  'the title slot must yield to the steady countdown and transient notices',
);
assert.match(
  playlistView,
  /\.item-list\s*\{\s*container-type:\s*inline-size;/,
  'playlist rows must share one responsive grid instead of switching layouts at each nesting depth',
);
assert.doesNotMatch(
  playlistItem,
  /\.playlist-item\s*\{[\s\S]{0,400}container-type:/,
  'nested playlist rows must not create independent query widths',
);
assert.match(
  playlistItem,
  /\.playlist-item\.is-group > \.item-content \.item-identity\s*\{\s*grid-template-columns:\s*var\(--cue-number-width, 36px\) max-content minmax\(0, 1fr\);[\s\S]*\.item-index\s*\{\s*grid-column:\s*1;[\s\S]*\.item-icon\s*\{\s*grid-column:\s*2;[\s\S]*\.playlist-item\.is-group \.item-name\s*\{\s*grid-column:\s*3;/,
  'a folder number, icon and title must have separate columns in the same row',
);
assert.match(
  playlistItem,
  /\.group-children\s*\{[\s\S]{0,180}gap:\s*2px;[\s\S]{0,100}padding-top:\s*2px;/,
  'folder children must keep the same row rhythm and only wrap when the wide grid no longer fits',
);
assert.match(
  playlistItem,
  /\.playlist-item\.is-playing > \.item-content \.item-name\s*\{[\s\S]{0,100}justify-self:\s*start;[\s\S]{0,100}max-width:\s*100%;[\s\S]{0,100}box-sizing:\s*border-box;[\s\S]{0,100}color:\s*var\(--color-text-primary\);\s*\}/,
  'the playing title must retain the shared identity axis and stay white for reading',
);
assert.doesNotMatch(
  playlistItem,
  /\.playlist-item\.is-playing > \.item-content \.item-name\s*\{[^}]*(?:padding|margin-left|background|color:\s*var\(--color-danger\))/,
  'playing state must not turn the cue title into a shifted or coloured contrast chip',
);
assert.match(
  playlistItem,
  /const depthOffset = props\.depth > 0 \? 24 : 0;[\s\S]*marginLeft:\s*showMode\.value \? '0px' : `\$\{depthOffset\}px`[\s\S]*'--item-depth-offset':\s*`\$\{depthOffset\}px`[\s\S]*\.playlist-item\.show-mode\s*\{[\s\S]*\.item-color-rail\s*\{[\s\S]{0,100}left:\s*var\(--item-depth-offset, 0px\);[\s\S]*&\.is-group \.expand-btn\s*\{[\s\S]{0,120}transform:\s*translateX\(-8px\);/,
  'nested folders must align recursively without entering the fixed Show Mode play lane',
);
assert.match(
  playlistItem,
  /@container \(max-width: 700px\)\s*\{\s*\.playlist-item > \.item-content \.item-left\s*\{[^}]*grid-template-columns:\s*var\(--cue-leading-width, 34px\) minmax\(0, 1fr\)[^}]*'expand identity identity identity identity state video'\s*'\. \. shuffle actions transport duration arm'/,
  'the compact cue layout must retain a disclosure lane and give the title its own line above transport',
);
assert.match(
  playlistItem,
  /\.playlist-item:not\(\.show-mode\) > \.group-children\s*\{[\s\S]{0,80}padding-left:\s*var\(--spacing-md\);/,
  'Regular Mode must retain its existing nested-folder offset',
);
assert.match(
  playlistItem,
  /\.playlist-item:not\(\.show-mode\)\.is-group > \.item-content \.expand-btn\s*\{[^}]*translateX\(min\(10px, calc\(2px \+ var\(--folder-column-gap, var\(--spacing-sm\)\)\)\)\)/,
  'Regular Mode folder arrows must align with their child accent rail',
);
assert.match(
  playlistView,
  /v-if="canOnlineImport"[^>]*youtube[\s\S]*v-if="canOnlineImport"[^>]*spotifyImport[\s\S]*canOnlineImport = computed\(\(\) => !!currentProject\.value && server\.isLocalServer\)/,
  'online imports must only be shown for local projects',
);
assert.match(
  playlistView,
  /buildVerifiedAudioCue[\s\S]*color: colorForNewAudioItem\(settings, colorIndex\)[\s\S]*baseColorIndex = getAllItemsFlat\(project\.items\)[\s\S]*item\.type === 'audio'[\s\S]*baseColorIndex \+ offset/,
  'new playlist imports must receive their ordered palette color',
);
assert.match(
  playlistView,
  /<YouTubeImportModal[\s\S]{0,300}:project-folder-path="currentProject\?\.folderPath \?\? ''"[\s\S]{0,120}:project-epoch="projectEpoch"[\s\S]{0,120}:import-files="importFromServerPaths"/,
  'YouTube downloads must use the shared project importer and project generation',
);
assert.match(
  youtubeImport,
  /const projectFolderPath = props\.projectFolderPath;[\s\S]{0,100}const projectEpoch = props\.projectEpoch;[\s\S]*await props\.importFiles\([\s\S]{0,180}displayNames: \[result\.title\][\s\S]{0,300}!imported\.success \|\| imported\.imported !== 1/,
  'YouTube completion must wait for the shared importer and reject partial cue creation',
);
assert.match(
  playlistView,
  /const prepareImportFromServerPath[\s\S]*fallbackName = displayName\.trim\(\) \|\|[\s\S]*replace\(\/\\\.\[\^\/\.\]\+\$\/[\s\S]*options\?\.displayNames\?\.\[offset\]/,
  'the shared importer must keep collision-safe filenames out of operator-facing cue titles',
);
assert.doesNotMatch(
  youtubeImport,
  /importDownloadedFile|new Audio\(|DEFAULT_AUDIO_ITEM|addItem\(/,
  'YouTube imports must not bypass the shared metadata, waveform, color, or save path',
);
assert.match(
  youtubeImport,
  /const outputFormatOptions = computed\(\(\) => \(\['source', 'mp3', 'video'\] as const\)\.map\(value => \(\{\s*value, label: formatLabels\.value\[value\]/,
  'YouTube imports must retain all three labelled format choices',
);
assert.match(
  youtubeImport,
  /<InlineChoicePicker[^>]*:value="outputMode"[^>]*:options="outputFormatOptions"[^>]*@change="outputMode = \$event"/,
  'YouTube imports must bind their docked format selector to the download mode',
);
assert.match(
  youtubeImport,
  /v-if="video\.isLive"[\s\S]*:disabled="video\.isLive \|\| isDownloading\(video\.id\)"[\s\S]*v-if="download\.savedPath"[\s\S]*openDownloadFolder/,
  'YouTube results must block live downloads and retain saved-file information',
);
assert.match(
  oneShotPanel,
  /importFromServerPath[\s\S]*color: colorForNewAudioItem\(project\.settings, slot\)/,
  'new One Shot imports must receive their slot-ordered palette color',
);
assert.match(
  propertiesPanel,
  /handleCycleSelectedColors[\s\S]*getSelectedItems\(\)\.filter[\s\S]*item\.type === 'audio'[\s\S]*PRESET_COLORS\.indexOf[\s\S]*items\.forEach[\s\S]*await saveProject\(\)/,
  'cycling the current selection must recolor selected audio tracks in order and save once',
);
assert.doesNotMatch(
  playlistView + button,
  /bg-style="youtube"|btn--youtube|bgStyle/,
  'ordinary import controls must not compete with live danger red',
);
assert.match(
  actionButton,
  /v-bind="\$attrs"[\s\S]{0,100}:aria-label="getAccessibleLabel\(\)"[\s\S]{0,180}aria-hidden="true"[\s\S]*attrs\['aria-label'\][\s\S]*attrs\.title/,
  'shared icon actions must use their explicit label or title as an accessible name',
);
assert.match(
  actionButton,
  /if \(props\.isActive\)[\s\S]*backgroundColor: props\.highlightColor[\s\S]*borderColor: props\.highlightColor/,
  'active icon actions must render their requested solid highlight fill',
);
assert.match(
  actionButton,
  /\.action-btn--playlist:not\(\.action-btn--active\):not\(\.set-next-action\)\s*\{[\s\S]*background-color:\s*var\(--color-surface-hover\)[\s\S]*border-color:\s*var\(--action-highlight, var\(--color-accent\)\)[\s\S]*color:\s*var\(--action-highlight, var\(--color-accent\)\)[\s\S]*font-size:\s*clamp\(18px,/,
  'playlist buttons must keep their hover color while their icon size follows the enlarged row',
);
assert.match(
  actionButton,
  /\.action-btn--playlist\.set-next-action:not\(\.action-btn--active\)\s*\{[^}]*color:\s*var\(--color-text-secondary\);[\s\S]*\.action-label-default\s*\{[\s\S]*display:\s*none;[\s\S]*:hover \.action-label-hover\s*\{[\s\S]*display:\s*inline;[\s\S]*:hover \.material-symbols-rounded\s*\{[\s\S]*display:\s*none;/,
  'inactive Up Next must be legible in both themes and keep its icon and hover label',
);
assert.match(
  playlistItem,
  /class="item-color-rail" :style="\{ backgroundColor: item\.color \}" aria-hidden="true"[\s\S]*\.item-color-rail\s*\{[\s\S]{0,180}width:\s*4px;[\s\S]{0,100}z-index:\s*6;/,
  'every cue must keep its authored colour on a solid independent identity rail',
);
assert.match(
  playlistItem,
  /const itemStyle = computed[\s\S]{0,320}'--folder-background': 'var\(--color-surface-raised\)'[\s\S]*\.playlist-item\s*\{[\s\S]{0,500}background:\s*var\(--color-surface\);[\s\S]*&\.is-group > \.item-content\s*\{[\s\S]{0,100}background:\s*var\(--folder-background\)/,
  'audio rows must stay neutral while folder headers retain a distinct raised surface',
);
assert.doesNotMatch(
  playlistItem,
  /hexToRgba\(props\.item\.color|--folder-background': props\.item/,
  'authored cue colours must not tint structural row or folder backgrounds',
);
assert.doesNotMatch(
  playlistItem,
  /is-folder-track|isFolderTrack/,
  'folder children must not receive the folder header treatment',
);
assert.match(
  globalStyles,
  /--panel-header-height:\s*44px;[\s\S]*\.workspace-panel-header\s*\{[\s\S]*height:\s*var\(--panel-header-height\)[\s\S]*\.workspace-panel-header__title/,
  'workspace column headers must share one fixed geometry and title style',
);
assert.match(
  playlistView + oneShotPanel + mainWorkspace,
  /playlist-header workspace-panel-header[\s\S]*one-shot-header workspace-panel-header[\s\S]*output-console__header workspace-panel-header/,
  'Playlist, One Shots, and Output must all use the shared header system',
);
assert.match(
  playlistView,
  /saveProject\(\{ signal \}\)[\s\S]*retainFiles: true/,
  'an ambiguous cue-save result must retain downloaded media',
);
assert.match(
  playlistView,
  /mediaPath: `media\/\$\{fileName\}`[\s\S]*delete persisted\.mediaServerPath[\s\S]*delete persisted\.waveform[\s\S]*window\.electronAPI\.writeFile\([\s\S]*templatePath/,
  'detached Spotify projects must keep portable relative media paths and omit waveform caches',
);
assert.match(
  playlistView,
  /templateCommitted = true[\s\S]*addItem\(activeGroup\)[\s\S]*saveProject\(\{ signal \}\)[\s\S]*retainFiles: templateCommitted/,
  'a committed template must survive any failure while adding its named group to the active show',
);
assert.match(
  liveplayClient,
  /async function saveProjectTo[\s\S]*AbortSignal\.any\(\[signal, AbortSignal\.timeout\(30000\)\]\)[\s\S]*async function fetchMetadata[\s\S]*AbortSignal\.any\(\[signal, AbortSignal\.timeout\(30000\)\]\)[\s\S]*async function copyToMediaResult[\s\S]*AbortSignal\.any\(\[signal, AbortSignal\.timeout\(30000\)\]\)/,
  'cancellable Spotify REST requests must retain their normal hard timeout',
);
const restHelper = liveplayClient.slice(
  liveplayClient.indexOf('async function rest'),
  liveplayClient.indexOf('async function fetchCues'),
);
assert.match(
  restHelper,
  /init\?\.signal \?\? AbortSignal\.timeout\(30000\)/,
  'ordinary REST requests must retain the default timeout',
);
assert.doesNotMatch(
  restHelper,
  /AbortSignal\.any/,
  'the shared REST helper must preserve intentional long-operation timeouts',
);
const buildAll = read('scripts/build-all.js');
assert.match(
  buildAll,
  /ARTIFACT_PREFIX[\s\S]*entry\.name\.startsWith\(ARTIFACT_PREFIX\)/,
  'artifact collection must not recopy stale pre-rebrand installers',
);
const sanitizeNameStart = electron.indexOf('function sanitizeSpotifyFolderName');
const sanitizeNameEnd = electron.indexOf(
  '\n}\n\nfunction spotifyTrackId', sanitizeNameStart) + 2;
const createFolderStart = electron.indexOf('async function createSpotifyProjectFolder');
const createFolderEnd = electron.indexOf(
  '\n}\n\nfunction spotifyOutputTrackId', createFolderStart) + 2;
const orderedOutputsStart = electron.indexOf('function spotifyOutputTrackId');
const orderedOutputsEnd = electron.indexOf(
  '\n}\n\nasync function cleanupSpotifyFiles', orderedOutputsStart) + 2;
const cleanupOutputsStart = electron.indexOf('async function cleanupSpotifyFiles');
const cleanupOutputsEnd = electron.indexOf(
  '\n}\n\nasync function copySpotifyOutputsToMedia', cleanupOutputsStart) + 2;
const copyOutputsStart = electron.indexOf('async function copySpotifyOutputsToMedia');
const copyOutputsEnd = electron.indexOf(
  '\n}\n\nfunction releaseSpotifyJob', copyOutputsStart) + 2;
const sanitizeSpotifyFolderName = Function(
  'Buffer', `return (${electron.slice(sanitizeNameStart, sanitizeNameEnd)})`,
)(Buffer);
const createSpotifyProjectFolder = Function(
  'fs', 'path', `return (${electron.slice(createFolderStart, createFolderEnd)})`,
)(fs, path);
const { spotifyOutputTrackId, orderedSpotifyOutputs } = Function(
  'fs', 'path',
  `${electron.slice(orderedOutputsStart, orderedOutputsEnd)};
   return { spotifyOutputTrackId, orderedSpotifyOutputs };`,
)(fs, path);
const cleanupSpotifyFiles = Function(
  'fs', `return (${electron.slice(cleanupOutputsStart, cleanupOutputsEnd)})`,
)(fs);
const copySpotifyOutputsToMedia = Function(
  'fs', 'path', 'pipeline',
  `return (${electron.slice(copyOutputsStart, copyOutputsEnd)})`,
)(fs, path, pipeline);

assert.equal(
  sanitizeSpotifyFolderName('../../My: Playlist\u0000 '),
  'My Playlist',
  'Spotify list names must not create traversal paths or illegal filenames',
);
assert.equal(
  sanitizeSpotifyFolderName('...'),
  'Spotify Import',
  'unsafe or empty Spotify list names must use the safe fallback',
);
assert.ok(
  Buffer.byteLength(sanitizeSpotifyFolderName('🎵'.repeat(100)), 'utf8') <= 120,
  'Spotify list folders must stay within the bounded UTF-8 name length',
);

async function checkSpotifyCopyTransaction() {
  const spotifyTestRoot = fs.mkdtempSync(
    path.join(require('node:os').tmpdir(), 'dwcue-spotify-test-'),
  );
  try {
    const staging = path.join(spotifyTestRoot, 'staging');
    const media = path.join(spotifyTestRoot, 'media');
    fs.mkdirSync(staging);
    fs.mkdirSync(media);
    const firstId = '1111111111111111111111';
    const secondId = '2222222222222222222222';
    fs.writeFileSync(path.join(staging, `${firstId} - First.mp3`), 'first');
    fs.writeFileSync(path.join(staging, `${secondId}-Second.mp3`), 'second');
    fs.writeFileSync(
      path.join(staging, 'dwcue-spotify-order.m3u8'),
      `#EXTM3U\n${secondId}-Second.mp3\n${secondId}-Second.mp3\n${firstId} - First.mp3\n`,
    );
    fs.writeFileSync(path.join(media, 'Second.mp3'), 'existing');
    const job = {
      cancelled: false,
      files: [],
      abortController: new AbortController(),
    };
    const copied = await copySpotifyOutputsToMedia(
      orderedSpotifyOutputs(staging, [secondId, firstId]), media, job,
    );
    assert.equal(
      spotifyOutputTrackId(path.join(staging, `${secondId}-Second.mp3`), [firstId, secondId]),
      secondId,
      'strict filename sanitization must still map downloaded audio to its Spotify track',
    );
    assert.deepEqual(
      copied.map((file) => path.basename(file)),
      ['Second (2).mp3', 'First.mp3'],
      'Spotify selection order must be preserved without duplicating m3u entries or leaking track IDs',
    );
    await cleanupSpotifyFiles(job);
    assert.deepEqual(
      fs.readdirSync(media),
      ['Second.mp3'],
      'Spotify rollback must remove only files created by its job',
    );

    const abortedJob = {
      cancelled: false,
      files: [],
      abortController: new AbortController(),
    };
    abortedJob.abortController.abort();
    await assert.rejects(
      copySpotifyOutputsToMedia([path.join(staging, `${firstId} - First.mp3`)], media, abortedJob),
      /abort/i,
      'Spotify media copying must stop when its job is cancelled',
    );
    assert.deepEqual(
      fs.readdirSync(media),
      ['Second.mp3'],
      'an aborted copy must remove its partial destination',
    );

    const destinationParent = path.join(spotifyTestRoot, 'destination');
    fs.mkdirSync(destinationParent);
    fs.mkdirSync(path.join(destinationParent, 'The Exact Spotify List'));
    const folderJob = { files: [], ownedDirectories: [] };
    const created = await createSpotifyProjectFolder(
      destinationParent, 'The Exact Spotify List', folderJob,
    );
    assert.equal(
      path.basename(created.projectFolderPath),
      'The Exact Spotify List (2)',
      'Spotify project folders must be created exclusively with a unique suffix',
    );
    assert.equal(
      path.dirname(created.mediaDir),
      created.projectFolderPath,
      'Spotify audio must land in the child project media folder',
    );
    await cleanupSpotifyFiles(folderJob);
    assert.deepEqual(
      fs.readdirSync(destinationParent),
      ['The Exact Spotify List'],
      'rollback must remove only empty directories owned by its Spotify job',
    );

    const reusedPath = path.join(destinationParent, 'The Exact Spotify List');
    const retryJob = { files: [], ownedDirectories: [] };
    const reused = await createSpotifyProjectFolder(
      destinationParent, 'Ignored Retry Name', retryJob, reusedPath,
    );
    assert.equal(
      reused.projectFolderPath,
      reusedPath,
      'Spotify retry must reuse its reviewed project folder',
    );
    await cleanupSpotifyFiles(retryJob);
    assert.equal(
      fs.existsSync(reusedPath),
      true,
      'retry cleanup must not remove the original project folder',
    );
  } finally {
    fs.rmSync(spotifyTestRoot, { recursive: true, force: true });
  }
}

const workspace = read('client/app/components/MainWorkspace.vue');
assert.match(workspace, /uiMode\.value === 'playback'[\s\S]*e\.key === 'Delete'[\s\S]*key === 'd'[\s\S]*key === 'v'/, 'Show Mode must block destructive workspace shortcuts');
assert.doesNotMatch(
  workspace,
  /onTriggerItem|onStopItem|onTriggerCartSlot|onStopAllCues|onApiUpdateItem|onApiUpdateCartItem|sendApiResponse/,
  'workspace startup must not call retired preload APIs',
);
assert.match(appVue, /downloadArchiveToFile\(result\.downloadToken, opts\.downloadTo\.folder,/,
  'remote archive exports must bypass renderer memory');
assert.match(
  appVue,
  /runExport[\s\S]*await saveProject\(\{ force: true \}\)[\s\S]*exportProjectArchive/,
  'project export must persist the authoritative document before zipping disk state',
);

assert.match(
  appVue,
  /watch\(theme,[\s\S]*document\.documentElement\.dataset\.theme = value/,
  'the document root must carry the active theme so teleported dialogs inherit theme variables',
);
assert.match(
  appVue,
  /runImport\(source: ArchiveSource[\s\S]*importProjectArchiveUpload\(source\.file[\s\S]*importProjectArchiveFromClientPath\(source\.path/,
  'remote archives from the dock and from file associations must both use chunked upload',
);
assert.match(appVue, /defer to="#workspace-import-host"[\s\S]*class="archive-panel"[\s\S]*<progress[\s\S]*<ServerFilePickerModal [^>]*docked/,
  'archive destination, progress and results must share the lower workspace');
assert.doesNotMatch(appVue + workspace, /<(?:LocationChoiceModal|ProgressModal|ProjectSelectionModal)/,
  'archive operations must not mount the old blocking dialogs');
assert.doesNotMatch(appVue + electron, /show(Open|Save)ArchiveDialog|show-(open|save)-archive-dialog/,
  'remote archive actions must stay in the dock');
assert.match(appVue, /function showArchiveFailure[\s\S]*phase: 'failed', message[\s\S]*showHeaderWarning\(message, 'urgent'\)/,
  'archive failures must appear in the dock and header');
assert.equal((appVue.match(/openImportedArchive\(/g) ?? []).length, 2,
  'an archive may open only from the operator action in its receipt');
assert.match(
  appVue,
  /if \(update\.installOnExit\)[\s\S]{0,260}runAfterInstall: false/,
  'Install on Exit must pass the no-relaunch mode through the quit IPC',
);

const macSigner = read('client/scripts/sign-mac.js');
assert.match(
  macSigner,
  /server-bin[\s\S]*dwcue-server[\s\S]*optionsForFile[\s\S]*entitlements: serverEntitlementsPath[\s\S]*signAsync/,
  'the bundled native server must receive its restricted entitlements during normal signing',
);

const spotifyImportModal = read('client/app/components/SpotifyImportModal.vue');
const youtubeImportModal = read('client/app/components/YouTubeImportModal.vue');
assert.match(mainWorkspace, /class="workspace-import-close" :aria-label="t\('actions\.close'\)"/,
  'the shared import close button must expose an accessible name');
assert.match(playlistView,
  /<Teleport defer to="#workspace-import-host">\s*<section v-if="workspaceImportPanel === 'import-choice'"[\s\S]*?<\/section>\s*<YouTubeImportModal[\s\S]*:visible="workspaceImportPanel === 'youtube'"\s*:is-open="importOpen.youtube"[\s\S]*<SpotifyImportModal[\s\S]*:visible="workspaceImportPanel === 'spotify'"\s*:open="importOpen.spotify"[\s\S]*<AudioImportModal [^>]*docked/,
  'hiding an import must preserve its job and selection inside the shared workspace');
assert.match(playlistView,
  /<Btn icon="add" :text="t\('playlist\.importMenu'\)"[^>]*@click="handleImportButton" \/>/,
  'the playlist must offer one Import button, not one per source');
assert.doesNotMatch(playlistView.slice(0, playlistView.indexOf('<Teleport defer to="#workspace-import-host">')),
  /youtube\.importFromYouTube|playlist\.importYouTube|spotifyImport\.button/,
  'YouTube and Spotify belong in the Import chooser, not on the playlist bar');
assert.match(playlistView,
  /handleImportButton = \(\) => \{\s*if \(!currentProject\.value\) return;\s*if \(!canOnlineImport\.value\) return handleImport\(\);/,
  'with only one import source the Import button must go straight to it');
// Keep-awake: the computer must not sleep during a show.
assert.match(electron,
  /ipcMain\.handle\('power:keep-awake', \(event, state\) => \{\s*requireTrustedIpc\(event\);\s*requireBoundedIpcObject\(state, 'keep-awake state', 1024\);[\s\S]{0,260}if \(!mainWindow \|\| event\.sender !== mainWindow\.webContents\) return false;\s*applyKeepAwake\(powerSaveBlocker, keepAwakeHolds, keepAwakePlan\(state\)\);/,
  'only the operator window may set the keep-awake holds, through a validated request');
assert.match(electron,
  /mainWindow\.on\('closed', \(\) => \{\s*mainWindow = null;[\s\S]{0,120}releaseKeepAwake\(\);/,
  'closing the operator window must let the computer sleep again');
assert.match(read('client/electron/keep-awake.js'),
  /system: showOpen \|\| playing,\s*display: \(showOpen && showMode\) \|\| playing,/,
  'an open show must hold off system sleep, and Show Mode or playback must keep the screen on');
assert.match(read('client/app/app.vue'),
  /if \(!isCartWindow && !isVideoOutputWindow\) useKeepAwake\(\);/,
  'the operator window must report the show state for keep-awake');

// Cue sheet export: a read-only PDF of the open show.
const cueSheetModule = read('client/electron/cue-sheet.js');
assert.match(electron,
  /ipcMain\.handle\('export-cue-sheet', async \(event, payload\) => \{\s*requireTrustedIpc\(event\);[\s\S]{0,200}requireBoundedIpcObject\(payload, 'cue sheet', CUE_SHEET_LIMITS\.maxPayloadBytes\);/,
  'the cue sheet export must accept only a trusted, size-limited summary from the renderer');
assert.match(electron,
  /const result = await showNativeFilePicker\(\(\) => dialog\.showSaveDialog\([\s\S]{0,1400}await fs\.promises\.writeFile\(result\.filePath, pdf\);/,
  'a cue sheet must be written only where the native save dialog says, never to a path from the renderer');
assert.match(cueSheetModule,
  /function cueSheetWindowOptions\(\) \{[\s\S]{0,260}sandbox: true,\s*contextIsolation: true,\s*nodeIntegration: false,\s*javascript: false,/,
  'the hidden window that prints a cue sheet must be sandboxed with JavaScript off');
assert.doesNotMatch(cueSheetModule, /require\(['"]electron['"]\)|<script/i,
  'the cue sheet builder must stay a pure module and must not generate script');
assert.match(mainWorkspace,
  /const MAX_PANEL_HEIGHT_PERCENT = 60;[\s\S]*const IMPORT_MAX_PANEL_HEIGHT_PERCENT = 84;[\s\S]*roomyPanel = computed\(\(\) => tallImportPanel\.value \|\| decisionOpen \|\| !!filePicker\.value\);\s*const panelMaxPercent = computed\(\(\) => roomyPanel\.value \? IMPORT_MAX_PANEL_HEIGHT_PERCENT : MAX_PANEL_HEIGHT_PERCENT\)/,
  'importers may grow taller than Settings and Properties, but never to the whole window: the transport bar stays in view');
assert.match(mainWorkspace,
  /visibleImportPanel\.value === 'media' \? `\$\{IMPORT_PANEL_HEIGHT_PERCENT\}%` : 'auto'/,
  'the file browser must open tall instead of at a few rows');
assert.match(read('client/app/components/ServerFileBrowser.vue'),
  /&--staging &__content \{\s*flex: 1 1 clamp\(128px, 24vh, 192px\);/,
  'the staged file list must grow with its panel instead of being capped at a few rows');
const itemLevel = read('client/app/components/ItemLevel.vue');
assert.match(playlistItem,
  /<div class="item-state">[\s\S]*<ItemLevel :item="item" :read-only="showMode" :large="showMode" :disabled="!projectControlsReady" \/>\s*<\/div>\s*<span v-if="item\.type === 'audio'" class="item-duration"/,
  'every row must show its level at the right of the state lane');
assert.match(read('client/app/components/OneShotTile.vue'),
  /<ItemLevel :item="item" :read-only="showMode" :large="showMode" :max-db="12"\s*:persist="\(\) => persist\(\{ volume: item\.volume \}\)" \/>/,
  'a QuickPlay tile must use the same level control, saved the way the tile saves its other settings');
assert.match(itemLevel,
  /<output v-if="readOnly" class="item-level__value item-level__value--readout"[\s\S]*<input v-else class="item-level__value" type="number"[\s\S]*<span class="item-level__spin">[\s\S]*arrow_drop_up[\s\S]*arrow_drop_down/,
  'the level is one compact control: a number (never a text field in Show Mode) with stacked up and down arrows');
assert.match(itemLevel,
  /\.item-level__spin \{[\s\S]{0,120}grid-template-rows: 1fr 1fr;\s*width: 16px;[\s\S]*\.item-level--large \{[\s\S]{0,260}\.item-level__spin \{ width: 28px; \}/,
  'the level arrows must stay stacked and slim in both sizes');
assert.doesNotMatch(itemLevel + playlistItem, /row-level__step|levelArrowsOpen|v-if="[^"]*" class="item-level__spin"/,
  'the level arrows must not depend on selection or a tap, and must not return to side-by-side buttons');
assert.match(itemLevel,
  /const STEP_DB = 0\.5;[\s\S]*function nudge\(direction: number, event: Event\) \{[\s\S]{0,260}\* STEP_DB\);[\s\S]{0,200}\.blur\(\);/,
  'a press of a level arrow must move a cue or a group by half a dB and give the keyboard back to the transport');
assert.match(itemLevel,
  /if \(props\.item\.type === 'group'\) props\.item\.groupGainDb = next;\s*else props\.item\.volume = dbToLinear\(next\);[\s\S]{0,260}if \(props\.persist\) props\.persist\(\); else void saveProject\(\);/,
  'the level must edit the same volume and groupGainDb values as Properties; nothing new is stored');
assert.doesNotMatch(playlistItem, /groupGainDb\s*=|\.volume\s*=/,
  'the playlist row must not carry a second copy of the level logic');
assert.match(playlistItem,
  /function commitNote\(\) \{[\s\S]{0,260}if \(note\) props\.item\.note = note;\s*else delete props\.item\.note;[\s\S]{0,120}void saveProject\(\);/,
  'a playlist note must be its own field: writing one must never change the cue title or the media file name');
assert.doesNotMatch(playlistItem, /props\.item\.displayName\s*=/,
  'the playlist row must not rename a cue; titles are edited in Properties');
assert.match(playlistItem,
  /\.delete-action \{ grid-column: 1; grid-row: 1; \}\s*\.edit-action \{ grid-column: 2; grid-row: 1; \}[\s\S]{0,120}\.delete-action--parked \{ display: none; \}\s*\.item-actions--single \{ grid-template-columns: 32px; \}/,
  'Delete must sit away from Play with Edit between them, and appear only on a selected row');
assert.doesNotMatch(spotifyImportModal + youtubeImportModal, /aria-modal|--dialog-backdrop|<Teleport to="body"/,
  'online imports must not block the playlist or transport with a modal');

const electronMain = read('client/electron/main.js');
assert.match(
  read('client/app/components/ProjectHeader.vue'),
  /class="header-setup"\s+:class="\{ 'header-setup--folded': showMode, 'header-setup--open': showMode && setupOpen \}"[\s\S]*id="header-setup-items" class="header-setup__items" @click="setupOpen = false"[\s\S]*t\('settings\.title'\)[\s\S]*t\('settings\.tabVideoOutput'\)[\s\S]*class="autosave-toggle"[\s\S]*<\/div>\s*<\/div>\s*<!-- Show Mode toggle:[\s\S]*\.header-setup,\s*\.header-setup__items \{\s*display: contents;/,
  'Show Mode folds the setup controls into one menu and keeps the Show Mode switch out of it; Edit Mode lays them out as before',
);
assert.doesNotMatch(
  read('client/app/components/ProjectHeader.vue'),
  /setupOpen[^\n]*Escape|Escape[^\n]*setupOpen/,
  'the Setup menu never takes Escape: it is Stop All',
);
// Every small Stop All button wears the shared striped edge; none is red.
for (const file of [
  'client/app/app.vue', 'client/app/components/SessionRecoveryModal.vue',
  'client/app/components/ConnectionLostModal.vue', 'client/app/components/ServerFilePickerModal.vue',
  'client/app/components/AudioImportModal.vue', 'client/app/components/OneShotPanel.vue',
]) {
  const source = read(file);
  assert.equal(
    (source.match(/stop-all-btn/g) ?? []).length,
    (source.match(/t\('controls\.stopAll'\)/g) ?? []).length,
    `${file}: every Stop All button carries the stop-all-btn class`,
  );
}
assert.match(
  read('client/assets/styles/main.scss'),
  /\.stop-all-btn\.stop-all-btn\.stop-all-btn:hover:not\(:disabled\) \{[^}]*?border: var\(--stop-button-border\);\s*background: var\(--stop-button-background\);\s*color: var\(--color-text-primary\);/,
  'the small Stop All buttons keep their hazard stripes, also under the pointer',
);
assert.doesNotMatch(
  read('client/app/app.vue') + read('client/app/components/OneShotPanel.vue'),
  /(?:cart-recovery-stop|detached-quickplay-stop)[^}]*color: var\(--color-danger\)/,
  'Stop is never red',
);
// Level Check and Pre-show check open from Settings, not from the top bar.
assert.doesNotMatch(
  read('client/app/components/ProjectHeader.vue'),
  /levelCheck|showCheck|useLevelCheck|usePreShowCheck/,
  'the top bar holds no check buttons',
);
assert.match(
  read('client/app/components/ProjectSettingsModal.vue'),
  /v-if="activeTab === 'audio'">[\s\S]*?class="settings-rows show-checks"[\s\S]*?@click="openShowCheck">\{\{ t\('showCheck\.title'\) \}\}[\s\S]*?:disabled="levelCheckCount === 0"\s+@click="toggleLevelCheck">\{\{ t\('levelCheck\.title'\) \}\}[\s\S]*?const \{ open: openShowCheck \} = usePreShowCheck\(\);[\s\S]*?useLevelCheck\(\);/,
  'Settings › Audio Routing opens the Pre-show check and Level Check',
);
const stillCapture = read('client/app/composables/useVideoStandbyCapture.ts');
assert.match(
  stillCapture,
  /async function captureStill\(target: StillTarget, source: 'output' \| 'display' = 'output'\)[\s\S]*await server\.uploadFile\(dataUrlToFile\(image, name\), name, sessionId\)[\s\S]*const previous = [\s\S]*lastCapture\.value = \{ target, itemUuid: cue\?\.uuid \?\? null, cueLabel: label, image, path, previous \};/,
  'a capture says what it is for when it is taken, is saved into the show, and remembers what it replaced for Undo',
);
assert.match(
  stillCapture,
  /const captureCue = computed<AudioItem \| null>\(\(\) => \{\s*for \(const uuid of \[\.\.\.activeCues\.value\.keys\(\)\]\.reverse\(\)\) \{/,
  'a capture for a cue goes to the cue that is playing before the one that is merely selected',
);
assert.doesNotMatch(
  read('client/app/components/VideoConfidenceChip.vue'),
  /captureStill|captureStandby\(/,
  'the top-bar Video Output picture opens the capture panel; a single click never captures',
);
assert.doesNotMatch(
  electronMain + stillCapture + read('client/locales/en.json').replace(/"showCheck"[\s\S]*?\n  \},/, ''),
  /screen recording permission|Check (?:the )?(?:system|privacy) settings/i,
  'a failed screen capture is said plainly, with no advice about system settings',
);
assert.match(
  electronMain,
  /ipcMain\.handle\('video-output:convert-cue', async \(event, request\) => \{\s*requireVideoCheckOwner\(event\);[\s\S]{0,700}if \(readLiveplayConfig\(\)\.mode === 'remote'\) return \{ status: 'failed', reason: 'remote' \};\s*const sourcePath = cueSourcePath\(currentProjectData\?\.folderPath, cue\);[\s\S]{0,700}if \(!await setupFfmpeg\(\) \|\| !ffmpegPath\) return \{ status: 'failed', reason: 'no-converter' \};/,
  'only the main workspace can ask for a conversion; the file is looked up here, never taken from the request, and only on this computer',
);
// Clean Up Media moves files to the Trash and does nothing else to a file.
{
  const mediaCleanup = /\/\/ Clean Up Media: files in the show's media folder that nothing uses[\s\S]*?ipcMain\.handle\('media:trash-unused', async \(event, request\) => \{[\s\S]*?\n\}\);/
    .exec(electronMain)?.[0] ?? '';
  assert.match(
    mediaCleanup,
    /async function findUnusedShowMedia\(\) \{[\s\S]{0,200}if \(readLiveplayConfig\(\)\.mode === 'remote'\) return \{ available: false, reason: 'remote' \};[\s\S]*ipcMain\.handle\('media:trash-unused', async \(event, request\) => \{\s*requireMediaCleanupOwner\(event\);[\s\S]*if \(!isPlainFileName\(name\)\) throw[\s\S]*const found = await findUnusedShowMedia\(\);[\s\S]*const target = listed \? mediaFilePath\(found\.showFolder, name\) : null;[\s\S]*await shell\.trashItem\(target\);/,
    'only the main workspace can clean up media, only on this computer; it names files, never paths, and each is found unused again here before it goes to the Trash',
  );
  assert.doesNotMatch(
    mediaCleanup + read('client/electron/unused-media.js'),
    /\b(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|writeFile|writeFileSync|appendFile|copyFile|truncate)\s*\(|shell\.(?!trashItem\()\w+\(/,
    'cleaning up media never deletes, renames or writes a file: the Trash is the only place a file goes',
  );
}
const electronPreload = read('client/electron/preload.js');
assert.match(
  electronMain,
  /role: 'editMenu'/,
  'the desktop menu must preserve native text editing actions, including paste',
);
assert.match(
  electronMain,
  /get-youtube-info[\s\S]*search-youtube[\s\S]*isLive: item\.isLive === true[\s\S]*download-youtube-audio[\s\S]*!\['source', 'mp3', 'video'\]\.includes\(outputMode\)[\s\S]*outputBaseName = `\$\{sanitizedTitle\} \[\$\{videoId\}\]`/,
  'YouTube IPC must expose live state, validate output mode, and use collision-resistant names',
);
assert.match(
  electronMain,
  /const args = outputMode === 'video'[\s\S]*: \[videoUrl, '-f', 'bestaudio'\];[\s\S]{0,120}if \(outputMode === 'mp3'\)[\s\S]{0,180}'--extract-audio'[\s\S]{0,120}'--audio-quality', '0'/,
  'source downloads must avoid conversion while MP3 mode explicitly requests V0 extraction',
);
assert.match(
  electronMain,
  /existingOutputs = new Set\([\s\S]{0,500}const cleanupNewOutputs = \(\) =>[\s\S]*if \(code !== 0\) \{\s*cleanupNewOutputs\(\)/,
  'failed YouTube downloads must remove only files created by that attempt',
);
assert.match(
  electronPreload,
  /downloadYouTubeAudio: \(jobId, videoId, title, projectFolderPath, outputMode, progressCallback\)[\s\S]*'download-youtube-audio'[\s\S]{0,120}jobId,[\s\S]{0,120}projectFolderPath,[\s\S]{0,40}outputMode,/,
  'the renderer must pass the selected YouTube output mode across IPC',
);
assert.match(
  electronMain,
  /activeYouTubeDownloads[\s\S]*cancel-youtube-download[\s\S]*detached: process\.platform !== 'win32'[\s\S]*job\.cancelled[\s\S]*cleanupNewOutputs/,
  'YouTube downloads must be renderer-scoped cancellable process-tree jobs',
);
assert.match(
  youtubeImportModal,
  /extractYouTubeVideoId[\s\S]*getYouTubeInfo[\s\S]*cancelYouTubeDownload[\s\S]*retryDownload/,
  'YouTube import must accept direct links and expose cancel and retry controls',
);
assert.match(
  electronMain,
  /spotify-preflight[\s\S]*'save', metadataUrl, '--save-file', metadataFile, '--ffmpeg', ffmpegPath[\s\S]*selectedTracks = selectedTrackIds\.map[\s\S]*selectedTracks\.some\(\(track\) => !track\)[\s\S]*const chunkTracks = selectedTracks\.slice[\s\S]*'url', \.\.\.chunkTracks\.map\(\(track\) => track\.spotifyUrl\)/,
  'Spotify review must stay metadata-only and download only the validated selected tracks',
);
assert.match(
  spotifyImportModal,
  /reviewSummary[\s\S]*const selectedTrackIds[\s\S]*reviewSpotify[\s\S]*retryFailed/,
  'Spotify import must show a selectable metadata review and failed-only retry',
);
assert.match(
  spotifyImportModal,
  /resultState && !isActive[\s\S]*startAnotherImport[\s\S]*retryUnmatched[\s\S]*continueWithTracks[\s\S]*continueToProject/,
  'completed Spotify imports must make continuing primary while retaining retry and another-import paths',
);
assert.doesNotMatch(
  spotifyImportModal,
  /li\.failed \.track-info/,
  'provider availability must not use the visual language of an application failure',
);
assert.equal(
  enLocale.spotifyImport.status.partial,
  'Import complete',
  'provider availability must be presented as a completed import, not an application error',
);
assert.match(
  electronMain,
  /activeSpotifyPreflightJobs[\s\S]*cancel-spotify-preflight[\s\S]*terminateSpotifyChild[\s\S]*reusePreviousFolder[\s\S]*preflight\.projectFolderPath/,
  'Spotify review must be cancellable and failed-only retries must reuse the reviewed playlist folder',
);
assert.match(
  spotifyImportModal,
  /cancelSpotifyPreflight[\s\S]*trackImportResults[\s\S]*toggleImportedPreview[\s\S]*reusePreviousFolder:\s*retry[\s\S]*existingGroupUuid/,
  'Spotify review cancellation, operator preview, and retry-in-place must stay wired through the renderer',
);
assert.match(
  audioImportModal,
  /:value="fileMode" :options="fileModeOptions"[\s\S]*:value="duplicatePolicy" :options="duplicatePolicyOptions"[\s\S]*retryFailed[\s\S]*result\.results[\s\S]*const fileMode[\s\S]*const duplicatePolicy[\s\S]*copyFiles[\s\S]*linkFiles[\s\S]*function retryFailed/,
  'local import must preserve source controls while exposing Copy, Link, duplicates, and per-file results',
);
assert.match(
  `${audioImportModal}\n${playlistView}`,
  /emit\('cancel'\)[\s\S]*audioImportAbortController[\s\S]*onProgress[\s\S]*signal\?\.aborted/,
  'local batch verification must expose progress and abort through its existing import path',
);
assert.match(
  playlistView,
  /existingGroupUuid[\s\S]*templateGroup\.children\.push[\s\S]*targetGroup\.children\.push[\s\S]*groupUuid:\s*activeGroupUuid/,
  'Spotify retries must append to the original template and active cue group',
);
assert.match(
  propertiesPanel,
  /<ServerFilePickerModal [^>]*\bdocked\b[^>]*location-context="replace-media"\s+@pick="handleReplaceMedia"[\s\S]*const handleReplaceMedia = [\s\S]*buildWaveformFromChannels[\s\S]*const snapshot = [\s\S]*await saveProject\(\)[\s\S]*Object\.assign\(item, snapshot\)/,
  'media replacement must stay docked, decode first, and restore the original cue if saving fails',
);
assert.match(
  controlServer,
  /same_file_contents[\s\S]*matching_media_file[\s\S]*duplicate_policy[\s\S]*duplicate_policy == "skip"/,
  'the media copy trust boundary must implement exact-content reuse and skip policies',
);

assert.match(
  uiMode,
  /CART_GRID_LIMITS[\s\S]*rows:\s*\{ min: 1, max: 16 \}[\s\S]*columns:\s*\{ min: 1, max: 16 \}[\s\S]*attachedRegular[\s\S]*attachedShow[\s\S]*detachedRegular[\s\S]*detachedShow[\s\S]*normalizeCartGridLayouts[\s\S]*CART_GRID_LAYOUTS_KEY[\s\S]*setCartGridLayout/,
  'cart layouts must keep four bounded per-device profiles',
);
assert.match(
  oneShotPanel,
  /props\.isDetachedWindow[\s\S]*'detachedShow'[\s\S]*'detachedRegular'[\s\S]*'attachedShow'[\s\S]*'attachedRegular'[\s\S]*const contentMinHeight = Math\.ceil\(\(showMode\.value \? 143 : 111\) \+ 48 \* oneShotFontScale\.value \/ 100\);[\s\S]{0,100}const minHeight = Math\.max\(layout\.minHeight, contentMinHeight\);[\s\S]{0,260}--one-shot-columns[\s\S]*--one-shot-row-height[\s\S]*grid-template-columns:\s*repeat\(var\(--one-shot-columns, 2\), minmax\(128px, 1fr\)\)[\s\S]{0,160}grid-auto-rows:\s*var\(--one-shot-row-height, 106px\)[\s\S]{0,240}overflow-x:\s*auto;[\s\S]{0,80}overflow-y:\s*auto;/,
  'One Shots must preserve exact profile columns while reserving a measured safe width and font-scaled two-line row height',
);
assert.doesNotMatch(
  oneShotPanel,
  /grid-template-columns:\s*repeat\(\s*auto-fit|--one-shot-min-card-width|--one-shot-target-card-width/,
  'automatic fitting must not override the operator-selected One Shot columns',
);
assert.match(
  oneShotPanel,
  /\.one-shot-grid\s*\{[\s\S]{0,500}scrollbar-gutter:\s*stable;/,
  'the One Shot grid must reserve a stable scrollbar gutter',
);
assert.match(
  playlistView,
  /\.playlist-header,\s*\.playlist-content\s*\{\s*scrollbar-gutter:\s*stable;/,
  'the playlist header and track list must reserve the same scrollbar gutter',
);
assert.match(
  uiMode,
  /attachedShow:\s*\{[\s\S]{0,180}minHeight:\s*72,[\s\S]{0,180}default:\s*\{\s*rows:\s*8,\s*columns:\s*2,\s*minHeight:\s*112\s*\}/,
  'attached Show Mode One Shot cells must keep a compact configurable minimum with a safe default',
);
assert.match(
  oneShotTile,
  /\.show-mode \.one-shot-actions\s*\{\s*width:\s*100%;\s*grid-auto-columns:\s*minmax\(0, 1fr\);\s*\}[\s\S]*\.show-mode \.one-shot-control\s*\{\s*width:\s*44px;\s*height:\s*44px;\s*\}/,
  'Show Mode One Shot cells must use a full-width bottom action strip with clear transport targets',
);
assert.match(
  oneShotPanel,
  /buildOneShotSlots\([\s\S]*layout\.rows \* layout\.columns[\s\S]*roundedLength[\s\S]*slots\.push\(null\)/,
  'One Shot cells must remain a permanent grid sized by the active layout rather than playlist contents',
);
assert.match(
  oneShotPanel,
  /if \(showMode\.value\) \{\s*let lastUsed = slots\.length - 1;\s*while \(lastUsed >= 0 && !slots\[lastUsed\]\) lastUsed -= 1;\s*slots\.length = Math\.ceil\(\(lastUsed \+ 1\) \/ layout\.columns\) \* layout\.columns;/,
  'Show Mode must drop only the empty rows after the last QuickPlay, so every QuickPlay keeps its place',
);
assert.doesNotMatch(oneShotPanel, /v-for="slot in 16"/, 'One Shots must not return to a fixed 16-cell grid');
assert.match(
  oneShotPanel,
  /moveOneShotToSlot[\s\S]*source\.oneShot\.order = targetSlot[\s\S]*if \(target\?\.oneShot\) target\.oneShot\.order = sourceSlot/,
  'One Shot reordering must swap its permanent cell assignments instead of rebuilding the list',
);
assert.match(
  projectSettingsModal,
  /cart-layout-grid[\s\S]*minimumCardHeight[\s\S]*visibleRows[\s\S]*columns[\s\S]*cartGridProfileOptions[\s\S]*attachedRegular[\s\S]*attachedShow[\s\S]*detachedRegular[\s\S]*detachedShow[\s\S]*onCartGridLayoutChange[\s\S]*input\.value\.trim\(\)[\s\S]*setCartGridLayout/,
  'settings must expose height, visible rows, and columns for all four One Shot layout profiles',
);
assert.match(
  controlConfig,
  /v-for="entry in configuredOneShots"[\s\S]*entry\.slotIndex[\s\S]*buildOneShotSlots[\s\S]*const configuredOneShots/,
  'keyboard and MIDI configuration must follow the configured One Shot cells',
);
assert.match(
  appVue + mainWorkspace,
  /<MainWorkspace v-else :decision-open="projectPanelOpen"[\s\S]*?to="#workspace-project-decision"[\s\S]*?<ProjectDecisionPanel[\s\S]*?class="lower-workspace-panel"[\s\S]*?id="workspace-project-decision"/,
  'Quit and unsaved changes must use the lower workspace panel',
);
assert.doesNotMatch(projectDecisionPanel, /aria-modal|position:\s*fixed|keydown|Teleport/,
  'project decisions must leave pointer and keyboard transport available');
assert.match(appVue, /to="#workspace-project-decision"[\s\S]*?<ProjectDecisionPanel v-else-if="projectDecision"[\s\S]*?class="project-file-panel"[\s\S]*?role="status"[\s\S]*?<ServerFilePickerModal v-else-if="projectPicker" docked[\s\S]*?class="new-show-form" @submit.prevent="createNewShow"[\s\S]*?<\/Teleport>/,
  'New Show, Open Project, their progress and the save decision must share the lower panel');
assert.match(appVue, /to="#workspace-project-decision"[\s\S]*?data-recovery-panel[\s\S]*?<ConnectionLostModal v-if="reconnectPanelOpen" docked[\s\S]*?<SessionRecoveryModal v-else[\s\S]*?<\/Teleport>/,
  'reconnect and session recovery must share the lower panel in the operator window');
assert.doesNotMatch(appVue, /<LoadingOverlay\b/,
  'show loads must leave the playlist and transport visible');
assert.match(
  midiController,
  /`trigger-slot-\$\{number\}`[\s\S]*length:\s*CART_SLOT_COUNT_LIMITS\.max/,
  'MIDI cart actions must cover every supported card',
);
assert.match(
  projectState,
  /patch\.find\("cartSlotCount"\)[\s\S]*is_number_integer\(\)[\s\S]*slots < 1 \|\| slots > 64/,
  'the project settings trust boundary must reject invalid card counts',
);
assert.match(
  controlServer,
  /if \(!state_\.set_cart_slot\(slot, uuid\)\)[\s\S]*slot must be between 0 and 63/,
  'the cart API must not report success for a slot the project rejected',
);
assert.match(
  electronMain,
  /cart-grid-layouts-changed[\s\S]*requireIpcString\(layouts, 'layouts', 4096\)[\s\S]*cart-grid-layouts-set/,
  'cart layout IPC must validate and forward the bounded serialized preference',
);
assert.match(
  electronPreload,
  /broadcastCartGridLayouts[\s\S]*cart-grid-layouts-changed[\s\S]*onCartGridLayoutsSet[\s\S]*cart-grid-layouts-set/,
  'the preload bridge must sync cart layout changes to an open detached window',
);

const transpiledUiMode = ts.transpileModule(
  uiMode,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText.replaceAll('import.meta.client', 'false');
const uiModeRuntime = { exports: {} };
const headerWarningsRuntime = {};
Function('exports', ts.transpileModule(read('client/app/utils/headerWarnings.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(headerWarningsRuntime);
Function('exports', 'module', 'require', transpiledUiMode)(uiModeRuntime.exports, uiModeRuntime, (specifier) => {
  assert.equal(specifier, '../utils/headerWarnings');
  return headerWarningsRuntime;
});
assert.deepEqual(uiModeRuntime.exports.normalizeCartGridLayouts({
  attachedRegular: { rows: 0, columns: 17, minHeight: 1 },
  attachedShow: { minHeight: 1 },
  detachedRegular: { minHeight: 999 },
  detachedShow: { rows: '4', columns: '3', minHeight: 999 },
}), {
  attachedRegular: { rows: 1, columns: 16, minHeight: 64 },
  attachedShow: { rows: 8, columns: 2, minHeight: 72 },
  detachedRegular: { rows: 6, columns: 3, minHeight: 600 },
  detachedShow: { rows: 4, columns: 3, minHeight: 600 },
});
assert.match(
  projectSettingsModal,
  /onCartGridLayoutChange[\s\S]*input\.value\.trim\(\)[\s\S]*input\.value = String\(current\)[\s\S]*setCartGridLayout/,
  'an empty cart layout field must restore the current value instead of snapping to its minimum',
);
assert.match(
  oneShotTile,
  /class="one-shot-bottomline"[\s\S]{0,100}class="one-shot-actions"\s*>\s*<button\s+type="button"\s+class="one-shot-control one-shot-transport"[\s\S]{0,280}@click\.stop="handleTransport"/,
  'One Shots must use the same Play/Stop button in the bottom action strip in both modes',
);
assert.match(
  oneShotTile,
  /v-if="!showMode"[\s\S]*class="one-shot-control one-shot-remove"[\s\S]*v-if="removeOpen"/,
  'Show Mode must block One Shot removal while regular mode retains the confirmation control',
);
assert.match(
  oneShotPanel,
  /one-shot-header workspace-panel-header" :title="showMode \? undefined : t\('oneShots\.hint'\)"/,
  'QuickPlays import guidance must remain available in Edit Mode',
);
assert.match(
  oneShotPanel,
  /<button[\s\S]{0,160}v-else-if="!showMode"[\s\S]{0,240}class="one-shot-empty-cell"[\s\S]{0,240}:aria-label[\s\S]{0,180}@click="openImport\(index\)"/,
  'editable empty One Shot cells must be named keyboard buttons',
);
assert.match(
  oneShotPanel,
  /<div v-else class="one-shot-empty-cell show-mode" aria-hidden="true">/,
  'empty One Shot cells must stay inert in Show Mode',
);
assert.doesNotMatch(
  oneShotTile,
  /:aria-pressed="showMode \? isPlaying/,
  'the Show Mode One Shot action must not mix a changing Play/Stop name with toggle semantics',
);
assert.match(
  oneShotTile,
  /const handleDragStart[\s\S]{0,260}if \(showMode\.value \|\| !event\.dataTransfer\)[\s\S]{0,160}event\.preventDefault\(\)/,
  'One Shot drag behavior must follow the current Show Mode state',
);
assert.match(
  oneShotPanel,
  /const canMutate = computed\(\(\) => isDetached \? !!detachedIdentity\.value : projectHydrationStatus\.value === 'ready'\)/,
  'attached One Shot edits must wait for project hydration while detached edits require identity',
);
const oneShotDragOverStart = oneShotPanel.indexOf('const handleDragOver');
const oneShotDragOverEnd = oneShotPanel.indexOf(
  '\n};\n\nconst handleDragLeave', oneShotDragOverStart,
);
assert.ok(oneShotDragOverStart >= 0 && oneShotDragOverEnd > oneShotDragOverStart,
  'One Shots must define drag-over behavior');
const oneShotDragOver = oneShotPanel.slice(oneShotDragOverStart, oneShotDragOverEnd);
assert.match(
  oneShotDragOver,
  /if \(!canMutate\.value \|\| showMode\.value \|\| !currentProject\.value \|\| busySlot\.value !== null\) return;[\s\S]*dropEffect = event\.dataTransfer\.types\.includes\('one-shot-uuid'\) \? 'move' : 'copy'/,
  'One Shot drag feedback must be hydration-guarded and clearly distinguish move from copy',
);
assert.match(
  playlistItem,
  /const handleDragOver[\s\S]{0,300}if \(showMode\.value\)[\s\S]{0,160}dragPosition\.value = null[\s\S]{0,160}dropEffect = 'none'/,
  'Show Mode playlist rows must not paint edit-only drop markers',
);
assert.match(
  projectHeader,
  /\.silence-warning__seconds\s*\{[^}]*inline-size:\s*2ch;[^}]*font-variant-numeric:\s*tabular-nums;/,
  'the silence warning must reserve the same space for one or two digits',
);
assert.doesNotMatch(
  projectHeader,
  /\.silence-warning[^\n{]*\{[^}]*(?:animation(?:-[\w-]+)?|position)\s*:/,
  'the silence warning must stay in the header layout with a steady appearance',
);
assert.doesNotMatch(
  oneShotPanel,
  /class="slot-hint"/,
  'empty One Shot cells must not repeat obsolete cart loading copy',
);

assert.match(
  globalStyles,
  /--dialog-backdrop:[^;]+;[\s\S]*--dialog-surface:[^;]+;[\s\S]*--dialog-radius:[^;]+;[\s\S]*--dialog-shadow:[^;]+;/,
  'dialogs must share one backdrop, surface, corner, and elevation system',
);
for (const file of [
  'AudioImportModal.vue',
  'ConnectionLostModal.vue',
  'ServerFilePickerModal.vue',
].map(file => `client/app/components/${file}`)) {
  const dialog = read(file);
  for (const token of ['backdrop', 'surface', 'radius', 'shadow']) {
    assert.match(dialog, new RegExp(`var\\(--dialog-${token}\\)`),
      `${file} must use the shared dialog ${token}`);
  }
}
assert.doesNotMatch(
  audioImportModal
    + read('client/app/components/ServerFilePickerModal.vue')
    + read('client/app/components/ServerFileBrowser.vue'),
  /#(?:16161d|1a1a1a|1d1d1d|202020|202027|2a2a2a|353535)\b/i,
  'import and server dialogs must not bypass the app surface tokens',
);
// Escape is Stop All, and it must work while the operator is typing in the
// playlist search field. The field may bind Enter (next match) and Shift+Enter
// (previous match) and nothing else: it never binds, cancels or swallows Escape.
assert.doesNotMatch(
  read('client/app/components/PlaylistSearch.vue') + read('client/app/utils/playlistSearch.ts'),
  /(['"`])Esc(?:ape)?\1|(?:@|v-on:)key(?:down|up|press)(?!\.enter\.(?:shift\.)?exact\.prevent=)|keyCode|preventDefault|stop(?:Immediate)?Propagation|addEventListener/,
  'the playlist search must never bind Escape or stop a key from reaching Stop All',
);

checkSpotifyCopyTransaction()
  .then(() => console.log('Live safety checks passed.'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
