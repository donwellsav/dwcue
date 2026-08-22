#pragma once

#include <miniaudio.h>

#include <filesystem>

namespace liveplay::audio {

ma_decoder_config decoder_config(ma_format format, ma_uint32 channels, ma_uint32 sample_rate);
ma_result decoder_init_file(const std::filesystem::path& path,
                            const ma_decoder_config& config,
                            ma_decoder& decoder);

// True when the container carries a real video stream (attached pictures —
// MP3/MP4 cover art — do not count). Best-effort probe: false on any error.
bool file_has_video_stream(const std::filesystem::path& path) noexcept;

} // namespace liveplay::audio
