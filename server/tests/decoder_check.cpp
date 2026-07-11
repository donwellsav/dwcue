#include "liveplay/audio/decoder.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <filesystem>
#include <iostream>
#include <string>
#include <vector>

namespace fs = std::filesystem;

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: decoder-check <audio-file> [...]\n";
        return 2;
    }

    int failures = 0;
    for (int i = 1; i < argc; ++i) {
        const fs::path path{argv[i]};
        std::size_t before_count = 0;
        for (const auto& entry : fs::directory_iterator{path.parent_path()}) {
            if (entry.is_regular_file()) ++before_count;
        }
        const auto config = liveplay::audio::decoder_config(ma_format_f32, 0, 48000);
        ma_decoder decoder{};
        const ma_result opened = liveplay::audio::decoder_init_file(path, config, decoder);
        if (opened != MA_SUCCESS) {
            std::cerr << path << ": open failed\n";
            ++failures;
            continue;
        }

        ma_uint32 channels = 0;
        ma_uint32 sample_rate = 0;
        ma_decoder_get_data_format(&decoder, nullptr, &channels, &sample_rate, nullptr, 0);
        std::vector<float> pcm(4096 * std::max<ma_uint32>(channels, 1));
        ma_uint64 rendered = 0;
        ma_result read = MA_SUCCESS;
        bool non_silent = false;
        while (rendered < 96000 && read == MA_SUCCESS && !non_silent) {
            ma_uint64 frames = 0;
            read = ma_decoder_read_pcm_frames(&decoder, pcm.data(), 4096, &frames);
            rendered += frames;
            non_silent = std::any_of(pcm.begin(), pcm.begin() + frames * channels,
                                     [](float sample) { return std::fabs(sample) > 0.0001f; });
        }
        if ((read != MA_SUCCESS && read != MA_AT_END) || rendered == 0 || !non_silent ||
            channels == 0 || sample_rate != 48000) {
            std::cerr << path << ": render failed (result=" << ma_result_description(read)
                      << ", frames=" << rendered << ", channels=" << channels
                      << ", sample-rate=" << sample_rate
                      << ", non-silent=" << non_silent << ")\n";
            ++failures;
        }

        if (ma_decoder_seek_to_pcm_frame(&decoder, 0) != MA_SUCCESS) {
            std::cerr << path << ": seek failed\n";
            ++failures;
        }

        std::string extension = path.extension().string();
        std::transform(extension.begin(), extension.end(), extension.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        const bool is_midi = extension == ".mid" || extension == ".midi" ||
                             extension == ".smf" || extension == ".kar";
        const bool is_playlist = extension == ".m3u" || extension == ".m3u8" ||
                                 extension == ".pls" || extension == ".ram" ||
                                 extension == ".cue" || extension == ".xspf" ||
                                 extension == ".asx" || extension == ".wax" ||
                                 extension == ".wvx" || extension == ".smil" ||
                                 extension == ".smi";
        if (is_midi || is_playlist) {
            ma_uint64 length = 0;
            if (ma_decoder_get_length_in_pcm_frames(&decoder, &length) != MA_SUCCESS ||
                length == 0) {
                std::cerr << path << ": duration unavailable\n";
                ++failures;
            }
            ma_uint64 total = 0;
            ma_result result = MA_SUCCESS;
            while (result == MA_SUCCESS && total < 48000 * 300) {
                ma_uint64 frames = 0;
                result = ma_decoder_read_pcm_frames(&decoder, pcm.data(), 4096, &frames);
                total += frames;
            }
            if (result != MA_AT_END) {
                std::cerr << path << ": did not reach its natural end\n";
                ++failures;
            }
        }
        ma_decoder_uninit(&decoder);

        std::size_t file_count = 0;
        for (const auto& entry : fs::directory_iterator{path.parent_path()}) {
            if (entry.is_regular_file()) ++file_count;
        }
        if (file_count != before_count) {
            std::cerr << path << ": decoder created a file\n";
            ++failures;
        }
    }
    return failures == 0 ? 0 : 1;
}
