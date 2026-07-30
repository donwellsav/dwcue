const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const section = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return source.slice(from, to);
};

const engine = read('server/src/audio/engine.cpp');
const callback = section(
  engine,
  'void AudioEngine::ma_data_callback',
  'DeviceId AudioEngine::open_default_device',
);
const renderLoop = section(
  engine,
  'void AudioEngine::render_loop()',
  'void AudioEngine::decode_loop()',
);
const decodeLoop = section(
  engine,
  'void AudioEngine::decode_loop()',
  'void AudioEngine::render_one_block',
);
const renderBlock = section(
  engine,
  'void AudioEngine::render_one_block',
  '} // namespace liveplay::audio',
);
const deviceReset = section(
  engine,
  'bool AudioEngine::reset_device_if_requested',
  '// Render loop — device-callback-driven',
);
const openDevice = section(
  engine,
  'DeviceId AudioEngine::open_device_by_name',
  'void AudioEngine::close_device',
);
const enumerateDevices = section(
  engine,
  'std::vector<DeviceInfo> AudioEngine::enumerate_devices',
  '// miniaudio data callback',
);

for (const [name, source] of [
  ['device callback', callback],
  ['render loop', renderLoop],
  ['render block', renderBlock],
]) {
  assert.doesNotMatch(source, /Logger::/, `${name} must not lock the logger`);
}
assert.match(callback, /underrun_count\.fetch_add/,
  'device callback must count underruns');
assert.match(callback, /underrun_frames\.fetch_add/,
  'device callback must count missing frames');
assert.match(callback, /clock_controller\.update/,
  'secondary-device callback must continuously track ring occupancy');
assert.match(callback, /ma_resampler_process_pcm_frames/,
  'secondary-device callback must correct drift by resampling');
assert.doesNotMatch(callback, /sleep_for|std::mutex|std::lock_guard/,
  'device callback must never wait');
assert.doesNotMatch(renderBlock, /std::vector|std::unordered_map|std::lock_guard/,
  'render block must not construct containers or take the engine mutex');
assert.doesNotMatch(renderBlock, /\.resize\(|\.assign\(/,
  'render block must not grow scratch storage');
assert.match(renderBlock, /overrun_count\.fetch_add/,
  'device dispatch must count a ring overrun instead of silently dropping');
assert.match(deviceReset, /ma_pcm_rb_reset/,
  'hard re-lock must explicitly reset stale device-ring state');
assert.match(renderLoop, /reset_device_if_requested\(\*clock_master\)/,
  'clock master must complete a pending reset before advancing the timeline');
assert.match(engine, /render_block \* 4\)/,
  'device output ring must remain four render blocks');
assert.match(engine, /notificationCallback\s*=\s*&AudioEngine::ma_notification_callback/,
  'device loss/reroute/interruption notifications must be wired');
assert.match(
  enumerateDevices,
  /ma_device_id_equal\([\s\S]*playback_infos\[i\]\.id/,
  'enumeration must follow the native output ID across default-device reroutes',
);
assert.ok(
  openDevice.indexOf('ma_device_init') <
    openDevice.indexOf('ma_device_id_equal'),
  'duplicate outputs must be compared by resolved native ID after device init',
);
assert.match(
  openDevice,
  /if \(!have_match\)[\s\S]*return \{\};/,
  'a missing named output must fail instead of leaking onto the default device',
);
assert.match(renderLoop, /ma_device_get_state/,
  'render loop must reconcile backends that omit stop notifications');
assert.match(renderLoop, /clock_master->clock_controller\.target_frames\(\)/,
  'clock-master occupancy must gate production without filling the ring');
assert.match(engine, /void AudioEngine::decode_loop\(\)[\s\S]*service_read_ahead\(1\)/,
  'one shared decode worker must service cue read-ahead');
assert.match(
  decodeLoop,
  /transport\s*==\s*TransportState::Stopped[\s\S]*transport\s*==\s*TransportState::Paused/,
  'idle stopped/paused cues must not block the shared decoder worker',
);

const controller = read(
  'server/include/liveplay/audio/device_clock_controller.hpp',
);
assert.match(controller, /kMaxCorrection\s*=\s*0\.005/,
  'continuous device correction must stay bounded to half a percent');
assert.doesNotMatch(controller, /throw|new\\s|std::vector/,
  'clock controller must remain allocation-free and noexcept');

const playback = read('server/src/audio/playback_item.cpp');
const playbackHeader = read('server/include/liveplay/audio/playback_item.hpp');
const itemRender = section(
  playback,
  'std::size_t PlaybackItem::render_block',
  'bool PlaybackItem::take_natural_end',
);
assert.doesNotMatch(
  itemRender,
  /ma_decoder_read_pcm_frames|ma_decoder_seek_to_pcm_frame|decoder_mutex_|Logger::/,
  'PlaybackItem render must not touch decoder/file/lock/logger paths',
);
assert.ok(
  itemRender.indexOf('stop_for_decode_error(decoder_result)') >= 0 &&
    itemRender.indexOf('stop_for_decode_error(decoder_result)') <
      itemRender.indexOf('if (natural_end) handle_natural_end()'),
  'decoder failures must stop before natural-end/follow handling',
);
assert.match(
  playback,
  /begin_render_exclusion\(\)[\s\S]*render_exclusion_\.test_and_set[\s\S]*render_exclusion_\.clear/,
  'control/render storage mutation must use one atomic exclusion gate',
);
assert.doesNotMatch(
  playback,
  /render_excluded_|render_active_/,
  'the racy two-flag render handshake must not return',
);
assert.match(
  playbackHeader,
  /std::atomic<ChannelCount>\s+file_channels_/,
  'source channel count must not race control-thread reloads',
);
assert.match(
  playback,
  /PlaybackItem::source_meter_consume[\s\S]*lock\{source_meters_mutex_\}/,
  'meter reads must hold the meter-vector lifetime lock',
);
assert.doesNotMatch(
  section(
    playback,
    'MeterSnapshot PlaybackItem::source_meter',
    'void PlaybackItem::play()',
  ),
  /decoder_mutex_/,
  'meter broadcasting must never wait on decoder/file I/O',
);
assert.match(
  section(playback, 'void PlaybackItem::play()', 'void PlaybackItem::stop()'),
  /clear_decode_error\(\)/,
  'a deliberate replay must discard the prior attempt error event',
);

const decoder = read('server/src/audio/decoder.cpp');
assert.match(
  section(decoder, 'int decode_next', 'ma_result on_read'),
  /read\s*==\s*AVERROR_EOF[\s\S]*source\.demux_eof\s*=\s*true[\s\S]*return read/,
  'FFmpeg must propagate demux I/O failures instead of reporting natural EOF',
);

const projectState = read('server/src/core/project_state.cpp');
assert.doesNotMatch(
  section(projectState, 'bool ProjectState::play_item', 'bool ProjectState::stop_item'),
  /\.detach\(\)|next_cue[\s\S]*prime\(/,
  'play must not launch a late next-cue primer that can seek live playback',
);

console.log('Audio real-time safety checks passed.');
