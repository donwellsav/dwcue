#include "liveplay/audio/decoder.hpp"

#include "video_only_fixture.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <numbers>
#include <string>
#include <vector>

namespace fs = std::filesystem;

struct test_case {
    fs::path path;
    // Video-only containers intentionally render as zeros (silent-video
    // transport); everything else must contain audible samples.
    bool expect_silence = false;
};

std::vector<test_case> self_test_files() {
    const auto directory = fs::temp_directory_path() / "liveplay-decoder-self-test";
    fs::remove_all(directory);
    fs::create_directories(directory);

    const std::vector<unsigned char> midi{
        'M', 'T', 'h', 'd', 0, 0, 0, 6, 0, 0, 0, 1, 0, 96,
        'M', 'T', 'r', 'k', 0, 0, 0, 15,
        0, 0xc0, 0, 0, 0x90, 60, 100, 96, 0x80, 60, 0, 0, 0xff, 0x2f, 0};
    std::ofstream rmi(directory / "note.rmi", std::ios::binary);
    const std::uint32_t riff_size = static_cast<std::uint32_t>(12 + midi.size());
    const std::uint32_t data_size = static_cast<std::uint32_t>(midi.size());
    rmi.write("RIFF", 4);
    rmi.write(reinterpret_cast<const char*>(&riff_size), 4);
    rmi.write("RMIDdata", 8);
    rmi.write(reinterpret_cast<const char*>(&data_size), 4);
    rmi.write(reinterpret_cast<const char*>(midi.data()), midi.size());
    rmi.close();

    std::ofstream bin(directory / "disc.bin", std::ios::binary);
    for (int frame = 0; frame < 44100; ++frame) {
        const auto sample = static_cast<std::int16_t>(
            std::sin(2.0 * std::numbers::pi * 440.0 * frame / 44100.0) * 12000.0);
        bin.write(reinterpret_cast<const char*>(&sample), sizeof(sample));
        bin.write(reinterpret_cast<const char*>(&sample), sizeof(sample));
    }
    bin.close();
    std::ofstream cue(directory / "disc.cue");
    cue << "FILE \"disc.bin\" BINARY\n"
           "  TRACK 01 AUDIO\n"
           "    INDEX 01 00:00:00\n";
    cue.close();

    std::ofstream mixed(directory / "mixed.bin", std::ios::binary);
    const std::vector<char> data_track(150 * 2352, 0);
    mixed.write(data_track.data(), data_track.size());
    std::ifstream audio_track(directory / "disc.bin", std::ios::binary);
    mixed << audio_track.rdbuf();
    mixed.close();
    std::ofstream mixed_cue(directory / "mixed.cue");
    mixed_cue << "FILE \"mixed.bin\" BINARY\n"
                 "  TRACK 01 MODE1/2352\n"
                 "    INDEX 01 00:00:00\n"
                 "  TRACK 02 AUDIO\n"
                 "    INDEX 01 00:02:00\n";
    mixed_cue.close();

    std::ofstream vid(directory / "video_only.mp4", std::ios::binary);
    vid.write(reinterpret_cast<const char*>(kVideoOnlyMp4), kVideoOnlyMp4Len);
    vid.close();
    return {{directory / "note.rmi"}, {directory / "disc.cue"},
            {directory / "mixed.cue"}, {directory / "video_only.mp4", true}};
}

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: decoder-check <audio-file> [...]\n";
        return 2;
    }

    const std::vector<test_case> self_tests =
        argc == 2 && std::string_view{argv[1]} == "--self-test"
            ? self_test_files() : std::vector<test_case>{};
    std::vector<test_case> files = self_tests;
    if (files.empty()) {
        for (int i = 1; i < argc; ++i) files.push_back({fs::path{argv[i]}, false});
    }

    int failures = 0;
    for (const auto& [path, expect_silence] : files) {
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
        const bool silence_ok = expect_silence ? !non_silent : non_silent;
        if ((read != MA_SUCCESS && read != MA_AT_END) || rendered == 0 || !silence_ok ||
            channels == 0 || sample_rate != 48000) {
            std::cerr << path << ": render failed (result=" << ma_result_description(read)
                      << ", frames=" << rendered << ", channels=" << channels
                      << ", sample-rate=" << sample_rate
                      << ", non-silent=" << non_silent << ")\n";
            ++failures;
        }

        if (expect_silence) {
            // Silent-video transport contract: the video stream flag is set,
            // the container duration drives EOF exactly, and the source is
            // seekable (the shared seek check below covers that part).
            if (!liveplay::audio::file_has_video_stream(path)) {
                std::cerr << path << ": video stream not detected\n";
                ++failures;
            }
            if (read != MA_AT_END) {
                std::cerr << path << ": did not stop at its container duration\n";
                ++failures;
            }
            ma_uint64 length = 0;
            if (ma_decoder_get_length_in_pcm_frames(&decoder, &length) != MA_SUCCESS ||
                length != 24000) {
                std::cerr << path << ": silent duration wrong (" << length
                          << " frames instead of 24000)\n";
                ++failures;
            }
        }

        if (ma_decoder_seek_to_pcm_frame(&decoder, 0) != MA_SUCCESS) {
            std::cerr << path << ": seek failed\n";
            ++failures;
        }

        std::string extension = path.extension().string();
        std::transform(extension.begin(), extension.end(), extension.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        const bool is_midi = extension == ".mid" || extension == ".midi" ||
                             extension == ".smf" || extension == ".kar" ||
                             extension == ".rmi";
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
            if (is_midi && total != length) {
                std::cerr << path << ": ended at " << total
                          << " frames instead of its declared " << length << " frames\n";
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
