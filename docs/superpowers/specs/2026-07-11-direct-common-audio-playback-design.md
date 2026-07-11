# Direct Common-Audio Playback Design

## Goal

LivePlay plays common audio formats directly from their original files. It does not transcode, create replacement WAV files, or maintain decoded-audio caches.

## Supported files

The playback surface includes WAV/BWF/W64, MP1/MP2/MP3, FLAC, AIFF/AIFC, AAC, M4A/M4B/M4R with AAC or ALAC, OGG/Vorbis, Opus, WMA, CAF, APE, WavPack, AMR, AC-3/E-AC-3, DTS, Matroska/WebM audio, AU/SND, DSF, TTA, Musepack, Speex, GSM, VOC, and RealAudio where FFmpeg has a decoder.

Files containing a normal video stream are rejected. Embedded cover artwork is allowed. For containers with multiple audio streams, LivePlay uses FFmpeg's best audio stream.

## Architecture

The C++ server links the LGPL FFmpeg decoding libraries statically through vcpkg. A custom miniaudio data source wraps FFmpeg demuxing and decoding and exposes interleaved floating-point PCM frames to the existing `ma_decoder` pipeline.

The existing miniaudio decoder remains the first choice for formats it already handles. If that decoder cannot open a file, the same decoder initialization helper retries with the FFmpeg backend. This keeps the existing mixer, device output, routing, fades, meters, LTC, and render loop unchanged.

The shared decoder initializer is used by:

- `PlaybackItem` for live playback, seeking, looping, and cue pre-warming.
- Waveform generation so every playable file has a waveform.
- Metadata duration fallback so every playable file reports useful timing.

## Playback behavior

FFmpeg decodes from the source file on demand. Its backend reports native channel count and sample rate; miniaudio performs the existing conversion to the engine's floating-point mix rate in memory as audio is rendered. No decoded audio is written to disk.

Seeking flushes FFmpeg's codec and resampler state, seeks to the requested audio timestamp, and resumes decoding at that position. Existing loop and out-point code continues to seek through `ma_decoder`, so it works with both native and FFmpeg-backed files.

Project import may copy the original file byte-for-byte into the project's media folder. It never changes the filename extension or audio contents.

## Errors and safety

- Unsupported, corrupt, DRM-protected, or video-containing files fail cue loading with a clear decoder error.
- Decoder failures produce silence and never crash the render thread.
- FFmpeg allocations, packets, frames, codec contexts, format contexts, and resampler state are released on every failure path.
- Decoder operations remain protected by the existing per-cue decoder mutex.

## Packaging

The FFmpeg libraries are statically linked into `liveplay-server`; users do not install FFmpeg and the server does not spawn an FFmpeg process. The same source and vcpkg dependency build on macOS, Windows, and Linux.

## Verification

An assert-free executable check creates representative test files and verifies that the real playback decoder:

1. Opens each original file without creating another audio file.
2. Renders non-silent PCM.
3. Seeks and resumes rendering.
4. Loops through the existing `PlaybackItem` path.
5. Generates waveform and duration data.
6. Rejects a real video file and a video file renamed with an audio extension.

The final packaged app is launched once, and the bundled server is exercised from the mounted DMG with representative direct-playback files.

## Acceptance criteria

- Common audio files load and render directly from their original paths.
- No conversion command, converted WAV, or decoded-audio cache exists.
- Existing projects gain the same format support automatically when cues load.
- Seeking, looping, fades, waveform generation, metadata, and cue loading work for FFmpeg-backed files.
- Video files remain unsupported.
