#include "liveplay/audio/decoder.hpp"
#include "liveplay/util/unicode_path.hpp"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavcodec/codec_desc.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/error.h>
#include <libavutil/samplefmt.h>
#include <libswresample/swresample.h>
}

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <limits>
#include <new>
#include <string>
#include <string_view>
#include <vector>

namespace liveplay::audio {
namespace {

// Only the chosen audio stream is decoded: let the demuxer skip every other
// stream's packets (for a video cue, the whole video bitstream) instead of
// reading them from disk and throwing them away.
void discard_other_streams(AVFormatContext* format, int keep) {
    if (!format) return;
    for (unsigned i = 0; i < format->nb_streams; ++i)
        format->streams[i]->discard = static_cast<int>(i) == keep ? AVDISCARD_DEFAULT : AVDISCARD_ALL;
}


using namespace std::string_view_literals;

std::uint32_t read_be32(const std::uint8_t* data) {
    return (static_cast<std::uint32_t>(data[0]) << 24) |
           (static_cast<std::uint32_t>(data[1]) << 16) |
           (static_cast<std::uint32_t>(data[2]) << 8) | data[3];
}

std::uint32_t read_le32(const std::uint8_t* data) {
    return static_cast<std::uint32_t>(data[0]) |
           (static_cast<std::uint32_t>(data[1]) << 8) |
           (static_cast<std::uint32_t>(data[2]) << 16) |
           (static_cast<std::uint32_t>(data[3]) << 24);
}

// Shared by the fixed stereo / 48 kHz float sources (playlist, silent video).
ma_result stereo_48k_on_get_format(ma_data_source*, ma_format* format, ma_uint32* channels,
                                   ma_uint32* sample_rate, ma_channel* channel_map,
                                   size_t channel_map_capacity) {
    if (format) *format = ma_format_f32;
    if (channels) *channels = 2;
    if (sample_rate) *sample_rate = 48000;
    if (channel_map && channel_map_capacity > 0) {
        ma_channel_map_init_standard(ma_standard_channel_map_default, channel_map,
                                     std::min<std::size_t>(2, channel_map_capacity), 2);
    }
    return MA_SUCCESS;
}

std::string trim(std::string value) {
    const auto first = value.find_first_not_of(" \t\r\n");
    if (first == std::string::npos) return {};
    const auto last = value.find_last_not_of(" \t\r\n");
    return value.substr(first, last - first + 1);
}

std::filesystem::path playlist_path(const std::filesystem::path& playlist,
                                    std::string value) {
    value = trim(std::move(value));
    if (value.size() >= 2 && value.front() == '"' && value.back() == '"') {
        value = value.substr(1, value.size() - 2);
    }
    if (value.starts_with("file://")) value.erase(0, 7);
    for (std::size_t position = 0; (position = value.find('%', position)) != std::string::npos;) {
        if (position + 2 >= value.size()) break;
        const auto hex = value.substr(position + 1, 2);
        char* end = nullptr;
        const long decoded = std::strtol(hex.c_str(), &end, 16);
        if (end && *end == '\0') value.replace(position, 3, 1, static_cast<char>(decoded));
        ++position;
    }
    auto path = util::utf8_to_path(value);
    if (path.is_relative()) path = playlist.parent_path() / path;
    return path.lexically_normal();
}

constexpr ma_uint64 cdda_frames_per_sector = 588;
constexpr ma_uint64 cdda_bytes_per_frame = 4;

struct CueTrack {
    std::filesystem::path file;
    bool binary = false;
    bool audio = false;
    bool has_index = false;
    ma_uint64 sector = 0;
};

struct CddaSegment {
    std::filesystem::path file;
    ma_uint64 start = 0;
    ma_uint64 length = 0;
};

bool cue_sector(std::string_view value, ma_uint64& sector) {
    unsigned minutes = 0;
    unsigned seconds = 0;
    unsigned frames = 0;
    if (std::sscanf(std::string{value}.c_str(), "%u:%u:%u", &minutes, &seconds, &frames) != 3 ||
        seconds >= 60 || frames >= 75) return false;
    sector = (static_cast<ma_uint64>(minutes) * 60 + seconds) * 75 + frames;
    return true;
}

std::vector<CddaSegment> parse_cdda_cue(const std::filesystem::path& cue) {
    std::ifstream input(cue);
    if (!input) return {};
    std::vector<CueTrack> tracks;
    std::filesystem::path current_file;
    bool current_binary = false;
    std::string line;
    while (std::getline(input, line)) {
        line = trim(std::move(line));
        std::string lower = line;
        std::transform(lower.begin(), lower.end(), lower.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        if (lower.starts_with("file ")) {
            std::string value = line.substr(5);
            std::string type;
            if (value.starts_with('"')) {
                const auto quote = value.find('"', 1);
                if (quote == std::string::npos) continue;
                type = trim(value.substr(quote + 1));
                value.resize(quote + 1);
            } else if (const auto space = value.find(' '); space != std::string::npos) {
                type = trim(value.substr(space + 1));
                value.resize(space);
            }
            std::transform(type.begin(), type.end(), type.begin(),
                           [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            current_file = playlist_path(cue, std::move(value));
            current_binary = type == "binary";
        } else if (lower.starts_with("track ") && !current_file.empty()) {
            tracks.push_back({current_file, current_binary,
                              lower.find(" audio") != std::string::npos, false, 0});
        } else if (lower.starts_with("index 01 ") && !tracks.empty()) {
            tracks.back().has_index = cue_sector(line.substr(9), tracks.back().sector);
        }
    }

    std::vector<CddaSegment> segments;
    for (std::size_t index = 0; index < tracks.size(); ++index) {
        const auto& track = tracks[index];
        if (!track.binary || !track.audio || !track.has_index) continue;
        std::error_code error;
        const ma_uint64 file_bytes = std::filesystem::file_size(track.file, error);
        if (error) continue;
        ma_uint64 end_sector = file_bytes / (cdda_frames_per_sector * cdda_bytes_per_frame);
        for (std::size_t next = index + 1; next < tracks.size(); ++next) {
            if (tracks[next].file != track.file) break;
            if (tracks[next].has_index) {
                end_sector = tracks[next].sector;
                break;
            }
        }
        if (track.sector >= end_sector) continue;
        segments.push_back({track.file, track.sector * cdda_frames_per_sector,
                            (end_sector - track.sector) * cdda_frames_per_sector});
    }
    return segments;
}

struct CddaDataSource {
    ma_data_source_base base{};
    std::vector<CddaSegment> segments;
    std::size_t index = 0;
    ma_uint64 segment_cursor = 0;
    ma_uint64 cursor = 0;
    ma_uint64 length = 0;
    std::ifstream file;
    std::vector<std::uint8_t> bytes;
    std::vector<float> scratch;
};

bool open_cdda_segment(CddaDataSource& source) {
    source.file.close();
    if (source.index >= source.segments.size()) return false;
    source.file.open(source.segments[source.index].file, std::ios::binary);
    if (!source.file) return false;
    const ma_uint64 frame = source.segments[source.index].start + source.segment_cursor;
    if (frame > static_cast<ma_uint64>(std::numeric_limits<std::streamoff>::max()) /
                    cdda_bytes_per_frame) return false;
    source.file.seekg(static_cast<std::streamoff>(frame * cdda_bytes_per_frame));
    return static_cast<bool>(source.file);
}

ma_result cdda_on_read(ma_data_source* data_source, void* output,
                       ma_uint64 frame_count, ma_uint64* frames_read) {
    auto& source = *reinterpret_cast<CddaDataSource*>(data_source);
    float* pcm = static_cast<float*>(output);
    if (!pcm) {
        source.scratch.resize(static_cast<std::size_t>(frame_count) * 2);
        pcm = source.scratch.data();
    }
    ma_uint64 total = 0;
    while (total < frame_count && source.index < source.segments.size()) {
        const auto& segment = source.segments[source.index];
        if (source.segment_cursor >= segment.length) {
            ++source.index;
            source.segment_cursor = 0;
            if (source.index < source.segments.size() && !open_cdda_segment(source)) break;
            continue;
        }
        const ma_uint64 count = std::min<ma_uint64>(
            {frame_count - total, segment.length - source.segment_cursor, 16384});
        source.bytes.resize(static_cast<std::size_t>(count * cdda_bytes_per_frame));
        source.file.read(reinterpret_cast<char*>(source.bytes.data()),
                         static_cast<std::streamsize>(source.bytes.size()));
        const ma_uint64 read = static_cast<ma_uint64>(source.file.gcount()) /
                               cdda_bytes_per_frame;
        for (ma_uint64 frame = 0; frame < read; ++frame) {
            for (ma_uint64 channel = 0; channel < 2; ++channel) {
                const std::size_t byte = static_cast<std::size_t>(frame * 4 + channel * 2);
                const std::uint16_t bits = static_cast<std::uint16_t>(source.bytes[byte]) |
                    (static_cast<std::uint16_t>(source.bytes[byte + 1]) << 8);
                pcm[(total + frame) * 2 + channel] =
                    static_cast<float>(static_cast<std::int16_t>(bits)) / 32768.0f;
            }
        }
        source.segment_cursor += read;
        source.cursor += read;
        total += read;
        if (read < count) source.segment_cursor = segment.length;
    }
    if (frames_read) *frames_read = total;
    return total == 0 ? MA_AT_END : MA_SUCCESS;
}

ma_result cdda_on_seek(ma_data_source* data_source, ma_uint64 frame_index) {
    auto& source = *reinterpret_cast<CddaDataSource*>(data_source);
    if (frame_index > source.length) return MA_BAD_SEEK;
    ma_uint64 offset = frame_index;
    source.index = 0;
    while (source.index < source.segments.size() &&
           offset >= source.segments[source.index].length) {
        offset -= source.segments[source.index++].length;
    }
    source.cursor = frame_index;
    source.segment_cursor = offset;
    source.file.close();
    if (source.index == source.segments.size()) return MA_SUCCESS;
    return open_cdda_segment(source) ? MA_SUCCESS : MA_BAD_SEEK;
}

ma_result cdda_on_get_format(ma_data_source*, ma_format* format, ma_uint32* channels,
                             ma_uint32* sample_rate, ma_channel* channel_map,
                             size_t channel_map_capacity) {
    if (format) *format = ma_format_f32;
    if (channels) *channels = 2;
    if (sample_rate) *sample_rate = 44100;
    if (channel_map && channel_map_capacity > 0) {
        ma_channel_map_init_standard(ma_standard_channel_map_default, channel_map,
                                     std::min<std::size_t>(2, channel_map_capacity), 2);
    }
    return MA_SUCCESS;
}

ma_result cdda_on_get_cursor(ma_data_source* data_source, ma_uint64* cursor) {
    if (!cursor) return MA_INVALID_ARGS;
    *cursor = reinterpret_cast<CddaDataSource*>(data_source)->cursor;
    return MA_SUCCESS;
}

ma_result cdda_on_get_length(ma_data_source* data_source, ma_uint64* length) {
    if (!length) return MA_INVALID_ARGS;
    *length = reinterpret_cast<CddaDataSource*>(data_source)->length;
    return MA_SUCCESS;
}

ma_data_source_vtable cdda_data_source_vtable{
    cdda_on_read, cdda_on_seek, cdda_on_get_format, cdda_on_get_cursor,
    cdda_on_get_length, nullptr, 0};

ma_result open_cdda(const std::filesystem::path& path, ma_data_source** backend) {
    std::string extension = path.extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (extension != ".cue") return MA_NO_BACKEND;
    auto segments = parse_cdda_cue(path);
    if (segments.empty()) return MA_NO_BACKEND;
    auto* source = new (std::nothrow) CddaDataSource{};
    if (!source) return MA_OUT_OF_MEMORY;
    source->segments = std::move(segments);
    for (const auto& segment : source->segments) {
        if (segment.length > std::numeric_limits<ma_uint64>::max() - source->length) {
            delete source;
            return MA_INVALID_FILE;
        }
        source->length += segment.length;
    }
    if (!open_cdda_segment(*source)) {
        delete source;
        return MA_IO_ERROR;
    }
    ma_data_source_config config = ma_data_source_config_init();
    config.vtable = &cdda_data_source_vtable;
    const ma_result result = ma_data_source_init(&config, &source->base);
    if (result != MA_SUCCESS) {
        delete source;
        return result;
    }
    *backend = source;
    return MA_SUCCESS;
}

ma_result cdda_backend_init_file(void*, const char* path,
                                 const ma_decoding_backend_config*,
                                 const ma_allocation_callbacks*, ma_data_source** backend) {
    if (!path) return MA_INVALID_ARGS;
    return open_cdda(std::filesystem::path{path}, backend);
}

ma_result cdda_backend_init_file_w(void*, const wchar_t* path,
                                   const ma_decoding_backend_config*,
                                   const ma_allocation_callbacks*, ma_data_source** backend) {
    if (!path) return MA_INVALID_ARGS;
    return open_cdda(std::filesystem::path{path}, backend);
}

void cdda_backend_uninit(void*, ma_data_source* backend,
                         const ma_allocation_callbacks*) {
    if (!backend) return;
    auto* source = reinterpret_cast<CddaDataSource*>(backend);
    ma_data_source_uninit(&source->base);
    delete source;
}

std::vector<std::filesystem::path> parse_playlist(const std::filesystem::path& path) {
    std::ifstream input(path);
    if (!input) return {};
    std::string extension = path.extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    std::vector<std::filesystem::path> files;
    auto add = [&](std::string value) {
        for (auto entity = value.find("&amp;"); entity != std::string::npos;
             entity = value.find("&amp;", entity + 1)) {
            value.replace(entity, 5, "&");
        }
        const auto resolved = playlist_path(path, std::move(value));
        std::string resolved_extension = resolved.extension().string();
        std::transform(resolved_extension.begin(), resolved_extension.end(),
                       resolved_extension.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        if (resolved_extension == ".m3u" || resolved_extension == ".m3u8" ||
            resolved_extension == ".pls" || resolved_extension == ".ram" ||
            resolved_extension == ".cue" || resolved_extension == ".xspf" ||
            resolved_extension == ".asx" || resolved_extension == ".wax" ||
            resolved_extension == ".wvx" || resolved_extension == ".smil" ||
            resolved_extension == ".smi") return;
        if (!resolved.empty() &&
            (files.empty() || files.back() != resolved)) files.push_back(resolved);
    };

    if (extension == ".xspf" || extension == ".asx" || extension == ".wax" ||
        extension == ".wvx" || extension == ".smil" || extension == ".smi") {
        const std::string content{std::istreambuf_iterator<char>{input}, {}};
        std::string lower = content;
        std::transform(lower.begin(), lower.end(), lower.begin(),
                       [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        if (extension == ".xspf") {
            std::size_t position = 0;
            while ((position = lower.find("<location>", position)) != std::string::npos) {
                position += 10;
                const auto end = lower.find("</location>", position);
                if (end == std::string::npos) break;
                add(content.substr(position, end - position));
                position = end + 11;
            }
        } else {
            const std::string_view attribute =
                (extension == ".asx" || extension == ".wax" || extension == ".wvx")
                    ? "href="sv : "src="sv;
            std::size_t position = 0;
            while ((position = lower.find(attribute, position)) != std::string::npos) {
                position += attribute.size();
                while (position < content.size() && std::isspace(
                           static_cast<unsigned char>(content[position]))) ++position;
                if (position >= content.size() ||
                    (content[position] != '"' && content[position] != '\'')) continue;
                const char quote = content[position++];
                const auto end = content.find(quote, position);
                if (end == std::string::npos) break;
                add(content.substr(position, end - position));
                position = end + 1;
            }
        }
        return files;
    }

    std::string line;
    while (std::getline(input, line)) {
        line = trim(std::move(line));
        if (line.empty() || line.starts_with('#') || line.starts_with(';')) continue;

        std::string value;
        if (extension == ".pls") {
            std::string lower = line;
            std::transform(lower.begin(), lower.end(), lower.begin(),
                           [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            if (!lower.starts_with("file")) continue;
            const auto equal = line.find('=');
            if (equal == std::string::npos) continue;
            value = line.substr(equal + 1);
        } else if (extension == ".cue") {
            std::string lower = line;
            std::transform(lower.begin(), lower.end(), lower.begin(),
                           [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            if (!lower.starts_with("file ")) continue;
            value = line.substr(5);
            if (value.starts_with('"')) {
                const auto quote = value.find('"', 1);
                if (quote != std::string::npos) value.resize(quote + 1);
            } else if (const auto space = value.find(' '); space != std::string::npos) {
                value.resize(space);
            }
        } else {
            value = line;
        }

        add(std::move(value));
    }
    return files;
}

struct PlaylistDataSource {
    ma_data_source_base base{};
    std::vector<std::filesystem::path> files;
    std::vector<ma_uint64> lengths;
    std::size_t index = 0;
    ma_decoder decoder{};
    bool decoder_ready = false;
    ma_uint64 cursor = 0;
    ma_uint64 length = 0;
    std::vector<float> scratch;
};

void close_playlist_decoder(PlaylistDataSource& source) {
    if (source.decoder_ready) ma_decoder_uninit(&source.decoder);
    source.decoder = {};
    source.decoder_ready = false;
}

bool open_playlist_entry(PlaylistDataSource& source) {
    close_playlist_decoder(source);
    while (source.index < source.files.size()) {
        const auto config = decoder_config(ma_format_f32, 2, 48000);
        if (decoder_init_file(source.files[source.index], config, source.decoder) == MA_SUCCESS) {
            source.decoder_ready = true;
            return true;
        }
        ++source.index;
    }
    return false;
}

ma_result playlist_on_read(ma_data_source* data_source, void* output,
                           ma_uint64 frame_count, ma_uint64* frames_read) {
    auto& source = *reinterpret_cast<PlaylistDataSource*>(data_source);
    float* pcm = static_cast<float*>(output);
    if (!pcm) {
        source.scratch.resize(static_cast<std::size_t>(frame_count) * 2);
        pcm = source.scratch.data();
    }
    ma_uint64 total = 0;
    while (total < frame_count && source.decoder_ready) {
        ma_uint64 rendered = 0;
        const ma_result result = ma_decoder_read_pcm_frames(
            &source.decoder, pcm + total * 2, frame_count - total, &rendered);
        total += rendered;
        source.cursor += rendered;
        if (result != MA_SUCCESS && result != MA_AT_END) {
            if (frames_read) *frames_read = total;
            return result;
        }
        if (result == MA_AT_END || rendered == 0) {
            ++source.index;
            open_playlist_entry(source);
        }
    }
    if (frames_read) *frames_read = total;
    return total == 0 ? MA_AT_END : MA_SUCCESS;
}

ma_result playlist_on_seek(ma_data_source* data_source, ma_uint64 frame_index) {
    auto& source = *reinterpret_cast<PlaylistDataSource*>(data_source);
    if (source.length == 0 || frame_index > source.length) return MA_BAD_SEEK;
    ma_uint64 offset = frame_index;
    std::size_t index = 0;
    while (index < source.lengths.size() && offset >= source.lengths[index]) {
        offset -= source.lengths[index++];
    }
    if (index >= source.files.size()) {
        index = source.files.size() - 1;
        offset = source.lengths[index];
    }
    source.index = index;
    if (!open_playlist_entry(source) ||
        ma_decoder_seek_to_pcm_frame(&source.decoder, offset) != MA_SUCCESS) {
        return MA_BAD_SEEK;
    }
    source.cursor = frame_index;
    return MA_SUCCESS;
}

ma_result playlist_on_get_format(ma_data_source*, ma_format* format, ma_uint32* channels,
                                 ma_uint32* sample_rate, ma_channel* channel_map,
                                 size_t channel_map_capacity) {
    return stereo_48k_on_get_format(nullptr, format, channels, sample_rate,
                                    channel_map, channel_map_capacity);
}

ma_result playlist_on_get_cursor(ma_data_source* data_source, ma_uint64* cursor) {
    if (!cursor) return MA_INVALID_ARGS;
    *cursor = reinterpret_cast<PlaylistDataSource*>(data_source)->cursor;
    return MA_SUCCESS;
}

ma_result playlist_on_get_length(ma_data_source* data_source, ma_uint64* length) {
    if (!length) return MA_INVALID_ARGS;
    *length = reinterpret_cast<PlaylistDataSource*>(data_source)->length;
    return *length == 0 ? MA_NOT_IMPLEMENTED : MA_SUCCESS;
}

ma_data_source_vtable playlist_data_source_vtable{
    playlist_on_read, playlist_on_seek, playlist_on_get_format,
    playlist_on_get_cursor, playlist_on_get_length, nullptr, 0};

ma_result open_playlist(const std::filesystem::path& path, ma_data_source** backend) {
    std::string extension = path.extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (extension != ".m3u" && extension != ".m3u8" && extension != ".pls" &&
        extension != ".ram" && extension != ".cue" && extension != ".xspf" &&
        extension != ".asx" && extension != ".wax" && extension != ".wvx" &&
        extension != ".smil" && extension != ".smi") return MA_NO_BACKEND;

    auto* source = new (std::nothrow) PlaylistDataSource{};
    if (!source) return MA_OUT_OF_MEMORY;
    source->files = parse_playlist(path);
    if (source->files.empty()) {
        delete source;
        return MA_INVALID_FILE;
    }

    bool lengths_known = true;
    for (const auto& file : source->files) {
        ma_decoder decoder{};
        const auto config = decoder_config(ma_format_f32, 2, 48000);
        ma_uint64 length = 0;
        const bool opened = decoder_init_file(file, config, decoder) == MA_SUCCESS;
        if (!opened || ma_decoder_get_length_in_pcm_frames(&decoder, &length) != MA_SUCCESS ||
            length == 0) {
            lengths_known = false;
            length = 0;
        }
        if (opened) ma_decoder_uninit(&decoder);
        source->lengths.push_back(length);
        if (length > std::numeric_limits<ma_uint64>::max() - source->length) {
            lengths_known = false;
        } else {
            source->length += length;
        }
    }
    if (!lengths_known) source->length = 0;
    if (!open_playlist_entry(*source)) {
        delete source;
        return MA_INVALID_FILE;
    }

    ma_data_source_config config = ma_data_source_config_init();
    config.vtable = &playlist_data_source_vtable;
    const ma_result result = ma_data_source_init(&config, &source->base);
    if (result != MA_SUCCESS) {
        close_playlist_decoder(*source);
        delete source;
        return result;
    }
    *backend = source;
    return MA_SUCCESS;
}

ma_result playlist_backend_init_file(void*, const char* path,
                                     const ma_decoding_backend_config*,
                                     const ma_allocation_callbacks*, ma_data_source** backend) {
    if (!path) return MA_INVALID_ARGS;
    return open_playlist(std::filesystem::path{path}, backend);
}

ma_result playlist_backend_init_file_w(void*, const wchar_t* path,
                                       const ma_decoding_backend_config*,
                                       const ma_allocation_callbacks*, ma_data_source** backend) {
    if (!path) return MA_INVALID_ARGS;
    return open_playlist(std::filesystem::path{path}, backend);
}

void playlist_backend_uninit(void*, ma_data_source* backend,
                             const ma_allocation_callbacks*) {
    if (!backend) return;
    auto* source = reinterpret_cast<PlaylistDataSource*>(backend);
    ma_data_source_uninit(&source->base);
    close_playlist_decoder(*source);
    delete source;
}

struct FfmpegDataSource {
    ma_data_source_base base{};
    AVFormatContext* format = nullptr;
    AVCodecContext* codec = nullptr;
    SwrContext* resampler = nullptr;
    AVPacket* packet = nullptr;
    AVFrame* frame = nullptr;
    int stream_index = -1;
    ma_uint32 channels = 0;
    ma_uint32 sample_rate = 0;
    ma_uint64 cursor = 0;
    ma_uint64 length = 0;
    bool exact_length = false;
    ma_uint64 seek_target = 0;
    ma_uint64 discard_frames = 0;
    bool seeking = false;
    bool demux_eof = false;
    bool drain_sent = false;
    // Damaged frames skipped in a row; a whole run of them is a broken file.
    int damaged_run = 0;
    std::vector<float> pcm;
    std::vector<ma_channel> channel_map;
    ma_uint64 pcm_offset = 0;
};

void close(FfmpegDataSource& source) {
    swr_free(&source.resampler);
    av_frame_free(&source.frame);
    av_packet_free(&source.packet);
    avcodec_free_context(&source.codec);
    avformat_close_input(&source.format);
}

ma_result from_av_error(int error) {
    if (error == AVERROR(ENOMEM)) return MA_OUT_OF_MEMORY;
    if (error == AVERROR(ENOENT)) return MA_DOES_NOT_EXIST;
    return MA_INVALID_FILE;
}

const AVInputFormat* raw_input_format(const char* path) {
    std::string extension = std::filesystem::path{path}.extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    static constexpr std::array formats{
        std::pair{".pcm"sv, "s16le"sv}, std::pair{".raw"sv, "s16le"sv},
        std::pair{".s8"sv, "s8"sv}, std::pair{".s16"sv, "s16le"sv},
        std::pair{".s16le"sv, "s16le"sv}, std::pair{".s16be"sv, "s16be"sv},
        std::pair{".s24le"sv, "s24le"sv}, std::pair{".s24be"sv, "s24be"sv},
        std::pair{".s32le"sv, "s32le"sv}, std::pair{".s32be"sv, "s32be"sv},
        std::pair{".u8"sv, "u8"sv}, std::pair{".u16le"sv, "u16le"sv},
        std::pair{".u16be"sv, "u16be"sv}, std::pair{".u24le"sv, "u24le"sv},
        std::pair{".u24be"sv, "u24be"sv}, std::pair{".u32le"sv, "u32le"sv},
        std::pair{".u32be"sv, "u32be"sv}, std::pair{".f32le"sv, "f32le"sv},
        std::pair{".f32be"sv, "f32be"sv}, std::pair{".f64le"sv, "f64le"sv},
        std::pair{".f64be"sv, "f64be"sv}, std::pair{".al"sv, "alaw"sv},
        std::pair{".alaw"sv, "alaw"sv}, std::pair{".ul"sv, "mulaw"sv},
        std::pair{".ulaw"sv, "mulaw"sv}, std::pair{".mulaw"sv, "mulaw"sv},
        std::pair{".amr"sv, "amr"sv}, std::pair{".awb"sv, "amrwb"sv},
        std::pair{".aptx"sv, "aptx"sv}, std::pair{".c2"sv, "codec2"sv},
        std::pair{".g722"sv, "g722"sv}, std::pair{".g723"sv, "g723_1"sv},
        std::pair{".g726"sv, "g726"sv}, std::pair{".g729"sv, "g729"sv},
        std::pair{".gsm"sv, "gsm"sv}, std::pair{".ilbc"sv, "ilbc"sv},
        std::pair{".lbc"sv, "ilbc"sv}, std::pair{".lc3"sv, "lc3"sv},
        std::pair{".qcp"sv, "qcp"sv}, std::pair{".sbc"sv, "sbc"sv},
    };
    for (const auto& [suffix, format] : formats) {
        if (extension == suffix) return av_find_input_format(format.data());
    }
    return nullptr;
}

int64_t frame_position(const FfmpegDataSource& source, const AVFrame& frame) {
    int64_t timestamp = frame.best_effort_timestamp;
    if (timestamp == AV_NOPTS_VALUE) timestamp = frame.pts;
    if (timestamp == AV_NOPTS_VALUE) return -1;

    const AVStream* stream = source.format->streams[source.stream_index];
    if (stream->start_time != AV_NOPTS_VALUE) timestamp -= stream->start_time;
    return av_rescale_q(timestamp, stream->time_base,
                        AVRational{1, static_cast<int>(source.sample_rate)});
}

// One damaged frame (a bad sector, a broken download) is skipped, as players
// do: the cue plays on with a few milliseconds missing. Only a long run of
// them, a file broken beyond that, stops the cue.
constexpr int kMaxDamagedRun = 64;

int decode_next(FfmpegDataSource& source) {
    source.pcm.clear();
    source.pcm_offset = 0;

    for (;;) {
        const int received = avcodec_receive_frame(source.codec, source.frame);
        if (received == AVERROR_INVALIDDATA && ++source.damaged_run <= kMaxDamagedRun) continue;
        if (received == 0) {
            source.damaged_run = 0;
            const int capacity = swr_get_out_samples(source.resampler, source.frame->nb_samples);
            if (capacity <= 0) {
                av_frame_unref(source.frame);
                continue;
            }

            source.pcm.resize(static_cast<std::size_t>(capacity) * source.channels);
            uint8_t* output[] = {reinterpret_cast<uint8_t*>(source.pcm.data())};
            const int converted = swr_convert(source.resampler, output, capacity,
                                              const_cast<const uint8_t**>(source.frame->extended_data),
                                              source.frame->nb_samples);
            const int64_t position = frame_position(source, *source.frame);
            av_frame_unref(source.frame);
            if (converted < 0) return converted;

            source.pcm.resize(static_cast<std::size_t>(converted) * source.channels);
            if (source.discard_frames > 0) {
                const ma_uint64 discarded = std::min<ma_uint64>(source.discard_frames, converted);
                source.pcm_offset = discarded;
                source.discard_frames -= discarded;
                if (source.pcm_offset >= static_cast<ma_uint64>(converted)) {
                    source.pcm.clear();
                    source.pcm_offset = 0;
                    continue;
                }
            }
            if (source.seeking && position >= 0) {
                const ma_uint64 start = static_cast<ma_uint64>(std::max<int64_t>(position, 0));
                const ma_uint64 end = start + static_cast<ma_uint64>(converted);
                if (end <= source.seek_target) {
                    source.pcm.clear();
                    continue;
                }
                if (start < source.seek_target) {
                    source.pcm_offset = source.seek_target - start;
                }
                source.seeking = false;
            } else if (source.seeking) {
                source.seeking = false;
            }

            if (source.pcm_offset >= static_cast<ma_uint64>(converted)) {
                source.pcm.clear();
                source.pcm_offset = 0;
                continue;
            }
            return 1;
        }
        if (received != AVERROR(EAGAIN) && received != AVERROR_EOF) return received;
        if (received == AVERROR_EOF) return 0;

        if (source.demux_eof) {
            if (source.drain_sent) return 0;
            const int sent = avcodec_send_packet(source.codec, nullptr);
            if (sent < 0 && sent != AVERROR_EOF) return sent;
            source.drain_sent = true;
            continue;
        }

        for (;;) {
            const int read = av_read_frame(source.format, source.packet);
            if (read < 0) {
                if (read == AVERROR_EOF) {
                    source.demux_eof = true;
                    break;
                }
                return read;
            }
            if (source.packet->stream_index != source.stream_index) {
                av_packet_unref(source.packet);
                continue;
            }
            const int sent = avcodec_send_packet(source.codec, source.packet);
            av_packet_unref(source.packet);
            if (sent == AVERROR_INVALIDDATA && ++source.damaged_run <= kMaxDamagedRun) continue;
            if (sent < 0 && sent != AVERROR(EAGAIN)) return sent;
            break;
        }
    }
}

ma_result on_read(ma_data_source* data_source, void* output, ma_uint64 frame_count,
                  ma_uint64* frames_read) {
    auto& source = *reinterpret_cast<FfmpegDataSource*>(data_source);
    ma_uint64 total = 0;

    while (total < frame_count) {
        const ma_uint64 buffered = source.pcm.empty()
            ? 0
            : static_cast<ma_uint64>(source.pcm.size() / source.channels) - source.pcm_offset;
        if (buffered == 0) {
            const int decoded = decode_next(source);
            if (decoded == 0) {
                // Container duration estimates include lossy padding; only trust
                // sample-accurate lossless stream lengths for truncation checks.
                if (source.exact_length && source.cursor < source.length &&
                    source.length - source.cursor > 1) {
                    if (frames_read) *frames_read = total;
                    return MA_INVALID_FILE;
                }
                break;
            }
            if (decoded < 0) {
                if (frames_read) *frames_read = total;
                return from_av_error(decoded);
            }
            continue;
        }

        const ma_uint64 count = std::min(buffered, frame_count - total);
        if (output != nullptr) {
            auto* destination = static_cast<float*>(output) + total * source.channels;
            const float* input = source.pcm.data() + source.pcm_offset * source.channels;
            std::memcpy(destination, input,
                        static_cast<std::size_t>(count * source.channels) * sizeof(float));
        }
        source.pcm_offset += count;
        source.cursor += count;
        total += count;
    }

    if (frames_read) *frames_read = total;
    return total == 0 ? MA_AT_END : MA_SUCCESS;
}

ma_result on_seek(ma_data_source* data_source, ma_uint64 frame_index) {
    auto& source = *reinterpret_cast<FfmpegDataSource*>(data_source);
    const AVStream* stream = source.format->streams[source.stream_index];
    const auto* descriptor = avcodec_descriptor_get(source.codec->codec_id);
    const bool pcm = source.codec->codec_id >= AV_CODEC_ID_PCM_S16LE &&
                     source.codec->codec_id < AV_CODEC_ID_ADPCM_IMA_QT;
    const bool needs_preroll = !pcm &&
        (!descriptor || !(descriptor->props & AV_CODEC_PROP_LOSSLESS));
    // Warm up codec history before the requested PCM frame (MP3 bit reservoir,
    // AAC overlap, and codecs with an explicit seek-preroll requirement).
    const ma_uint64 preroll = needs_preroll ? std::max<ma_uint64>(
        source.sample_rate, std::max(source.codec->seek_preroll, 0)) : 0;
    const bool near_start = needs_preroll && frame_index <= preroll;
    int64_t timestamp = av_rescale_q(static_cast<int64_t>(std::min<ma_uint64>(
                                         near_start ? 0 : frame_index - preroll,
                                         std::numeric_limits<int64_t>::max())),
                                     AVRational{1, static_cast<int>(source.sample_rate)},
                                     stream->time_base);
    if (stream->start_time != AV_NOPTS_VALUE) timestamp += stream->start_time;
    const int result = near_start ? 0 : avformat_seek_file(source.format, source.stream_index,
                                          std::numeric_limits<int64_t>::min(), timestamp,
                                          timestamp, AVSEEK_FLAG_BACKWARD);
    const bool decode_from_start = near_start || result < 0;
    // shortcut: unsupported timestamp seeks decode from zero; add a format index if too slow.
    if (decode_from_start) {
        // Reopening restores demuxer priming/skip metadata; a raw byte rewind
        // loses it and can feed container headers to the audio decoder.
        AVFormatContext* fresh = nullptr;
        int reopened = avformat_open_input(&fresh, source.format->url,
                                           source.format->iformat, nullptr);
        if (reopened >= 0) reopened = avformat_find_stream_info(fresh, nullptr);
        if (reopened < 0) {
            avformat_close_input(&fresh);
            return from_av_error(reopened);
        }
        avformat_close_input(&source.format);
        source.format = fresh;
        discard_other_streams(source.format, source.stream_index);
    }

    avcodec_flush_buffers(source.codec);
    swr_close(source.resampler);
    if (swr_init(source.resampler) < 0) return MA_INVALID_OPERATION;
    source.pcm.clear();
    source.pcm_offset = 0;
    source.cursor = frame_index;
    source.seek_target = frame_index;
    source.seeking = !decode_from_start;
    source.discard_frames = decode_from_start ? frame_index : 0;
    source.demux_eof = false;
    source.drain_sent = false;
    return MA_SUCCESS;
}

ma_result on_get_format(ma_data_source* data_source, ma_format* format,
                        ma_uint32* channels, ma_uint32* sample_rate,
                        ma_channel* channel_map, size_t channel_map_capacity) {
    const auto& source = *reinterpret_cast<FfmpegDataSource*>(data_source);
    if (format) *format = ma_format_f32;
    if (channels) *channels = source.channels;
    if (sample_rate) *sample_rate = source.sample_rate;
    if (channel_map && channel_map_capacity > 0) {
        std::copy_n(source.channel_map.begin(),
                    std::min(source.channel_map.size(), channel_map_capacity), channel_map);
    }
    return MA_SUCCESS;
}

ma_result on_get_cursor(ma_data_source* data_source, ma_uint64* cursor) {
    if (!cursor) return MA_INVALID_ARGS;
    *cursor = reinterpret_cast<FfmpegDataSource*>(data_source)->cursor;
    return MA_SUCCESS;
}

ma_result on_get_length(ma_data_source* data_source, ma_uint64* length) {
    if (!length) return MA_INVALID_ARGS;
    const auto value = reinterpret_cast<FfmpegDataSource*>(data_source)->length;
    if (value == 0) return MA_NOT_IMPLEMENTED;
    *length = value;
    return MA_SUCCESS;
}

ma_data_source_vtable data_source_vtable{
    on_read, on_seek, on_get_format, on_get_cursor, on_get_length, nullptr, 0};

// ---------------------------------------------------------------------------
// Silent-video transport (spec VIDEO_PLAYBACK_V1.md §5.3).
//
// A video container without an audio stream cannot feed the FFmpeg source
// (av_find_best_stream fails), but the cue must still play, advance, and
// report progress: the client renders the picture in the Video Output
// window while the engine remains the clock master. When the open container
// shows a presentable video stream with a known duration, open_ffmpeg
// substitutes this zero-PCM source of exactly that length. Everything
// downstream — playhead meters, end-of-file playlist advance, waveform (a
// flat line), the metadata duration fallback — works unchanged.
// ---------------------------------------------------------------------------

struct SilentDataSource {
    ma_data_source_base base{};
    ma_uint64 length = 0;
    ma_uint64 cursor = 0;
};

ma_result silent_on_read(ma_data_source* data_source, void* output, ma_uint64 frame_count,
                         ma_uint64* frames_read) {
    auto& source = *reinterpret_cast<SilentDataSource*>(data_source);
    if (source.cursor >= source.length) {
        if (frames_read) *frames_read = 0;
        return MA_AT_END;
    }
    const ma_uint64 count = std::min(frame_count, source.length - source.cursor);
    if (output) {
        std::memset(output, 0, static_cast<std::size_t>(count) * 2 * sizeof(float));
    }
    source.cursor += count;
    if (frames_read) *frames_read = count;
    return MA_SUCCESS;
}

ma_result silent_on_seek(ma_data_source* data_source, ma_uint64 frame_index) {
    auto& source = *reinterpret_cast<SilentDataSource*>(data_source);
    source.cursor = std::min(frame_index, source.length);
    return MA_SUCCESS;
}

ma_result silent_on_get_cursor(ma_data_source* data_source, ma_uint64* cursor) {
    if (!cursor) return MA_INVALID_ARGS;
    *cursor = reinterpret_cast<SilentDataSource*>(data_source)->cursor;
    return MA_SUCCESS;
}

ma_result silent_on_get_length(ma_data_source* data_source, ma_uint64* length) {
    if (!length) return MA_INVALID_ARGS;
    *length = reinterpret_cast<SilentDataSource*>(data_source)->length;
    return *length == 0 ? MA_NOT_IMPLEMENTED : MA_SUCCESS;
}

ma_data_source_vtable silent_data_source_vtable{
    silent_on_read, silent_on_seek, stereo_48k_on_get_format, silent_on_get_cursor,
    silent_on_get_length, nullptr, 0};

ma_result open_silent(ma_uint64 length_frames, ma_data_source** backend) {
    if (!backend) return MA_INVALID_ARGS;
    auto* source = new (std::nothrow) SilentDataSource{};
    if (!source) return MA_OUT_OF_MEMORY;
    source->length = length_frames;
    ma_data_source_config config = ma_data_source_config_init();
    config.vtable = &silent_data_source_vtable;
    const ma_result result = ma_data_source_init(&config, &source->base);
    if (result != MA_SUCCESS) {
        delete source;
        return result;
    }
    *backend = source;
    return MA_SUCCESS;
}

// Scan an open container for a presentable video stream — the same predicate
// file_has_video_stream applies (real video stream, not attached-pic cover
// art). Call between avformat_find_stream_info and avformat_close_input.
bool has_presentable_video_stream(const AVFormatContext* format) {
    if (!format) return false;
    for (unsigned i = 0; i < format->nb_streams; ++i) {
        const AVStream* s = format->streams[i];
        if (s && s->codecpar && s->codecpar->codec_type == AVMEDIA_TYPE_VIDEO &&
            s->codecpar->codec_id != AV_CODEC_ID_NONE &&
            !(s->disposition & AV_DISPOSITION_ATTACHED_PIC)) {
            return true;
        }
    }
    return false;
}

ma_result open_ffmpeg(const char* path, ma_data_source** backend) {
    if (!path || !backend) return MA_INVALID_ARGS;
    auto* source = new (std::nothrow) FfmpegDataSource{};
    if (!source) return MA_OUT_OF_MEMORY;

    int result = avformat_open_input(&source->format, path, raw_input_format(path), nullptr);
    if (result >= 0) result = avformat_find_stream_info(source->format, nullptr);
    if (result >= 0) {
        result = av_find_best_stream(source->format, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
        source->stream_index = result;
        if (result >= 0) discard_other_streams(source->format, result);
    }

    // Silent-video transport: no audio stream, but a presentable video stream
    // with a known container duration → the cue plays as exactly-that-long
    // silence (see SilentDataSource above). Unknown duration stays an error:
    // an endless silent source would never auto-advance the playlist.
    if (result < 0 && source->format &&
        has_presentable_video_stream(source->format) &&
        source->format->duration != AV_NOPTS_VALUE && source->format->duration > 0) {
        const ma_uint64 length = static_cast<ma_uint64>(av_rescale_q(
            source->format->duration, AV_TIME_BASE_Q, AVRational{1, 48000}));
        close(*source);
        delete source;
        return open_silent(length, backend);
    }

    const AVCodec* decoder = nullptr;
    if (result >= 0) {
        const AVCodecParameters* parameters = source->format->streams[source->stream_index]->codecpar;
        decoder = avcodec_find_decoder(parameters->codec_id);
        if (!decoder) result = AVERROR_DECODER_NOT_FOUND;
        if (result >= 0) source->codec = avcodec_alloc_context3(decoder);
        if (!source->codec) result = AVERROR(ENOMEM);
        if (result >= 0) result = avcodec_parameters_to_context(source->codec, parameters);
        if (result >= 0) result = avcodec_open2(source->codec, decoder, nullptr);
    }

    if (result >= 0) {
        source->sample_rate = static_cast<ma_uint32>(source->codec->sample_rate);
        source->channels = static_cast<ma_uint32>(source->codec->ch_layout.nb_channels);
        if (source->sample_rate == 0 || source->channels == 0) result = AVERROR_INVALIDDATA;
    }

    AVChannelLayout layout{};
    if (result >= 0) {
        if (source->codec->ch_layout.order == AV_CHANNEL_ORDER_UNSPEC) {
            av_channel_layout_default(&layout, static_cast<int>(source->channels));
        } else {
            result = av_channel_layout_copy(&layout, &source->codec->ch_layout);
        }
    }
    if (result >= 0) {
        constexpr std::array positions{
            MA_CHANNEL_FRONT_LEFT, MA_CHANNEL_FRONT_RIGHT, MA_CHANNEL_FRONT_CENTER,
            MA_CHANNEL_LFE, MA_CHANNEL_BACK_LEFT, MA_CHANNEL_BACK_RIGHT,
            MA_CHANNEL_FRONT_LEFT_CENTER, MA_CHANNEL_FRONT_RIGHT_CENTER,
            MA_CHANNEL_BACK_CENTER, MA_CHANNEL_SIDE_LEFT, MA_CHANNEL_SIDE_RIGHT,
            MA_CHANNEL_TOP_CENTER, MA_CHANNEL_TOP_FRONT_LEFT, MA_CHANNEL_TOP_FRONT_CENTER,
            MA_CHANNEL_TOP_FRONT_RIGHT, MA_CHANNEL_TOP_BACK_LEFT,
            MA_CHANNEL_TOP_BACK_CENTER, MA_CHANNEL_TOP_BACK_RIGHT};
        source->channel_map.resize(source->channels, MA_CHANNEL_NONE);
        for (ma_uint32 c = 0; c < source->channels; ++c) {
            const auto position = av_channel_layout_channel_from_index(&layout, c);
            if (position >= AV_CHAN_FRONT_LEFT && position <= AV_CHAN_TOP_BACK_RIGHT)
                source->channel_map[c] = static_cast<ma_channel>(positions[position]);
        }
        result = swr_alloc_set_opts2(&source->resampler,
                                     &layout, AV_SAMPLE_FMT_FLT, source->sample_rate,
                                     &layout, source->codec->sample_fmt, source->sample_rate,
                                     0, nullptr);
        if (result >= 0) result = swr_init(source->resampler);
    }
    av_channel_layout_uninit(&layout);

    if (result >= 0) {
        source->packet = av_packet_alloc();
        source->frame = av_frame_alloc();
        if (!source->packet || !source->frame) result = AVERROR(ENOMEM);
    }

    if (result >= 0) {
        AVStream* stream = source->format->streams[source->stream_index];
        if (stream->duration != AV_NOPTS_VALUE && stream->duration > 0) {
            source->length = static_cast<ma_uint64>(av_rescale_q(
                stream->duration, stream->time_base,
                AVRational{1, static_cast<int>(source->sample_rate)}));
            const auto* descriptor = avcodec_descriptor_get(source->codec->codec_id);
            source->exact_length = descriptor && (descriptor->props & AV_CODEC_PROP_LOSSLESS) &&
                av_rescale_q(1, stream->time_base,
                             AVRational{1, static_cast<int>(source->sample_rate)}) <= 1;
        } else if (source->format->duration != AV_NOPTS_VALUE && source->format->duration > 0) {
            source->length = static_cast<ma_uint64>(av_rescale_q(
                source->format->duration, AV_TIME_BASE_Q,
                AVRational{1, static_cast<int>(source->sample_rate)}));
        }

        ma_data_source_config config = ma_data_source_config_init();
        config.vtable = &data_source_vtable;
        const ma_result initialized = ma_data_source_init(&config, &source->base);
        if (initialized != MA_SUCCESS) result = AVERROR(EINVAL);
    }

    if (result < 0) {
        close(*source);
        delete source;
        return from_av_error(result);
    }

    *backend = source;
    return MA_SUCCESS;
}

ma_result backend_init(void*, ma_read_proc, ma_seek_proc, ma_tell_proc, void*,
                       const ma_decoding_backend_config*, const ma_allocation_callbacks*,
                       ma_data_source**) {
    return MA_NOT_IMPLEMENTED;
}

ma_result backend_init_file(void*, const char* path, const ma_decoding_backend_config*,
                            const ma_allocation_callbacks*, ma_data_source** backend) {
    return open_ffmpeg(path, backend);
}

ma_result backend_init_file_w(void*, const wchar_t* path, const ma_decoding_backend_config*,
                              const ma_allocation_callbacks*, ma_data_source** backend) {
    if (!path) return MA_INVALID_ARGS;
    return open_ffmpeg(util::path_to_utf8(std::filesystem::path{path}).c_str(), backend);
}

void backend_uninit(void*, ma_data_source* backend, const ma_allocation_callbacks*) {
    if (!backend) return;
    // open_ffmpeg may substitute a SilentDataSource for a video-only
    // container (silent-video transport) — dispatch on the data source's own
    // vtable rather than assuming the FFmpeg layout.
    if (reinterpret_cast<ma_data_source_base*>(backend)->vtable == &silent_data_source_vtable) {
        auto* source = reinterpret_cast<SilentDataSource*>(backend);
        ma_data_source_uninit(&source->base);
        delete source;
        return;
    }
    auto* source = reinterpret_cast<FfmpegDataSource*>(backend);
    ma_data_source_uninit(&source->base);
    close(*source);
    delete source;
}

ma_decoding_backend_vtable ffmpeg_backend{
    backend_init, backend_init_file, backend_init_file_w, nullptr, backend_uninit};
ma_decoding_backend_vtable playlist_backend{
    nullptr, playlist_backend_init_file, playlist_backend_init_file_w,
    nullptr, playlist_backend_uninit};
ma_decoding_backend_vtable cdda_backend{
    nullptr, cdda_backend_init_file, cdda_backend_init_file_w,
    nullptr, cdda_backend_uninit};
ma_decoding_backend_vtable* backends[] = {
    &cdda_backend, &playlist_backend, &ffmpeg_backend};

} // namespace

bool file_has_video_stream(const std::filesystem::path& path) noexcept {
    if (path.empty()) return false;
    AVFormatContext* format = nullptr;
    const std::string utf8 = util::path_to_utf8(path);
    // Mirrors open_ffmpeg's container handling (same raw-format override), but
    // only inspects streams — no decoder is opened.
    if (avformat_open_input(&format, utf8.c_str(),
                            raw_input_format(utf8.c_str()), nullptr) < 0) return false;
    const bool found = avformat_find_stream_info(format, nullptr) >= 0 &&
                       has_presentable_video_stream(format);
    avformat_close_input(&format);
    return found;
}

ma_decoder_config decoder_config(ma_format format, ma_uint32 channels, ma_uint32 sample_rate) {
    ma_decoder_config config = ma_decoder_config_init(format, channels, sample_rate);
    config.ppCustomBackendVTables = backends;
    config.customBackendCount = static_cast<ma_uint32>(std::size(backends));
    return config;
}

bool file_has_truncated_riff(const std::filesystem::path& path, std::uintmax_t size) {
    std::array<std::uint8_t, 48> header{};
    std::ifstream input{path, std::ios::binary};
    input.read(reinterpret_cast<char*>(header.data()), header.size());
    if (input.gcount() < 12 || std::memcmp(header.data() + 8, "WAVE", 4) != 0) return false;
    if (std::memcmp(header.data(), "RIFF", 4) == 0 || std::memcmp(header.data(), "RIFX", 4) == 0) {
        const auto declared = header[3] == 'X' ? read_be32(header.data() + 4) : read_le32(header.data() + 4);
        return declared != UINT32_MAX && declared != 0 && std::uint64_t{declared} + 8 > size;
    }
    if (std::memcmp(header.data(), "RF64", 4) == 0 && input.gcount() >= 28 &&
        std::memcmp(header.data() + 12, "ds64", 4) == 0) {
        const std::uint64_t declared = read_le32(header.data() + 20) |
            (std::uint64_t{read_le32(header.data() + 24)} << 32);
        if (declared == UINT64_MAX) return false;
        return size < 8 || declared > size - 8;
    }
    return false;
}

ma_result decoder_init_file(const std::filesystem::path& path,
                            const ma_decoder_config& config,
                            ma_decoder& decoder) {
    std::error_code size_error;
    const auto size = std::filesystem::file_size(path, size_error);
    if (!size_error && file_has_truncated_riff(path, size)) return MA_INVALID_FILE;
#if defined(_WIN32)
    const std::wstring native = path.wstring();
    ma_result result = ma_decoder_init_file_w(native.c_str(), &config, &decoder);
#else
    const std::string native = path.string();
    ma_result result = ma_decoder_init_file(native.c_str(), &config, &decoder);
#endif
    if (result == MA_SUCCESS && config.channels == 0 && !config.pChannelMap &&
        decoder.converter.hasChannelConverter) {
        // Native channels preserve PCM order too; a default output map remixes or drops them.
        auto& converter = decoder.converter.channelConverter;
        const auto native_config = ma_channel_converter_config_init(
            converter.format, converter.channelsIn, converter.pChannelMapIn,
            converter.channelsOut, converter.pChannelMapIn, config.channelMixMode);
        ma_channel_converter native_converter{};
        result = ma_channel_converter_init(
            &native_config, &decoder.allocationCallbacks, &native_converter);
        if (result != MA_SUCCESS) {
            ma_decoder_uninit(&decoder);
            return result;
        }
        ma_channel_converter_uninit(&converter, &decoder.allocationCallbacks);
        converter = native_converter;
    }
    return result;
}

} // namespace liveplay::audio
