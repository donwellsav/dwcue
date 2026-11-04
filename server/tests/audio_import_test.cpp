#include "liveplay/audio/decoder.hpp"
#include "liveplay/meta/waveform.hpp"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace {
int failures = 0;

void check(bool ok, const std::string& label) {
    std::cout << (ok ? "PASS " : "FAIL ") << label << std::endl;
    if (!ok) ++failures;
}

void check_seek(const fs::path& path, ma_uint32 output_rate) {
    const std::string label = path.filename().string() + " @" + std::to_string(output_rate);
    ma_decoder decoder{};
    const auto config = liveplay::audio::decoder_config(ma_format_f32, 0, output_rate);
    const bool opened = liveplay::audio::decoder_init_file(path, config, decoder) == MA_SUCCESS;
    check(opened, label + " opens");
    if (!opened) return;
    ma_uint32 channels = 0, rate = 0;
    ma_decoder_get_data_format(&decoder, nullptr, &channels, &rate, nullptr, 0);
    std::vector<float> sequential, chunk(4096 * channels);
    ma_result result = MA_SUCCESS;
    while (result == MA_SUCCESS && sequential.size() < rate * channels * 4ull) {
        ma_uint64 frames = 0;
        result = ma_decoder_read_pcm_frames(&decoder, chunk.data(), 4096, &frames);
        sequential.insert(sequential.end(), chunk.begin(), chunk.begin() + frames * channels);
    }
    check(result == MA_AT_END && sequential.size() >= rate * channels * 2ull,
          label + " reaches clean EOF");
    for (ma_uint64 target : {ma_uint64{0}, ma_uint64{rate / 2}, ma_uint64{rate},
                             ma_uint64{rate * 2 + rate / 2}}) {
        const bool sought = ma_decoder_seek_to_pcm_frame(&decoder, target) == MA_SUCCESS;
        ma_uint64 frames = 0;
        result = sought ? ma_decoder_read_pcm_frames(&decoder, chunk.data(), 4096, &frames)
                        : MA_BAD_SEEK;
        double max_error = 0.0;
        // The outer sample-rate converter starts with an empty filter history.
        // Compare after its first millisecond; onset is checked separately.
        const ma_uint64 warmup = output_rate == 0 ? 0 : rate / 1000;
        bool comparable = result == MA_SUCCESS && frames == 4096 &&
                          sequential.size() >= (target + frames) * channels;
        if (comparable) {
            for (ma_uint64 i = warmup * channels; i < frames * channels; ++i)
                max_error = std::max(max_error, static_cast<double>(std::fabs(
                    chunk[i] - sequential[target * channels + i])));
        }
        check(comparable && max_error < 0.001,
              label + " seek " + std::to_string(target) + " matches sequential PCM (error " +
                  std::to_string(max_error) + ")");
        std::size_t leading = 0;
        while (leading < frames * channels && std::fabs(chunk[leading]) < 1e-6f) ++leading;
        check(comparable && leading < rate * channels / 500,
              label + " seek has no inserted silence");
    }
    ma_decoder_uninit(&decoder);
    const auto waveform = liveplay::meta::compute_waveform(path, 16);
    check(waveform.ok, label + " complete compressed file is accepted");
}

void check_layout(const fs::path& path, ma_channel third, bool expect_loudness) {
    ma_decoder decoder{};
    const auto config = liveplay::audio::decoder_config(ma_format_f32, 0, 0);
    const bool opened = liveplay::audio::decoder_init_file(path, config, decoder) == MA_SUCCESS;
    check(opened, path.filename().string() + " opens");
    if (!opened) return;
    ma_channel map[3]{};
    ma_uint32 channels = 0;
    ma_decoder_get_data_format(&decoder, nullptr, &channels, nullptr, map, 3);
    check(channels == 3 && map[0] == MA_CHANNEL_FRONT_LEFT &&
              map[1] == MA_CHANNEL_FRONT_RIGHT && map[2] == third,
          path.filename().string() + " preserves source channel labels");
    ma_decoder_uninit(&decoder);
    const auto waveform = liveplay::meta::compute_waveform(path, 16);
    check(waveform.ok && waveform.integrated_lufs.has_value() == expect_loudness,
          path.filename().string() + " loudness excludes LFE and includes center");
    check(waveform.true_peak_dbtp && *waveform.true_peak_dbtp > -15.0,
          path.filename().string() + " source PCM remains present in true peak");
}

void check_native_channels(const fs::path& path, ma_uint32 channels) {
    for (ma_uint32 output_rate : {ma_uint32{0}, ma_uint32{44100}}) {
        const std::string label = path.filename().string() + " @" + std::to_string(output_rate);
        ma_decoder decoder{};
        const auto config = liveplay::audio::decoder_config(ma_format_f32, 0, output_rate);
        const bool opened = liveplay::audio::decoder_init_file(path, config, decoder) == MA_SUCCESS;
        check(opened, label + " opens");
        if (!opened) continue;
        ma_uint32 decoded_channels = 0, rate = 0;
        ma_decoder_get_data_format(&decoder, nullptr, &decoded_channels, &rate, nullptr, 0);
        check(decoded_channels == channels, label + " preserves channel count");
        std::vector<float> pcm(4096 * decoded_channels);
        ma_uint64 total = 0;
        ma_result result = MA_SUCCESS;
        double max_error = 0.0;
        while (result == MA_SUCCESS && total < rate * 4ull) {
            ma_uint64 frames = 0;
            result = ma_decoder_read_pcm_frames(&decoder, pcm.data(), 4096, &frames);
            for (ma_uint64 f = 0; f < frames; ++f) {
                if (total + f < 128) continue; // Resampler filter startup.
                for (ma_uint32 c = 0; c < decoded_channels; ++c)
                    max_error = std::max(max_error, std::fabs(
                        pcm[f * decoded_channels + c] - 0.01 * (c + 1)));
            }
            total += frames;
        }
        check(result == MA_AT_END && std::fabs(static_cast<double>(total) - rate * 3.0) < 32,
              label + " preserves duration");
        check(max_error < 1e-6, label + " preserves every channel's PCM (error " +
                  std::to_string(max_error) + ")");
        ma_decoder_uninit(&decoder);
    }
}

void check_seek_reuses_open_file(const fs::path& path) {
#if !defined(_WIN32)
    ma_decoder decoder{};
    const auto config = liveplay::audio::decoder_config(ma_format_f32, 0, 0);
    const bool opened = liveplay::audio::decoder_init_file(path, config, decoder) == MA_SUCCESS;
    check(opened, path.filename().string() + " repeated seek opens");
    if (!opened) return;
    ma_uint32 channels = 0;
    ma_decoder_get_data_format(&decoder, nullptr, &channels, nullptr, nullptr, 0);
    std::vector<float> pcm(256 * channels);
    const fs::path moved = path.string() + ".open";
    // A renamed PCM/lossless source stays seekable through its existing file handle.
    fs::rename(path, moved);
    bool ok = true;
    for (unsigned i = 0; i < 1000 && ok; ++i) {
        ma_uint64 frames = 0;
        ok = ma_decoder_seek_to_pcm_frame(&decoder, 256 + (i % 2) * 256) == MA_SUCCESS &&
             ma_decoder_read_pcm_frames(&decoder, pcm.data(), 256, &frames) == MA_SUCCESS &&
             frames == 256;
    }
    ma_decoder_uninit(&decoder);
    fs::rename(moved, path);
    check(ok, path.filename().string() + " 1000 seeks reuse the open file");
#endif
}
} // namespace

int main(int argc, char** argv) {
    if (argc != 2) return 2;
    const fs::path fixtures{argv[1]};
    for (const char* name : {"tone.mp3", "tone.m4a", "tone.flac", "tone.ogg", "tone.opus"}) {
        check_seek(fixtures / name, 0);
        check_seek(fixtures / name, 48000);
    }
    check_layout(fixtures / "lfe.wav", MA_CHANNEL_LFE, false);
    check_layout(fixtures / "center.wav", MA_CHANNEL_FRONT_CENTER, true);
    check_native_channels(fixtures / "channels-2.1.wav", 3);
    check_native_channels(fixtures / "channels-wide.wav", 8);
    check_native_channels(fixtures / "channels-hexa.wav", 16);
    check_seek_reuses_open_file(fixtures / "loop.wav");
    check_seek_reuses_open_file(fixtures / "aligned.flac");
    for (const char* name : {"truncated-frame.flac", "truncated-packet.flac",
                             "truncated-frame.xspf", "truncated-packet.xspf",
                             "truncated-aligned.flac", "truncated-aligned.xspf"}) {
        const auto waveform = liveplay::meta::compute_waveform(fixtures / name, 16);
        check(!waveform.ok && waveform.channels.empty() &&
                  !waveform.integrated_lufs && !waveform.true_peak_dbtp,
              std::string{name} + " rejects incomplete analysis");
    }
    check(liveplay::meta::compute_waveform(fixtures / "aligned.flac", 16).ok,
          "complete sample-aligned FLAC is accepted");
    check(liveplay::meta::compute_waveform(fixtures / "valid.xspf", 16).ok,
          "flat XML playlist still decodes");
    for (const char* extension : {"xspf", "asx", "wax", "wvx", "smil", "smi"}) {
        const fs::path path = fixtures / (std::string{"loop."} + extension);
        ma_decoder decoder{};
        const auto config = liveplay::audio::decoder_config(ma_format_f32, 0, 0);
        const ma_result result = liveplay::audio::decoder_init_file(path, config, decoder);
        check(result != MA_SUCCESS, path.filename().string() + " rejects recursive playlist");
        if (result == MA_SUCCESS) ma_decoder_uninit(&decoder);
    }
    return failures == 0 ? 0 : 1;
}
