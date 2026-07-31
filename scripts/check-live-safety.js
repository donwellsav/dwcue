const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const pkg = JSON.parse(read('client/package.json'));
for (const target of pkg.build.mac.target) {
  assert.deepEqual(target.arch, ['arm64'], `macOS ${target.target} must be Apple Silicon-only`);
}
assert.equal(pkg.build.mac.sign, 'scripts/sign-mac.js',
  'macOS packaging must customize native-server signing before notarization');
assert.equal(pkg.build.afterSign, undefined,
  'macOS packaging must not invalidate notarization with an afterSign re-sign');
assert.doesNotMatch(
  read('.github/workflows/build-release.yml'),
  /x64-osx|macos-x64-build|macOS Intel/,
  'desktop releases must remain Apple Silicon-only on macOS',
);
assert.match(
  read('server/CMakeLists.txt'),
  /CMAKE_HOST_APPLE[\s\S]*CMAKE_OSX_DEPLOYMENT_TARGET "13\.3"/,
  'local Apple Silicon server builds must target macOS 13.3 or newer',
);
assert.match(
  read('server/triplets/arm64-osx-dwcue.cmake'),
  /VCPKG_TARGET_ARCHITECTURE arm64[\s\S]*VCPKG_OSX_DEPLOYMENT_TARGET 13\.3/,
  'bundled server dependencies must also target Apple Silicon and macOS 13.3',
);
assert.doesNotMatch(
  read('server/CMakeLists.txt'),
  /_LIBCPP_DISABLE_AVAILABILITY/,
  'macOS compatibility must not bypass libc++ symbol availability checks',
);
assert.doesNotMatch(
  JSON.stringify(pkg.build.dmg),
  /DW Cue Server\.app/,
  'the release DMG must not contain an unsigned standalone server app',
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
assert.match(engine, /render_block \* 4\)/, 'output ring must not add hundreds of milliseconds of latency');
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
  /const sameProject =[\s\S]*if \(!sameProject\)[\s\S]*hasUnsavedChanges\.value[\s\S]*sessionLost\.value = true[\s\S]*await tryRejoinExistingProject\(header\)/,
  'a reconnect to a different server project must rehydrate the client',
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
assert.match(
  welcome,
  /discovered-rescan[\s\S]*:aria-label="t\('welcome\.rescan'\)"/,
  'the icon-only server rescan control must have an explicit accessible name',
);
assert.match(
  welcome,
  /class="name-dialog"[\s\S]*role="dialog"[\s\S]*aria-modal="true"[\s\S]*:aria-labelledby/,
  'the new-project prompt must expose native dialog semantics',
);
const playlistItem = read('client/app/components/PlaylistItem.vue');
assert.match(
  playlistItem,
  /v-if="isPlaying && item\.type === 'audio'"[\s\S]{0,500}icon="restart_alt"[\s\S]{0,500}@click\.stop="handlePlay"[\s\S]{0,500}:aria-label="t\('actions\.restartCue', \{ name: item\.displayName \}\)"/,
  'the active-track restart control must reuse the normal Play path',
);
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

const projectState = read('server/src/core/project_state.cpp');
const atomicFile = read('server/include/liveplay/util/atomic_file.hpp');
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
const mainCpp = read('server/src/main.cpp');
assert.match(
  controlServer,
  /wait_for_server_start[\s\S]*if \(!impl_->app\.is_bound\(\)\)[\s\S]*return false/,
  'the server must confirm Crow actually bound before publishing startup success',
);
assert.match(
  controlServer,
  /if \(fs::equivalent\(it->path\(\), out_zip, equivalent_ec\)\s*&&\s*!equivalent_ec\)\s*\{\s*continue;\s*\}/m,
  'project exports must skip the archive file itself during zip creation',
);
assert.match(
  controlServer,
  /is_chunked_upload_staging_name\([\s\S]*is_export_staging_name\([\s\S]*continue;/,
  'project exports must skip upload and orphan export staging files',
);
assert.match(
  controlServer,
  /CROW_ROUTE\(app, "\/api\/upload\/start"\)[\s\S]*kChunkedUploadChunkBytes[\s\S]*CROW_ROUTE\(app, "\/api\/upload\/<string>"\)\.methods\(crow::HTTPMethod::Put\)[\s\S]*offset != session\.received_bytes[\s\S]*chunk_bytes >[\s\S]*session\.expected_bytes - session\.received_bytes/,
  'chunked uploads must advertise a bounded chunk and enforce sequential declared-size writes',
);
assert.match(
  controlServer,
  /out = tmp \/ \(download_token \+ "\.lpa"\);[\s\S]*download_token/,
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
  /out = tmp \/ \(download_token \+ "\.lpa"\);/,
  'temporary archive output must be token-named instead of projectName-derived',
);
assert.match(
  exportRoute,
  /const std::string default_name = safe_download_filename\(\s*j.value\("projectName"/,
  'projectName must only drive user-facing default filename, not filesystem paths',
);
assert.match(
  controlServer,
  /safe_download_filename[\s\S]*sanitize_upload_filename\(name \+ "\.lpa", "project\.lpa"\)/,
  'suggested archive filenames must preserve valid UTF-8 at the byte limit',
);
assert.match(
  exportRoute,
  /staged_out[\s\S]*zip_pack_directory\(src, staged_out, out\)[\s\S]*replace_file_atomically\(\s*staged_out, out/,
  'exports must stage completely before atomically replacing the destination',
);

const importRouteStart = controlServer.indexOf('CROW_ROUTE(app, "/api/project/import")');
const importRouteEnd = controlServer.indexOf('CROW_ROUTE(app, "/api/mixers")', importRouteStart);
const importRoute = controlServer.slice(importRouteStart, importRouteEnd);
assert.match(
  importRoute,
  /archive_path = tmp \/ \(make_download_token\(\) \+ "\.lpa"\);/,
  'multipart imports must stage to random-token temp paths',
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
  controlServer,
  /extract_archive_locked[\s\S]*g_media_import_mutex[\s\S]*zip_extract_to/,
  'archive imports must share the media snapshot lock with exports',
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
const updateModal = read('client/app/components/UpdateModal.vue');
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
  /type="file"[\s\S]*multiple[\s\S]*@change="uploadSelectedFiles"/,
  'remote audio import must use the browser file picker instead of whole-file IPC',
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
  /await pollPidfileForServerPid\(\s*lockPath, instanceToken, cfg\.localPort, launchState/,
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
assert.match(electron, /async function stopLiveplayServer\(\)[\s\S]*if \(liveplayServerStartPromise\) await liveplayServerStartPromise/, 'shutdown must wait for an in-flight launch');
assert.match(electron, /async function stopVerifiedLiveplayServer\([\s\S]*await terminateLiveplayPid\(/, 'normal shutdown must wait for verified termination');
assert.match(electron, /ipcMain\.handle\('app:confirm-quit', async[\s\S]*await stopLiveplayServer\(\)/, 'confirmed shutdown must finish before Electron exits');
assert.match(electron, /ipcMain\.handle\('liveplay-server:restart', async[\s\S]*await stopLiveplayServer\(\)[\s\S]*await startLiveplayServer\(\)/, 'restart must not overlap two servers');
assert.match(
  electron,
  /ipcMain\.handle\('install-update', async \(event\) =>[\s\S]*await cancelAllSpotifyDownloads\(true\)[\s\S]*quitAndInstall/,
  'installing an update must await active Spotify import cleanup before relaunch',
);
assert.match(
  electron,
  /app\.setPath\('userData', path\.join\(app\.getPath\('appData'\), 'LivePlay'\)\)/,
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
assert.match(
  electron,
  /ensure-running[\s\S]*healthMatchesIdentity\(health, lock\)/,
  'ensure-running must match the configured port health to the managed pidfile generation',
);
assert.match(
  electron,
  /read-binary-file-chunk[\s\S]*length > MAX_BINARY_CHUNK_BYTES[\s\S]*handle\.read/,
  'local archive IPC reads must enforce the server-sized chunk ceiling',
);
assert.match(
  electron,
  /download-archive-to-file[\s\S]*pipeline\([\s\S]*Readable\.fromWeb[\s\S]*fs\.promises\.rename/,
  'archive downloads must stream to a temp file before atomic replacement',
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
  /checkForManualUpdate|manual-update-available|tdoukinitsas\.github\.io\/liveplay\/package\.json/,
  'DonWells Cue must never install or advertise upstream LivePlay updates',
);
assert.doesNotMatch(
  updateModal,
  /isManualUpdate|downloadUrl|tdoukinitsas\.github\.io\/liveplay/,
  'the update UI must not fall back to upstream LivePlay downloads',
);
assert.match(
  electron,
  /DWCUE_UPDATES_CONFIGURED = false[\s\S]*Updates are not configured for this build/,
  'updates must fail closed until a branded release feed exists',
);
const readyStart = electron.indexOf('app.whenReady().then');
const readyEnd = electron.indexOf('\\n  });', readyStart);
const readyPath = electron.slice(readyStart, readyEnd);
assert.ok(
  readyPath.indexOf('createWindow();') >= 0 &&
  readyPath.indexOf('createWindow();') < readyPath.indexOf('void setupFfmpeg()'),
  'window creation must not wait for external FFmpeg probes',
);
assert.match(
  electron,
  /execFilePromise\(ffmpegPath, \['-version'\], \{ timeout: 5000 \}\)/,
  'bundled FFmpeg startup probes must have a hard timeout',
);
const spotifyUrlStart = electron.indexOf('function validatedSpotifyUrl');
const spotifyUrlEnd = electron.indexOf(
  '\n}\n\nfunction sendSpotifyProgress', spotifyUrlStart) + 2;
const validatedSpotifyUrl = Function(
  'requireIpcString',
  `return (${electron.slice(spotifyUrlStart, spotifyUrlEnd)})`,
)((value) => {
  if (typeof value !== 'string' || !value) throw new TypeError('invalid string');
  return value;
});
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
  /download-spotify-audio[\s\S]*requireAuthorizedIpcPath\([\s\S]*destinationParentPath[\s\S]*spawn\(spotDlPath, args/,
  'Spotify downloads must use trusted IPC and argv spawning',
);
assert.match(
  electron,
  /--save-file', 'dwcue-spotify-manifest\.spotdl'[\s\S]*spotifyManifestListName\([\s\S]*playlistName[\s\S]*projectFolderPath/,
  'Spotify imports must use the manifest list name and return their new project folder',
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
  /function cancelSpotifyDownload[\s\S]*process\.kill\(-child\.pid, 'SIGTERM'\)/,
  'playlist downloads must retain a cancellable child-process job',
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
  /await api\.selectProjectFolder\(\)[\s\S]*destinationParentPath[\s\S]*api\.downloadSpotifyAudio\([\s\S]*destinationParentPath/,
  'Spotify imports must let the operator choose the template parent folder',
);
assert.match(
  spotifyModal,
  /finalizeKeepFiles = keepFiles[\s\S]*if \(needsFinalize\)[\s\S]*finalizeSpotifyImport\(jobId, finalizeKeepFiles\)/,
  'a retry after ambiguous finalization must preserve the chosen media-retention policy',
);
assert.match(
  spotifyModal,
  /const projectFolderPath = props\.projectFolderPath[\s\S]*const projectEpoch = props\.projectEpoch[\s\S]*props\.projectFolderPath !== projectFolderPath[\s\S]*props\.projectEpoch !== projectEpoch/,
  'a Spotify job must stay bound to the project generation that started it',
);
const playlistView = read('client/app/components/PlaylistView.vue');
assert.match(
  playlistView,
  /v-if="canOnlineImport"[^>]*youtube[\s\S]*v-if="canOnlineImport"[^>]*spotifyImport[\s\S]*canOnlineImport = computed\(\(\) => !!currentProject\.value && server\.isLocalServer\)/,
  'online imports must only be shown for local projects',
);
assert.match(
  playlistView,
  /saveProject\(\{ signal \}\)[\s\S]*retainFiles: true/,
  'an ambiguous cue-save result must retain downloaded media',
);
assert.match(
  playlistView,
  /buildSpotifyCueSpecs[\s\S]*fetchMetadata\(serverPath, signal\)[\s\S]*fetchWaveformByPath\(serverPath\)[\s\S]*buildWaveformFromChannels[\s\S]*autoTrimSilenceOnImport === true[\s\S]*trimSilence\(cue\)[\s\S]*autoMatchLoudnessOnImport === true[\s\S]*applyLoudnessMatch\([\s\S]*anchorStartNextMarker/,
  'Spotify template cues must be metadata-named, show-ready, and only import-processed by explicit opt-ins',
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
  /async function saveProjectTo[\s\S]*AbortSignal\.any\(\[signal, AbortSignal\.timeout\(30000\)\]\)[\s\S]*async function fetchMetadata[\s\S]*AbortSignal\.any\(\[signal, AbortSignal\.timeout\(30000\)\]\)[\s\S]*async function copyToMedia[\s\S]*AbortSignal\.any\(\[signal, AbortSignal\.timeout\(30000\)\]\)/,
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
  '\n}\n\nfunction spotifyManifestListName', sanitizeNameStart) + 2;
const manifestNameStart = electron.indexOf('function spotifyManifestListName');
const manifestNameEnd = electron.indexOf(
  '\n}\n\nfunction spotDlNumericProgress', manifestNameStart) + 2;
const numericProgressStart = electron.indexOf('function spotDlNumericProgress');
const numericProgressEnd = electron.indexOf(
  '\n}\n\nasync function createSpotifyProjectFolder', numericProgressStart) + 2;
const createFolderStart = electron.indexOf('async function createSpotifyProjectFolder');
const createFolderEnd = electron.indexOf(
  '\n}\n\nfunction orderedSpotifyOutputs', createFolderStart) + 2;
const orderedOutputsStart = electron.indexOf('function orderedSpotifyOutputs');
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
const spotifyManifestListName = Function(
  'fs', `return (${electron.slice(manifestNameStart, manifestNameEnd)})`,
)(fs);
const spotDlNumericProgress = Function(
  `return (${electron.slice(numericProgressStart, numericProgressEnd)})`,
)();
const createSpotifyProjectFolder = Function(
  'fs', 'path', `return (${electron.slice(createFolderStart, createFolderEnd)})`,
)(fs, path);
const orderedSpotifyOutputs = Function(
  'fs', 'path', `return (${electron.slice(orderedOutputsStart, orderedOutputsEnd)})`,
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
assert.deepEqual(
  spotDlNumericProgress('INFO 2/5 complete'),
  { completed: 2, total: 5 },
  'spotDL 4.5.2 numeric progress must be parsed',
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
    fs.writeFileSync(path.join(staging, 'First.mp3'), 'first');
    fs.writeFileSync(path.join(staging, 'Second.mp3'), 'second');
    const manifest = path.join(staging, 'dwcue-spotify-manifest.spotdl');
    fs.writeFileSync(manifest, JSON.stringify([
      { list_name: 'The Exact Spotify List' },
      { list_name: 'The Exact Spotify List' },
    ]));
    assert.equal(
      spotifyManifestListName(manifest),
      'The Exact Spotify List',
      'the manifest must provide the exact Spotify collection name',
    );
    fs.writeFileSync(
      path.join(staging, 'dwcue-spotify-order.m3u8'),
      '#EXTM3U\nSecond.mp3\nSecond.mp3\nFirst.mp3\n',
    );
    fs.writeFileSync(path.join(media, 'Second.mp3'), 'existing');
    const job = {
      cancelled: false,
      files: [],
      abortController: new AbortController(),
    };
    const copied = await copySpotifyOutputsToMedia(
      orderedSpotifyOutputs(staging), media, job,
    );
    assert.deepEqual(
      copied.map((file) => path.basename(file)),
      ['Second (2).mp3', 'Second (3).mp3', 'First.mp3'],
      'Spotify batch order, duplicate entries, and existing media files must be preserved',
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
      copySpotifyOutputsToMedia([path.join(staging, 'First.mp3')], media, abortedJob),
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
assert.match(workspace, /downloadArchiveToFile\(result\.downloadToken, opts\.downloadTo\)/,
  'remote archive exports must bypass renderer memory');
assert.match(workspace, /catch \(e\)[\s\S]*server\.lastError = `Export failed:/,
  'archive export failures must be visible to the operator');
assert.match(
  workspace,
  /runExport[\s\S]*await saveProject\(\{ force: true \}\)[\s\S]*exportProjectArchive/,
  'project export must persist the authoritative document before zipping disk state',
);

const appVue = read('client/app/app.vue');
assert.match(
  appVue,
  /watch\(theme,[\s\S]*document\.documentElement\.dataset\.theme = value/,
  'the document root must carry the active theme so teleported dialogs inherit theme variables',
);
assert.match(
  appVue,
  /pendingArchiveClientPath[\s\S]*importProjectArchiveFromClientPath/,
  'remote archive imports must preserve a file path until chunked upload',
);
assert.match(
  appVue,
  /projectFiles\.length === 0[\s\S]*server\.lastError = 'Import failed:[\s\S]*catch \(e\)[\s\S]*server\.lastError = `Import failed:/,
  'archive import failures must be visible to the operator',
);

const macSigner = read('client/scripts/sign-mac.js');
assert.match(
  macSigner,
  /server-bin[\s\S]*dwcue-server[\s\S]*optionsForFile[\s\S]*entitlements: serverEntitlementsPath[\s\S]*signAsync/,
  'the bundled native server must receive its restricted entitlements during normal signing',
);

const spotifyImportModal = read('client/app/components/SpotifyImportModal.vue');
assert.match(
  spotifyImportModal,
  /class="icon-btn"[\s\S]*:aria-label="t\('actions\.close'\)"/,
  'the Spotify dialog close button must expose an accessible name',
);

const electronMain = read('client/electron/main.js');
assert.match(
  electronMain,
  /role: 'editMenu'/,
  'the desktop menu must preserve native text editing actions, including paste',
);

const cart = read('client/app/components/CartPlayer.vue');
assert.match(cart, /handleCartKeydown[\s\S]*showMode\.value[\s\S]*requestDeleteFromKeyboard/, 'Show Mode must block detached-cart deletion');

const serverSettings = read('client/app/components/ServerSettingsModal.vue');
assert.match(serverSettings,
  /v-if="d\.is_open"[\s\S]*server\.closeDevice\(d\.id\)[\s\S]*v-else[\s\S]*server\.openDevice/,
  'device settings must close an open instance instead of opening a duplicate');

checkSpotifyCopyTransaction()
  .then(() => console.log('Live safety checks passed.'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
