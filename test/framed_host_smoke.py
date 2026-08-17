#!/usr/bin/env python3
import argparse
import functools
import http.server
import json
import os
import select
import struct
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, _format, *_args):
        return


def send_frame(stream, payload):
    encoded = json.dumps(payload).encode("utf-8")
    stream.write(struct.pack("<I", len(encoded)))
    stream.write(encoded)
    stream.flush()


def read_exact(stream, length):
    chunks = []
    remaining = length
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            raise RuntimeError("Native host closed before completing a frame")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame(stream, timeout):
    ready, _, _ = select.select([stream], [], [], timeout)
    if not ready:
        raise TimeoutError("Timed out waiting for native-host output")
    length = struct.unpack("<I", read_exact(stream, 4))[0]
    return json.loads(read_exact(stream, length).decode("utf-8"))


def read_until(stream, expected_type, job_id, timeout=45):
    deadline = time.monotonic() + timeout
    messages = []
    while time.monotonic() < deadline:
        message = read_frame(stream, max(0.1, deadline - time.monotonic()))
        messages.append(message)
        if message.get("jobId") == job_id and message.get("type") == expected_type:
            return message, messages
        if message.get("jobId") == job_id and message.get("type") == "error":
            raise RuntimeError(message.get("details") or message.get("error") or "Native host failed")
    raise TimeoutError(f"Did not receive {expected_type} for {job_id}")


def main():
    parser = argparse.ArgumentParser(description="Framed Native Messaging direct-MP4 smoke test")
    parser.add_argument("--host", required=True, type=Path, help="Installed host-source launcher or host.py")
    parser.add_argument("--ffmpeg", required=True, type=Path, help="Bundled ffmpeg executable")
    parser.add_argument("--youtube-url", help="Optional short public YouTube URL for a live page-extractor test")
    args = parser.parse_args()

    host = args.host.resolve()
    ffmpeg = args.ffmpeg.resolve()
    if not host.exists() or not os.access(host, os.X_OK):
        raise SystemExit(f"Host launcher is not executable: {host}")
    if not ffmpeg.exists() or not os.access(ffmpeg, os.X_OK):
        raise SystemExit(f"ffmpeg is not executable: {ffmpeg}")

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        served = root / "served"
        output = root / "output"
        served.mkdir()
        output.mkdir()
        source = served / "direct-test.mp4"
        subprocess.run(
            [
                str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y",
                "-f", "lavfi", "-i", "testsrc2=duration=2:size=320x180:rate=24",
                "-f", "lavfi", "-i", "sine=frequency=880:duration=2",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-shortest", str(source),
            ],
            check=True,
        )
        hls_dir = served / "hls"
        hls_dir.mkdir()
        playlist = hls_dir / "master.m3u8"
        subprocess.run(
            [
                str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y",
                "-i", str(source), "-c", "copy", "-hls_time", "0.5",
                "-hls_playlist_type", "vod", str(playlist),
            ],
            check=True,
        )

        handler = functools.partial(QuietHandler, directory=str(served))
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        port = server.server_address[1]

        command = [str(host)] if host.suffix != ".py" else [sys.executable, str(host)]
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert process.stdin is not None
        assert process.stdout is not None

        try:
            send_frame(process.stdin, {"action": "ping", "jobId": "smoke-ping"})
            pong, _ = read_until(process.stdout, "pong", "smoke-ping", timeout=10)

            direct_url = f"http://127.0.0.1:{port}/{source.name}"
            send_frame(process.stdin, {
                "action": "download",
                "jobId": "smoke-direct-mp4",
                "url": direct_url,
                "pageUrl": direct_url,
                "pageTitle": "Direct MP4 smoke",
                "sourceTitle": "Direct MP4 smoke",
                "kind": "mp4",
                "expectedDuration": 2,
                "qualityPreference": "best",
                "settings": {
                    "outputDir": str(output),
                    "autoCookies": False,
                    "defaultQuality": "best",
                },
            })
            completed, progress_messages = read_until(
                process.stdout, "complete", "smoke-direct-mp4", timeout=45
            )
            completed_path = Path(completed["outputPath"])
            if not completed_path.exists() or completed_path.suffix.lower() != ".mp4":
                raise RuntimeError(f"Completed output is missing or not MP4: {completed_path}")
            if completed.get("videoStreams", 0) < 1 or completed.get("audioStreams", 0) < 1:
                raise RuntimeError(f"Direct MP4 probe did not report video+audio streams: {completed}")

            hls_url = f"http://127.0.0.1:{port}/hls/{playlist.name}"
            send_frame(process.stdin, {
                "action": "download",
                "jobId": "smoke-hls",
                "url": hls_url,
                "pageUrl": f"http://127.0.0.1:{port}/watch",
                "pageTitle": "HLS smoke",
                "sourceTitle": "HLS smoke",
                "kind": "hls_master",
                "expectedDuration": 2,
                "qualityPreference": "best",
                "settings": {
                    "outputDir": str(output),
                    "autoCookies": False,
                    "defaultQuality": "best",
                },
            })
            hls_completed, hls_progress = read_until(
                process.stdout, "complete", "smoke-hls", timeout=45
            )
            hls_path = Path(hls_completed["outputPath"])
            if not hls_path.exists() or hls_path.suffix.lower() != ".mp4":
                raise RuntimeError(f"HLS output is missing or not MP4: {hls_path}")
            if hls_completed.get("videoStreams", 0) < 1 or hls_completed.get("audioStreams", 0) < 1:
                raise RuntimeError(f"HLS MP4 probe did not report video+audio streams: {hls_completed}")

            youtube_completed = None
            youtube_progress = []
            if args.youtube_url:
                send_frame(process.stdin, {
                    "action": "download",
                    "jobId": "smoke-youtube",
                    "url": args.youtube_url,
                    "pageUrl": args.youtube_url,
                    "pageTitle": "YouTube page extractor smoke",
                    "sourceTitle": "YouTube page extractor smoke",
                    "kind": "page",
                    "preferPageUrl": True,
                    "qualityPreference": "360p",
                    "settings": {
                        "outputDir": str(output),
                        "autoCookies": False,
                        "defaultQuality": "360p",
                    },
                })
                youtube_completed, youtube_progress = read_until(
                    process.stdout, "complete", "smoke-youtube", timeout=90
                )
                youtube_path = Path(youtube_completed["outputPath"])
                if not youtube_path.exists() or youtube_path.suffix.lower() != ".mp4":
                    raise RuntimeError(f"YouTube output is missing or not MP4: {youtube_path}")

            send_frame(process.stdin, {
                "action": "download",
                "jobId": "smoke-invalid-url",
                "url": "not-a-valid-url",
                "pageUrl": "",
                "pageTitle": "Invalid URL smoke",
                "kind": "mp4",
                "settings": {"outputDir": str(output), "autoCookies": False},
            })
            invalid, _ = read_until(process.stdout, "error", "smoke-invalid-url", timeout=10)

            summary = {
                "ok": True,
                "hostVersion": pong.get("version"),
                "directMp4": {
                    "status": "complete",
                    "fileSize": completed.get("fileSize"),
                    "duration": completed.get("duration"),
                    "width": completed.get("width"),
                    "height": completed.get("height"),
                    "videoStreams": completed.get("videoStreams"),
                    "audioStreams": completed.get("audioStreams"),
                    "progressMessages": len(progress_messages),
                },
                "hls": {
                    "status": "complete",
                    "fileSize": hls_completed.get("fileSize"),
                    "duration": hls_completed.get("duration"),
                    "width": hls_completed.get("width"),
                    "height": hls_completed.get("height"),
                    "videoStreams": hls_completed.get("videoStreams"),
                    "audioStreams": hls_completed.get("audioStreams"),
                    "progressMessages": len(hls_progress),
                },
                "invalidUrl": {
                    "status": "error",
                    "message": invalid.get("error") or invalid.get("message"),
                },
            }
            if youtube_completed:
                summary["youtube"] = {
                    "status": "complete",
                    "fileSize": youtube_completed.get("fileSize"),
                    "duration": youtube_completed.get("duration"),
                    "width": youtube_completed.get("width"),
                    "height": youtube_completed.get("height"),
                    "videoStreams": youtube_completed.get("videoStreams"),
                    "audioStreams": youtube_completed.get("audioStreams"),
                    "progressMessages": len(youtube_progress),
                }
            print(json.dumps(summary, ensure_ascii=False))
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                process.wait(timeout=5)
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
