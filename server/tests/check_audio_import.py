#!/usr/bin/env python3
"""Generate disposable media and run the native audio-import-test executable."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="dwcue-audio-import-") as directory:
        fixtures = Path(directory)

        def encode(name, source, codec):
            subprocess.run([args.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                            "-f", "lavfi", "-i", source, "-c:a", codec, "-strict", "-2",
                            str(fixtures / name)], check=True, timeout=30)

        tone = "sine=frequency=997:sample_rate=44100:duration=3,aformat=channel_layouts=stereo"
        for name, codec in [("tone.mp3", "libmp3lame"), ("tone.m4a", "aac"),
                            ("tone.flac", "flac"), ("tone.ogg", "vorbis"),
                            ("tone.opus", "libopus")]:
            encode(name, tone, codec)
        encode("aligned.flac", "sine=frequency=997:sample_rate=48000:duration=3", "flac")
        encode("loop.wav", "sine=frequency=997:sample_rate=48000:duration=3", "pcm_s16le")
        for name, layout in [("lfe.wav", "2.1"), ("center.wav", "3.0")]:
            encode(name, "aevalsrc=0|0|0.2*sin(2*PI*80*t):s=48000:d=3:c=" + layout,
                   "pcm_f32le")
        for name, channels, layout in [("2.1", 3, "2.1"), ("wide", 8, "7.1(wide)"),
                                        ("hexa", 16, "hexadecagonal")]:
            values = "|".join(str(0.01 * (channel + 1)) for channel in range(channels))
            encode("channels-" + name + ".wav",
                   "aevalsrc=" + values + ":s=48000:d=3:c=" + layout, "pcm_f32le")
        data = (fixtures / "tone.flac").read_bytes()
        (fixtures / "truncated-frame.flac").write_bytes(data[:len(data) // 2])
        packets = json.loads(subprocess.check_output([
            args.ffprobe, "-v", "error", "-show_packets", "-show_entries", "packet=pos",
            "-of", "json", str(fixtures / "tone.flac")], timeout=30))["packets"]
        boundary = int(packets[len(packets) // 2]["pos"])
        (fixtures / "truncated-packet.flac").write_bytes(data[:boundary])
        packets = json.loads(subprocess.check_output([
            args.ffprobe, "-v", "error", "-show_packets", "-show_entries", "packet=pos",
            "-of", "json", str(fixtures / "aligned.flac")], timeout=30))["packets"]
        # Eight 4608-sample FLAC blocks end exactly on a 4096-frame read boundary.
        (fixtures / "truncated-aligned.flac").write_bytes(
            (fixtures / "aligned.flac").read_bytes()[:int(packets[8]["pos"])])
        for name in ["truncated-frame", "truncated-packet", "truncated-aligned"]:
            (fixtures / (name + ".xspf")).write_text(
                "<playlist><location>" + name + ".flac</location></playlist>")
        (fixtures / "valid.xspf").write_text(
            "<playlist><trackList><track><location>tone.flac</location></track></trackList></playlist>")
        for suffix in ["xspf", "asx", "wax", "wvx", "smil", "smi"]:
            name = "loop." + suffix
            if suffix == "xspf":
                content = "<playlist><location>" + name + "</location></playlist>"
            elif suffix in ["asx", "wax", "wvx"]:
                content = '<asx><entry><ref href="' + name + '"/></entry></asx>'
            else:
                content = '<smil><body><audio src="' + name + '"/></body></smil>'
            (fixtures / name).write_text(content)
        subprocess.run([str(args.binary.resolve()), str(fixtures)], check=True, timeout=120)


if __name__ == "__main__":
    main()
