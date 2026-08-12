#!/usr/bin/env python3
import json
import logging
import os
import re
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path
from logging.handlers import RotatingFileHandler
from urllib.parse import urlparse, urlsplit, urlunsplit

HOST_VERSION = "1.2.0-beta.2"
DEFAULT_OUTPUT_DIR = Path.home() / "Downloads" / "video_downloads"
LOG_PATH = Path.home() / "Library" / "Logs" / "DarrenVideoHelper" / "native-host.log"
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}
SIDE_EXTENSIONS = IMAGE_EXTENSIONS | {
    ".description",
    ".json",
    ".part",
    ".temp",
    ".tmp",
    ".vtt",
    ".srt",
}
LOGGER = logging.getLogger("DarrenVideoHelper.native")


def setup_logging():
    if LOGGER.handlers:
        return
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(LOG_PATH, maxBytes=2 * 1024 * 1024, backupCount=3, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        LOGGER.addHandler(handler)
        LOGGER.setLevel(logging.INFO)
        LOGGER.propagate = False
    except OSError:
        LOGGER.addHandler(logging.NullHandler())


def redacted_url(value):
    try:
        parsed = urlsplit(str(value))
        if parsed.scheme not in ("http", "https"):
            return str(value)
        return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    except (TypeError, ValueError):
        return "<invalid-url>"


def redacted_command(command):
    result = []
    redact_next = False
    for value in command:
        text = str(value)
        if redact_next:
            result.append("<redacted>")
            redact_next = False
            continue
        result.append(redacted_url(text) if text.startswith(("http://", "https://")) else text)
        if text in ("--add-header", "--cookies", "--cookies-from-browser"):
            redact_next = True
    return result


def app_dir():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def bundled_tool_candidates(name):
    names = [name]
    if os.name == "nt" and not name.lower().endswith(".exe"):
        names.insert(0, f"{name}.exe")

    roots = [
        app_dir() / "bin",
        app_dir(),
        Path(getattr(sys, "_MEIPASS", app_dir())) / "bin",
    ]
    for root in roots:
        for item in names:
            yield root / item


class NativePipeClosed(RuntimeError):
    pass


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    if len(raw_length) != 4:
        raise RuntimeError("Invalid native messaging frame.")
    message_length = struct.unpack("<I", raw_length)[0]
    if message_length <= 0 or message_length > 64 * 1024 * 1024:
        raise RuntimeError("Native message is too large.")
    data = sys.stdin.buffer.read(message_length)
    if len(data) != message_length:
        raise RuntimeError("Incomplete native message.")
    return json.loads(data.decode("utf-8"))


def send_message(payload):
    encoded = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    try:
        sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()
    except (BrokenPipeError, OSError) as error:
        raise NativePipeClosed(str(error))


def diagnostic_details(details=""):
    items = [str(details).strip()] if details else []
    items.append(f"Native host log: {LOG_PATH}")
    return "\n".join(item for item in items if item)


def progress(job_id, message, percent=None, speed="", eta="", line="", stage="downloading"):
    payload = {
        "type": "progress",
        "jobId": job_id,
        "message": message,
        "stage": stage,
    }
    if percent is not None:
        payload["percent"] = percent
    if speed:
        payload["speed"] = speed
    if eta:
        payload["eta"] = eta
    if line:
        payload["line"] = line.rstrip()
    send_message(payload)


def complete(job_id, output_path, probe):
    send_message({
        "type": "complete",
        "jobId": job_id,
        "message": "下载完成，已输出 MP4。",
        "outputPath": str(output_path),
        "fileSize": probe.get("fileSize", 0),
        "duration": probe.get("duration", 0),
        "width": probe.get("width", 0),
        "height": probe.get("height", 0),
    })


def fail(job_id, message, reason="", details=""):
    send_message({
        "type": "error",
        "jobId": job_id,
        "message": message,
        "error": reason or message,
        "details": diagnostic_details(details or reason or message),
    })


def sanitize_filename(value):
    value = value or "video"
    value = re.sub(r"[\x00-\x1f]", " ", value)
    value = re.sub(r'[\\/:*?"<>|]+', " ", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    if not value:
        value = "video"
    return value[:150]


def validate_url(url):
    parsed = urlparse(url or "")
    if parsed.scheme not in ("http", "https"):
        raise RuntimeError("站点不支持或 yt-dlp 无法解析当前页面/视频流。")
    return url


def tool_path(name):
    for candidate in bundled_tool_candidates(name):
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)

    found = shutil.which(name)
    if found:
        return found
    for prefix in ("/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"):
        candidate = Path(prefix) / name
        if candidate.exists() and os.access(candidate, os.X_OK):
            return str(candidate)
    raise FileNotFoundError(name)


def quality_selector(quality):
    value = str(quality or "best").lower()
    if value == "best":
        return "bv*+ba/best"
    match = re.search(r"(\d{3,4})", value)
    if not match:
        return "bv*+ba/best"
    height = int(match.group(1))
    return f"bv*[height<={height}]+ba/best[height<={height}]/best"


def build_ytdlp_command(message, target_url, output_dir, output_name):
    ytdlp = tool_path("yt-dlp")
    tool_path("ffmpeg")

    url = validate_url(target_url)
    page_url = message.get("pageUrl") or ""
    headers = message.get("headers") or {}
    settings = message.get("settings") or {}
    auto_cookies = settings.get("autoCookies", True)
    selected_quality = message.get("qualityPreference") or settings.get("defaultQuality") or "best"

    command = [
        ytdlp,
        "--newline",
        "--continue",
        "--retries",
        "5",
        "--fragment-retries",
        "8",
        "--retry-sleep",
        "fragment:exp=1:10",
        "--socket-timeout",
        "20",
        "--no-write-thumbnail",
        "--no-write-info-json",
        "--no-write-playlist-metafiles",
        "--no-embed-thumbnail",
        "--no-write-description",
        "--no-write-comments",
        "--no-write-subs",
        "--no-embed-metadata",
        "--no-embed-chapters",
        "--merge-output-format",
        "mp4",
        "--remux-video",
        "mp4",
        "--referer",
        headers.get("referer") or message.get("referer") or page_url or url,
        "-f",
        quality_selector(selected_quality),
        "-P",
        str(output_dir),
        "-o",
        output_name,
    ]

    if auto_cookies:
        command.extend(["--cookies-from-browser", "chrome"])

    user_agent = headers.get("user-agent")
    if user_agent:
        command.extend(["--user-agent", user_agent])

    add_headers = []
    cookie = headers.get("cookie")
    origin = headers.get("origin")
    accept = headers.get("accept")
    accept_language = headers.get("accept-language")
    if cookie:
        add_headers.append(f"Cookie: {cookie}")
    if origin:
        add_headers.append(f"Origin: {origin}")
    if accept:
        add_headers.append(f"Accept: {accept}")
    if accept_language:
        add_headers.append(f"Accept-Language: {accept_language}")

    for header in add_headers:
        command.extend(["--add-header", header])

    command.append(url)
    return command


def matching_files(output_dir, stems, since):
    results = []
    for stem in stems:
        for path in output_dir.glob(f"{stem}*"):
            if path.is_file() and path.stat().st_mtime >= since - 2:
                results.append(path)
    return sorted(set(results), key=lambda item: item.stat().st_mtime, reverse=True)


def newest_mp4_file(output_dir, stems, since):
    for path in matching_files(output_dir, stems, since):
        if path.suffix.lower() == ".mp4":
            return path
    return None


def cleanup_sidecars(output_dir, stems, since, keep_path=None):
    keep = Path(keep_path).resolve() if keep_path else None
    for path in matching_files(output_dir, stems, since):
        try:
            resolved = path.resolve()
        except OSError:
            continue
        if keep and resolved == keep:
            continue
        lower_name = path.name.lower()
        suffix = path.suffix.lower()
        should_delete = (
            suffix in SIDE_EXTENSIONS
            or ".thumbnail." in lower_name
            or lower_name.endswith(".info.json")
            or lower_name.endswith(".description")
        )
        if should_delete:
            try:
                path.unlink()
            except OSError:
                pass


def ffprobe_info(path):
    if not path.exists() or not path.is_file():
        raise RuntimeError("输出文件不存在。")
    if path.stat().st_size < 64 * 1024:
        raise RuntimeError("输出文件过小，不能算下载成功。")
    ffprobe = tool_path("ffprobe")
    process = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
    )
    if process.returncode != 0:
        raise RuntimeError(process.stderr or process.stdout or "ffprobe failed.")

    data = json.loads(process.stdout or "{}")
    video_streams = [
        stream for stream in data.get("streams", [])
        if stream.get("codec_type") == "video"
    ]
    if not video_streams:
        raise RuntimeError("输出文件没有 video stream，不能算下载成功。")

    video = video_streams[0]
    fmt = data.get("format") or {}
    duration = float(fmt.get("duration") or video.get("duration") or 0)
    size = int(fmt.get("size") or path.stat().st_size)
    if duration <= 0.5:
        raise RuntimeError("输出文件时长无效，不能算下载成功。")
    return {
        "fileSize": size,
        "duration": duration,
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
    }


def remux_to_mp4(job_id, input_path):
    if input_path.suffix.lower() == ".mp4":
        return input_path

    ffmpeg = tool_path("ffmpeg")
    output_path = input_path.with_suffix(".mp4")
    if output_path.exists():
        output_path = input_path.with_name(f"{input_path.stem}.{int(time.time())}.mp4")

    progress(job_id, "正在用 ffmpeg 转封装为 MP4...", stage="merging")
    command = [
        ffmpeg,
        "-hide_banner",
        "-y",
        "-i",
        str(input_path),
        "-c",
        "copy",
        str(output_path),
    ]
    process = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
    )
    if process.returncode != 0:
        raise RuntimeError(classify_failure(process.stdout, fallback="ffmpeg remux failed."))

    try:
        input_path.unlink()
    except OSError:
        pass
    return output_path


def validate_final_output(job_id, output_path, expected_duration=0):
    suffix = output_path.suffix.lower()
    if suffix in IMAGE_EXTENSIONS:
        try:
            output_path.unlink()
        except OSError:
            pass
        raise RuntimeError("yt-dlp 输出的是图片，不是视频；已删除该文件。")

    output_path = remux_to_mp4(job_id, output_path)
    if output_path.suffix.lower() != ".mp4":
        raise RuntimeError("下载结果不是 MP4，已判定失败。")

    try:
        probe = ffprobe_info(output_path)
        expected = float(expected_duration or 0)
        actual = float(probe.get("duration") or 0)
        if expected >= 10 and (actual < expected * 0.4 or actual > expected * 1.6):
            raise RuntimeError(
                f"输出时长与当前视频明显不符（预期约 {expected:.1f}s，实际 {actual:.1f}s）。"
            )
        return output_path, probe
    except Exception as error:
        try:
            output_path.unlink()
        except OSError:
            pass
        raise RuntimeError(f"输出文件未通过 ffprobe 视频校验：{error}")


def classify_failure(output, fallback="下载失败。"):
    text = (output or "").lower()
    if "requested format is not available" in text:
        return "站点不支持或 yt-dlp 无法解析当前页面/视频流。"
    if (
        "ffmpeg: command not found" in text
        or "unable to execute ffmpeg" in text
        or "no such file or directory: 'ffmpeg'" in text
        or "no such file or directory: 'ffmpeg.exe'" in text
    ):
        return "yt-dlp、ffmpeg 或 ffprobe 缺失。请重新安装 Darren Video Helper。"
    if (
        "yt-dlp: command not found" in text
        or "no such file or directory: 'yt-dlp'" in text
        or "no such file or directory: 'yt-dlp.exe'" in text
    ):
        return "yt-dlp、ffmpeg 或 ffprobe 缺失。请重新安装 Darren Video Helper。"
    if "could not copy chrome cookie" in text or "failed to decrypt" in text or "cookie database" in text:
        return "cookies 读取失败。请退出 Chrome 后重试，或确认 yt-dlp 有权限读取 Chrome cookies。"
    if "403" in text or "forbidden" in text or "http error 403" in text:
        return "403/链接过期。请刷新页面、播放视频 3-5 秒后重试。"
    if "drm" in text or "widevine" in text or "license" in text or "encrypted" in text:
        return "DRM/加密流无法下载。"
    if "cookie" in text and ("expired" in text or "login" in text or "authentication" in text):
        return "cookies 读取失败或登录已过期。请重新登录、播放视频后重试。"
    if "unsupported url" in text or "no video formats" in text or "unable to extract" in text:
        return "站点不支持或 yt-dlp 无法解析当前页面/视频流。"
    return fallback


def parse_progress_line(line):
    percent = speed = eta = ""
    percent_match = re.search(r"(\d{1,3}(?:\.\d+)?)%", line)
    if percent_match:
        percent = percent_match.group(1)

    speed_match = re.search(r"\bat\s+([^\s]+/s)", line)
    if speed_match:
        speed = speed_match.group(1)

    eta_match = re.search(r"\bETA\s+([0-9:]+)", line)
    if eta_match:
        eta = eta_match.group(1)

    return percent, speed, eta


def run_ytdlp_attempt(job_id, message, target_url, output_dir, stem, label):
    output_name = f"{stem}.mp4"
    command = build_ytdlp_command(message, target_url, output_dir, output_name)
    started_at = time.time()

    progress(job_id, f"{label}：调用 yt-dlp 下载并合并为 MP4...")
    output_lines = []
    last_progress_sent = 0.0
    process = None

    try:
        LOGGER.info("job=%s yt-dlp command=%s", job_id, json.dumps(redacted_command(command), ensure_ascii=False))
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
        )
        LOGGER.info("job=%s yt-dlp started pid=%s", job_id, process.pid)

        assert process.stdout is not None
        for line in process.stdout:
            output_lines.append(line)
            sys.stderr.write(line)
            sys.stderr.flush()

            percent, speed, eta = parse_progress_line(line)
            stage = "merging" if re.search(
                r"\[(?:Merger|FixupM3u8|VideoRemuxer)\]|merging formats|remuxing video",
                line,
                re.IGNORECASE,
            ) else "downloading"
            now = time.time()
            if percent and now - last_progress_sent >= 0.5:
                last_progress_sent = now
                progress(
                    job_id,
                    f"下载中... {percent}%",
                    percent=percent,
                    speed=speed,
                    eta=eta,
                    line=line,
                    stage=stage,
                )
            elif now - last_progress_sent >= 1.8:
                last_progress_sent = now
                progress(
                    job_id,
                    line.strip()[:240] or "yt-dlp 正在处理...",
                    line=line,
                    stage=stage,
                )

        return_code = process.wait()
        LOGGER.info("job=%s yt-dlp exited code=%s", job_id, return_code)
    except NativePipeClosed:
        LOGGER.warning("job=%s native pipe closed while yt-dlp was running", job_id)
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        raise

    combined_output = "".join(output_lines)
    if return_code != 0:
        return None, combined_output, started_at

    output_path = newest_mp4_file(output_dir, [stem], started_at)
    if not output_path:
        created = matching_files(output_dir, [stem], started_at)
        for path in created:
            if path.suffix.lower() in IMAGE_EXTENSIONS:
                try:
                    path.unlink()
                except OSError:
                    pass
        return None, combined_output + "\nDownload finished, but no MP4 video output was found.", started_at

    return output_path, combined_output, started_at


def is_retryable_failure(output):
    text = (output or "").lower()
    return any(marker in text for marker in (
        "timed out",
        "timeout",
        "connection reset",
        "remote end closed",
        "temporary failure",
        "http error 429",
        "http error 500",
        "http error 502",
        "http error 503",
        "http error 504",
        "unable to download video data",
        "fragment",
    ))


def run_ytdlp_with_retries(job_id, message, target_url, output_dir, stem, label, attempts=2):
    combined = []
    earliest_started_at = time.time()
    for attempt in range(1, max(1, attempts) + 1):
        attempt_label = label if attempts == 1 else f"{label}（尝试 {attempt}/{attempts}）"
        output_path, output, started_at = run_ytdlp_attempt(
            job_id,
            message,
            target_url,
            output_dir,
            stem,
            attempt_label,
        )
        earliest_started_at = min(earliest_started_at, started_at)
        combined.append(output)
        if output_path:
            return output_path, "\n".join(combined), earliest_started_at
        if attempt >= attempts or not is_retryable_failure(output):
            break
        progress(job_id, f"网络或 HLS 分片暂时失败，准备重试 {attempt + 1}/{attempts}...")
        time.sleep(min(2, attempt))
    return None, "\n".join(combined), earliest_started_at


def run_download(message):
    job_id = message.get("jobId") or "job"
    settings = message.get("settings") or {}
    output_dir = Path(os.path.expanduser(settings.get("outputDir") or message.get("outputDir") or DEFAULT_OUTPUT_DIR))
    output_dir.mkdir(parents=True, exist_ok=True)
    LOGGER.info(
        "job=%s download start kind=%s page=%s resource=%s output=%s",
        job_id,
        message.get("kind") or "",
        redacted_url(message.get("pageUrl") or ""),
        redacted_url(message.get("url") or ""),
        output_dir,
    )

    page_title = message.get("pageTitle") or message.get("sourceTitle") or "video"
    stem = sanitize_filename(page_title)
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    job_suffix = sanitize_filename(job_id).replace("job ", "").replace("job:", "")[:8]
    stem = f"{stem} {timestamp} {job_suffix}".strip()

    progress(job_id, "Checking yt-dlp, ffmpeg and ffprobe...")
    tool_path("yt-dlp")
    tool_path("ffmpeg")
    tool_path("ffprobe")

    stream_url = validate_url(message.get("url"))
    page_url = message.get("pageUrl") or ""
    kind = message.get("kind") or ""
    prefer_page = bool(message.get("preferPageUrl"))

    output_path = None
    first_output = ""
    first_started_at = time.time()
    first_target = page_url if (prefer_page or kind == "segment") and page_url else stream_url
    output_path, first_output, first_started_at = run_ytdlp_with_retries(
        job_id,
        message,
        first_target,
        output_dir,
        stem,
        "第一步"
    )

    used_stems = [stem]
    allow_page_fallback = message.get("allowPageFallback") is True
    if not output_path and allow_page_fallback and page_url and page_url != first_target:
        progress(job_id, "视频流 URL 失败，回退使用当前页面 URL...")
        fallback_stem = f"{stem} page"
        used_stems.append(fallback_stem)
        output_path, second_output, second_started_at = run_ytdlp_with_retries(
            job_id,
            message,
            page_url,
            output_dir,
            fallback_stem,
            "回退"
        )
        first_output = first_output + "\n" + second_output
        if output_path:
            stem = fallback_stem
            first_started_at = min(first_started_at, second_started_at)
        else:
            cleanup_sidecars(output_dir, used_stems, first_started_at)
            raise RuntimeError(classify_failure(second_output, fallback=classify_failure(first_output)) + "\n\n" + first_output[-8000:])

    if not output_path:
        cleanup_sidecars(output_dir, used_stems, first_started_at)
        raise RuntimeError(classify_failure(first_output) + "\n\n" + first_output[-8000:])

    output_path, probe = validate_final_output(
        job_id,
        output_path,
        expected_duration=message.get("expectedDuration") or 0,
    )
    cleanup_sidecars(output_dir, used_stems, first_started_at, keep_path=output_path)
    complete(job_id, output_path, probe)
    LOGGER.info("job=%s completed output=%s size=%s", job_id, output_path, probe.get("fileSize", 0))


def handle_message(message):
    job_id = message.get("jobId") or "job"
    action = message.get("action")
    LOGGER.info("received action=%s job=%s", action or "", job_id)
    try:
        if action == "ping":
            send_message({
                "type": "pong",
                "jobId": job_id,
                "ok": True,
                "version": HOST_VERSION,
                "logPath": str(LOG_PATH),
            })
            return True
        if action != "download":
            raise RuntimeError("Unknown native host action.")
        run_download(message)
        return True
    except NativePipeClosed:
        LOGGER.warning("job=%s response pipe closed", job_id)
        return False
    except FileNotFoundError as error:
        missing = str(error)
        LOGGER.exception("job=%s required tool missing: %s", job_id, missing)
        if missing in ("yt-dlp", "ffmpeg", "ffprobe"):
            fail(job_id, "yt-dlp、ffmpeg 或 ffprobe 缺失。请重新安装 Darren Video Helper。", details=missing)
        else:
            fail(job_id, f"内置下载工具缺失：{missing}", details=missing)
        return True
    except Exception as error:
        message_text = str(error)
        LOGGER.exception("job=%s failed: %s", job_id, message_text.split("\n", 1)[0])
        fail(
            job_id,
            classify_failure(message_text, fallback=message_text.split("\n", 1)[0]),
            details=message_text,
        )
        return True


def main():
    setup_logging()
    LOGGER.info(
        "host start version=%s pid=%s ppid=%s executable=%s frozen=%s cwd=%s",
        HOST_VERSION,
        os.getpid(),
        os.getppid(),
        sys.executable,
        bool(getattr(sys, "frozen", False)),
        os.getcwd(),
    )
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        print(json.dumps({
            "ok": True,
            "version": HOST_VERSION,
            "yt-dlp": tool_path("yt-dlp"),
            "ffmpeg": tool_path("ffmpeg"),
            "ffprobe": tool_path("ffprobe"),
            "outputDir": str(DEFAULT_OUTPUT_DIR),
            "logPath": str(LOG_PATH),
        }))
        LOGGER.info("host exit reason=self-test")
        return

    try:
        while True:
            message = read_message()
            if not message:
                LOGGER.info("host exit reason=stdin-eof")
                return
            if not handle_message(message):
                LOGGER.info("host exit reason=response-pipe-closed")
                return
    except Exception as error:
        LOGGER.exception("host fatal framing error: %s", error)
        LOGGER.info("host exit reason=fatal-framing-error")


if __name__ == "__main__":
    main()
