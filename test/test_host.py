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
    def setUp(self):
        HOST.TERMINAL_JOB_TYPES.clear()
        HOST.JOB_CONTEXT.clear()
        self.state_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.state_dir.cleanup)
        patcher = mock.patch.object(HOST, "STATE_DIR", Path(self.state_dir.name))
        patcher.start()
        self.addCleanup(patcher.stop)
        sender = mock.patch.object(HOST, "send_message")
        sender.start()
        self.addCleanup(sender.stop)

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

        self.assertIn("--no-continue", command)
        self.assertIn("--fragment-retries", command)
        self.assertIn("4", command)
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

    def test_bilibili_ffmpeg_command_merges_video_audio_with_page_headers(self):
        message = {
            "pageUrl": "https://www.bilibili.com/video/BVtest/",
            "headers": {
                "referer": "https://www.bilibili.com/video/BVtest/",
                "user-agent": "VideoHelperTest/1.0",
                "cookie": "SESSDATA=secret",
            },
        }
        with mock.patch.object(HOST, "tool_path", return_value="/tools/ffmpeg"):
            command = HOST.build_ffmpeg_dash_command(
                message,
                "https://video.example/video.m4s",
                "https://audio.example/audio.m4s",
                Path("/tmp/output.mp4"),
            )

        self.assertEqual(command.count("-i"), 2)
        self.assertIn("https://video.example/video.m4s", command)
        self.assertIn("https://audio.example/audio.m4s", command)
        self.assertIn("0:v:0", command)
        self.assertIn("1:a:0", command)
        headers = command[command.index("-headers") + 1]
        self.assertIn("Referer: https://www.bilibili.com/video/BVtest/", headers)
        self.assertIn("User-Agent: VideoHelperTest/1.0", headers)
        self.assertIn("Cookie: SESSDATA=secret", headers)
        self.assertNotIn("SESSDATA=secret", " ".join(HOST.redacted_command(command)))

    def test_bilibili_final_output_requires_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "video.mp4"
            output.write_bytes(b"0" * (128 * 1024))
            with mock.patch.object(HOST, "ffprobe_info", return_value={
                "fileSize": output.stat().st_size,
                "duration": 20,
                "width": 1280,
                "height": 720,
                "hasAudio": False,
            }):
                with self.assertRaisesRegex(RuntimeError, "没有音频"):
                    HOST.validate_final_output("job", output, require_audio=True)
            self.assertTrue(output.exists())

    def test_bilibili_direct_failure_falls_back_to_page_even_with_legacy_prefer_page_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "fallback.mp4"
            message = {
                "jobId": "job:bili-fallback",
                "action": "download",
                "url": "https://video.example/video.m4s",
                "pageUrl": "https://www.bilibili.com/video/BVtest/",
                "pageTitle": "Bilibili fallback",
                "kind": "bilibili_dash",
                "preferPageUrl": True,
                "allowPageFallback": True,
                "directMedia": {
                    "videoUrl": "https://video.example/video.m4s",
                    "audioUrl": "https://audio.example/audio.m4s",
                },
                "settings": {"outputDir": directory, "autoCookies": False},
            }
            with (
                mock.patch.object(HOST, "tool_path", return_value="/tool"),
                mock.patch.object(HOST, "progress"),
                mock.patch.object(
                    HOST,
                    "run_bilibili_dash_attempt",
                    return_value=(None, "HTTP Error 403", time.time()),
                ),
                mock.patch.object(
                    HOST,
                    "run_ytdlp_with_retries",
                    return_value=(output, "ok", time.time()),
                ) as page_runner,
                mock.patch.object(HOST, "validate_final_output", return_value=(output, {"hasAudio": True})),
                mock.patch.object(HOST, "cleanup_sidecars"),
                mock.patch.object(HOST, "complete"),
            ):
                HOST.legacy_download(message)

            self.assertEqual(page_runner.call_args.args[2], message["pageUrl"])

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

    def test_nonzero_ytdlp_exit_never_completes_even_when_mp4_is_probeable(self):
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
                with self.assertRaisesRegex(HOST.OutputValidationError, "退出码为 1"):
                    HOST.run_ytdlp_attempt("job", {}, "https://cdn.test/video.m3u8", output_dir, "video", "HLS")
            self.assertTrue(output.exists())

    def test_complete_prevents_late_native_error_for_same_job(self):
        output = Path("/tmp/verified-video.mp4")
        probe = {
            "fileSize": 209 * 1024 * 1024,
            "duration": 1200,
            "width": 1920,
            "height": 1080,
            "videoStreams": 1,
            "audioStreams": 1,
            "hasAudio": True,
            "videoCodec": "h264",
            "audioCodec": "aac",
        }
        with mock.patch.object(HOST, "send_message") as sender:
            self.assertTrue(HOST.complete("job:terminal", output, probe))
            self.assertFalse(HOST.progress("job:terminal", "late progress"))
            self.assertFalse(HOST.fail("job:terminal", "late SSL EOF"))

        self.assertEqual(sender.call_count, 1)
        message = sender.call_args.args[0]
        self.assertEqual(message["type"], "complete")
        self.assertEqual(message["outputPath"], str(output))
        self.assertTrue(message["hasAudio"])
        self.assertEqual(message["audioStreams"], 1)

    def test_nonzero_ytdlp_exit_fails_and_preserves_invalid_mp4_for_retry(self):
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
                with self.assertRaisesRegex(HOST.OutputValidationError, "退出码为 1"):
                    HOST.run_ytdlp_attempt("job", {}, "https://cdn.test/video.m3u8", output_dir, "video", "HLS")
            self.assertTrue(output.exists())

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
            self.assertTrue(video_only.exists())

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
                    HOST.legacy_download(message)

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



class NativeInputValidationTests(unittest.TestCase):
    def test_untrusted_native_commands_and_header_injection_are_rejected(self):
        for message in [[],{'action':'shell','jobId':'job:x'},
            {'action':'download','jobId':'../../outside','url':'https://example.test/a'},
            {'action':'download','jobId':'job:x','url':'https://example.test/a','headers':{'cookie':'x\r\nInjected: yes'}}]:
            with self.assertRaises(RuntimeError):HOST.validate_native_message(message)
    def test_large_native_frame_is_rejected_before_payload_read(self):
        import io,struct
        fake=type('Input',(),{'buffer':io.BytesIO(struct.pack('<I',2*1024*1024))})()
        with mock.patch.object(HOST.sys,'stdin',fake):
            with self.assertRaisesRegex(RuntimeError,'too large'):HOST.read_message()

class NativeCleanupTests(unittest.TestCase):
    def test_inactive_cleanup_preserves_unrelated_files(self):
        import hashlib,json
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);job='job:cleanup';work=root/'.darren-video-helper'/hashlib.sha256(job.encode()).hexdigest()[:32];work.mkdir(parents=True)
            (work/'checkpoint.json').write_text(json.dumps({'jobId':job,'completed':{'0:0':{}},'assets':{}}))
            (work/'segment-0-0.bin').write_bytes(b'fixture');unrelated=root/'unrelated.part';unrelated.write_bytes(b'keep')
            with mock.patch.object(HOST,'STATE_DIR',root/'state'):
                HOST.write_state(job,{'status':'attention','engine':'checkpoint-hls','workDir':str(work),'canResume':True})
                HOST.clear_inactive_data(job)
                self.assertFalse((work/'segment-0-0.bin').exists());self.assertTrue(unrelated.exists())
                self.assertFalse(HOST.read_state(job)['canResume'])


class CancellationGenerationTests(unittest.TestCase):
    def test_cancelled_generation_is_not_dispatched_after_a_late_start(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(HOST,'STATE_DIR',Path(directory)), mock.patch.object(HOST,'send_message') as sender, mock.patch.object(HOST,'guarded_download') as downloader:
            job='job:cancelled-before-start';control=HOST.state_path(job).with_suffix('.control.json')
            control.write_text('{"cancel":true,"keepData":true,"attemptId":"attempt-cancelled"}')
            HOST.handle_message({'action':'download','jobId':job,'attemptId':'attempt-cancelled','url':'https://example.test/video.mp4'})
            downloader.assert_not_called();self.assertEqual(sender.call_args.args[0]['type'],'cancelled')


class LegacyResumeTruthTests(unittest.TestCase):
    def test_legacy_task_without_verified_checkpoint_is_not_called_resumable(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(HOST,'STATE_DIR',Path(directory)/'state'), mock.patch.object(HOST,'send_message') as sender, mock.patch.object(HOST,'HlsEngine') as engine:
            job='job:legacy-proof';HOST.write_state(job,{'status':'incomplete','outputPath':str(Path(directory)/'missing.mp4'),'exitCode':1})
            HOST.run_download({'jobId':job,'kind':'hls_media','url':'https://example.test/a.m3u8','settings':{'outputDir':directory}})
            engine.assert_not_called();self.assertFalse(sender.call_args.args[0]['canResume'])
            self.assertEqual(sender.call_args.args[0]['errorCode'],'LEGACY_CHECKPOINT_MISSING')

if __name__ == "__main__":
    unittest.main()
