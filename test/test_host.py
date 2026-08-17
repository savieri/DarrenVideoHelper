import importlib.util
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "video_helper_host",
    Path(__file__).resolve().parents[1] / "native" / "host.py",
)
HOST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOST)


class NativeHostTests(unittest.TestCase):
    def test_main_keeps_the_native_port_alive_for_multiple_messages(self):
        messages = [
            {"action": "ping", "jobId": "ping-one"},
            {"action": "ping", "jobId": "ping-two"},
            None,
        ]
        with (
            mock.patch.object(HOST, "setup_logging"),
            mock.patch.object(HOST, "read_message", side_effect=messages),
            mock.patch.object(HOST, "send_message") as sender,
            mock.patch.object(HOST.sys, "argv", ["host.py"]),
        ):
            HOST.main()

        self.assertEqual(sender.call_count, 2)
        self.assertEqual(sender.call_args_list[0].args[0]["type"], "pong")
        self.assertEqual(sender.call_args_list[1].args[0]["jobId"], "ping-two")

    def test_ytdlp_command_carries_snapshot_headers_and_retry_policy(self):
        message = {
            "pageUrl": "https://site.test/watch",
            "referer": "https://site.test/snapshot",
            "headers": {
                "referer": "https://site.test/request-context",
                "user-agent": "VideoHelperTest/1.0",
                "origin": "https://site.test",
            },
            "settings": {"autoCookies": False, "defaultQuality": "720p"},
        }
        with mock.patch.object(HOST, "tool_path", side_effect=lambda name: f"/tools/{name}"):
            command = HOST.build_ytdlp_command(
                message,
                "https://cdn.test/master.m3u8",
                Path("/tmp/output"),
                "video.mp4",
            )

        self.assertIn("--continue", command)
        self.assertIn("--fragment-retries", command)
        self.assertIn("8", command)
        self.assertIn("--socket-timeout", command)
        referer_index = command.index("--referer")
        self.assertEqual(command[referer_index + 1], "https://site.test/request-context")
        self.assertEqual(command[-1], "https://cdn.test/master.m3u8")

    def test_per_card_quality_overrides_the_saved_default(self):
        message = {
            "pageUrl": "https://www.youtube.com/watch?v=videoA",
            "qualityPreference": "1080p",
            "settings": {"autoCookies": False, "defaultQuality": "720p"},
        }
        with mock.patch.object(HOST, "tool_path", side_effect=lambda name: f"/tools/{name}"):
            command = HOST.build_ytdlp_command(
                message,
                message["pageUrl"],
                Path("/tmp/output"),
                "video.mp4",
            )
        selector_index = command.index("-f")
        self.assertIn("height<=1080", command[selector_index + 1])

    def test_small_output_cannot_be_completed(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "tiny.mp4"
            output.write_bytes(b"not a video")
            with self.assertRaisesRegex(RuntimeError, "过小"):
                HOST.ffprobe_info(output)

    def test_playable_mp4_is_preserved_when_page_duration_metadata_differs(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "wrong.mp4"
            output.write_bytes(b"0" * (128 * 1024))
            with mock.patch.object(HOST, "ffprobe_info", return_value={
                "fileSize": output.stat().st_size,
                "duration": 20,
                "width": 1280,
                "height": 720,
            }):
                validated, probe = HOST.validate_final_output("job", output, expected_duration=600)
            self.assertEqual(validated, output)
            self.assertEqual(probe["duration"], 20)
            self.assertTrue(output.exists())

    def test_short_but_ffprobe_valid_mp4_is_not_deleted(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "wrong-short.mp4"
            output.write_bytes(b"0" * (128 * 1024))
            with mock.patch.object(HOST, "ffprobe_info", return_value={
                "fileSize": output.stat().st_size,
                "duration": 5,
                "width": 960,
                "height": 540,
            }):
                validated, probe = HOST.validate_final_output("job", output, expected_duration=30)
            self.assertEqual(validated, output)
            self.assertEqual(probe["duration"], 5)
            self.assertTrue(output.exists())

    def test_nonzero_ytdlp_exit_completes_when_mp4_passes_ffprobe(self):
        class FakeProcess:
            pid = 1234
            stdout = iter(["ERROR: HTTP Error 403 after download\n"])

            @staticmethod
            def wait():
                return 1

        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            output = output_dir / "video.mp4"
            output.write_bytes(b"0" * (128 * 1024))
            with (
                mock.patch.object(HOST, "build_ytdlp_command", return_value=["yt-dlp"]),
                mock.patch.object(HOST.subprocess, "Popen", return_value=FakeProcess()),
                mock.patch.object(HOST, "ffprobe_info", return_value={
                    "fileSize": output.stat().st_size,
                    "duration": 120,
                    "width": 1920,
                    "height": 1080,
                }),
                mock.patch.object(HOST, "progress") as progress,
                mock.patch.object(HOST.sys, "stderr"),
            ):
                result, log, _started_at = HOST.run_ytdlp_attempt(
                    "job", {}, "https://cdn.test/video.m3u8", output_dir, "video", "HLS"
                )

            self.assertEqual(result, output)
            self.assertIn("403", log)
            self.assertTrue(output.exists())
            self.assertTrue(any(call.kwargs.get("percent") == "100" for call in progress.call_args_list))

    def test_nonzero_ytdlp_exit_fails_and_removes_invalid_mp4(self):
        class FakeProcess:
            pid = 1234
            stdout = iter(["ERROR: timed out\n"])

            @staticmethod
            def wait():
                return 1

        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            output = output_dir / "video.mp4"
            output.write_bytes(b"0" * (128 * 1024))
            with (
                mock.patch.object(HOST, "build_ytdlp_command", return_value=["yt-dlp"]),
                mock.patch.object(HOST.subprocess, "Popen", return_value=FakeProcess()),
                mock.patch.object(HOST, "ffprobe_info", side_effect=RuntimeError("invalid moov atom")),
                mock.patch.object(HOST, "progress"),
                mock.patch.object(HOST.sys, "stderr"),
            ):
                result, log, _started_at = HOST.run_ytdlp_attempt(
                    "job", {}, "https://cdn.test/video.m3u8", output_dir, "video", "HLS"
                )

            self.assertIsNone(result)
            self.assertIn("no valid MP4", log)
            self.assertFalse(output.exists())

    def test_dash_video_only_intermediate_is_not_recovered_as_final_mp4(self):
        class FakeProcess:
            pid = 1234
            stdout = iter(["ERROR: merger failed\n"])

            @staticmethod
            def wait():
                return 1

        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            video_only = output_dir / "video.f137.mp4"
            video_only.write_bytes(b"0" * (128 * 1024))
            with (
                mock.patch.object(HOST, "build_ytdlp_command", return_value=["yt-dlp"]),
                mock.patch.object(HOST.subprocess, "Popen", return_value=FakeProcess()),
                mock.patch.object(HOST, "ffprobe_info") as probe,
                mock.patch.object(HOST, "progress"),
                mock.patch.object(HOST.sys, "stderr"),
            ):
                result, log, started_at = HOST.run_ytdlp_attempt(
                    "job", {}, "https://site.test/watch", output_dir, "video", "YouTube"
                )
                HOST.cleanup_sidecars(output_dir, ["video"], started_at)

            self.assertIsNone(result)
            self.assertIn("no valid MP4", log)
            probe.assert_not_called()
            self.assertFalse(video_only.exists())

    def test_direct_hls_failure_never_falls_back_to_page_url(self):
        targets = []

        def fail_attempt(_job_id, _message, target_url, _output_dir, _stem, _label, attempts=2):
            del attempts
            targets.append(target_url)
            return None, "fatal extractor error", time.time()

        with tempfile.TemporaryDirectory() as directory:
            message = {
                "jobId": "job:test",
                "action": "download",
                "url": "https://cdn.test/video.m3u8",
                "pageUrl": "https://site.test/watch",
                "pageTitle": "Video",
                "kind": "hls_master",
                "settings": {"outputDir": directory},
            }
            with (
                mock.patch.object(HOST, "tool_path", return_value="/tool"),
                mock.patch.object(HOST, "progress"),
                mock.patch.object(HOST, "run_ytdlp_with_retries", side_effect=fail_attempt),
            ):
                with self.assertRaises(RuntimeError):
                    HOST.run_download(message)

        self.assertEqual(targets, ["https://cdn.test/video.m3u8"])

    def test_transient_failure_gets_one_bounded_outer_retry(self):
        output = Path("/tmp/video-helper-test.mp4")
        attempts = [
            (None, "HTTP Error 503: temporary failure", 10.0),
            (output, "ok", 11.0),
        ]
        with (
            mock.patch.object(HOST, "run_ytdlp_attempt", side_effect=attempts) as runner,
            mock.patch.object(HOST, "progress"),
            mock.patch.object(HOST.time, "sleep"),
        ):
            result, _log, started_at = HOST.run_ytdlp_with_retries(
                "job", {}, "https://cdn.test/video.m3u8", Path("/tmp"), "video", "HLS"
            )
        self.assertEqual(result, output)
        self.assertEqual(started_at, 10.0)
        self.assertEqual(runner.call_count, 2)


if __name__ == "__main__":
    unittest.main()
