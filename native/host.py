#!/usr/bin/env python3
import hashlib
import math
import signal
from contextlib import contextmanager
import json
import logging
import os
import queue
import re
import select
import shutil
import struct
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from logging.handlers import RotatingFileHandler
from urllib.parse import urlparse, urlsplit, urlunsplit, parse_qsl

HOST_VERSION = "1.2.1-beta.18"
DEFAULT_OUTPUT_DIR = Path.home() / "Downloads" / "video_downloads"
LOG_PATH = Path(os.environ.get("VIDEO_HELPER_LOG_PATH") or Path.home() / "Library/Logs/DarrenVideoHelper/native-host.log")
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
TERMINAL_JOB_TYPES = {}
JOB_CONTEXT = {}
TOOL_CACHE = {}
TOOL_VERSIONS = {}
DOWNLOAD_IDLE_TIMEOUT = 90
NATIVE_INPUT = None
STATE_DIR = Path(os.environ.get("VIDEO_HELPER_STATE_DIR") or Path.home() / "Library/Application Support/DarrenVideoHelper/jobs")


sys.path.insert(0, str(Path(__file__).resolve().parent))
from hls_engine import Engine as HlsEngine, HlsError, Cancelled as HlsCancelled, safe_directory, safe_title, sha_file, atomic_json, remote_url

class OutputValidationError(RuntimeError):
    pass


class OutputValidationTimeout(OutputValidationError):
    pass


class DownloadTimedOut(RuntimeError):
    pass


class JobBusy(RuntimeError):
    pass


def state_path(job_id):
    return STATE_DIR / (hashlib.sha256(job_id.encode()).hexdigest() + ".json")


def read_state(job_id):
    try:
        return json.loads(state_path(job_id).read_text())
    except (OSError, ValueError):
        return {}


def write_state(job_id, patch):
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    saved = read_state(job_id)
    if saved.get("status") == "completed" and patch.get("status", "completed") != "completed":
        LOGGER.info("job=%s IGNORED_STALE_TERMINAL_UPDATE COMPLETED -> %s attempt=%s",
                    job_id, patch.get("status"), patch.get("attemptId"))
        return saved
    incoming_attempt = patch.get("attemptId")
    current_attempt = saved.get("currentAttemptId")
    if (incoming_attempt and current_attempt and incoming_attempt != current_attempt
            and patch.get("status") != "completed"):
        LOGGER.info("job=%s ignored stale callback attempt=%s currentAttempt=%s status=%s",
                    job_id, incoming_attempt, current_attempt, patch.get("status"))
        return saved
    saved.update(patch)
    saved.update(jobId=job_id, updatedAt=time.time())
    target = state_path(job_id)
    temporary = target.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(saved, ensure_ascii=False))
    temporary.chmod(0o600)
    os.replace(temporary, target)
    return saved


@contextmanager
def job_lock(job_id):
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = state_path(job_id).with_suffix(".lock").open("a+b")
    try:
        try:
            if os.name == "nt":
                import msvcrt
                lock.seek(0); lock.write(b"0"); lock.flush(); lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise JobBusy("同一任务仍在运行，未启动第二个下载进程。") from error
        yield
    finally:
        lock.close()


def emit_event(payload, notify=True):
    job_id = payload.get("jobId")
    context = JOB_CONTEXT.get(job_id, {})
    payload.setdefault("attemptId", context.get("attemptId", ""))
    event = payload.get("event") or payload.get("type")
    states = {"download_started": "downloading", "finalizing": "finalizing",
              "completed": "completed", "failed": "failed", "incomplete": "incomplete"}
    if job_id and event in states:
        if states[event] in ("completed", "failed", "incomplete"):
            payload["exitCode"] = read_state(job_id).get("exitCode")
            with job_log(job_id) as record:
                record(event, message=redacted_output(payload.get("message", "")),
                       error=redacted_output(payload.get("error", "")))
        saved = write_state(job_id, {**payload, "status": states[event]})
        LOGGER.info("job=%s attempt=%s terminal_transition=%s basename=%s", job_id,
                    payload.get("attemptId"), states[event], Path(saved.get("outputPath") or "").name)
    if notify:
        send_message(payload)


def incomplete(job_id, message, details=""):
    if job_id in TERMINAL_JOB_TYPES:
        return
    emit_event({"type": "incomplete", "event": "incomplete", "jobId": job_id,
                "message": message, "error": message, "details": diagnostic_details(details or message),
                "retryable": True, "canResume": False, "validationPending": bool(read_state(job_id).get("validationPending"))})
    TERMINAL_JOB_TYPES[job_id] = "incomplete"


def stop_process(process):
    if process and process.poll() is None:
        try:
            if os.name != "nt":
                os.killpg(process.pid, signal.SIGTERM)
            else:
                process.terminate()
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                if os.name != "nt":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
            except ProcessLookupError:
                pass
            process.wait()



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
        return urlunsplit((parsed.scheme, parsed.netloc.rsplit("@", 1)[-1], parsed.path, "", ""))
    except (TypeError, ValueError):
        return "<invalid-url>"


def redacted_output(line):
    # yt-dlp can echo the full signed URL even when the command log is redacted.
    text = re.sub(r"https?://[^\s\"<>]+", lambda match: redacted_url(match.group(0)), str(line))
    return re.sub(r"(?i)((?:cookie|authorization)\s*:\s*)[^\r\n]+", r"\1<redacted>", text)


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
        if text in ("--add-header", "--cookies", "--cookies-from-browser", "-headers", "-f"):
            redact_next = True
    return result


def app_dir():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def bundled_tool_candidates(name):
    if os.environ.get("VIDEO_HELPER_EXTERNAL_TOOLS") == "1":
        return
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
    if message_length <= 0 or message_length > 1024 * 1024:
        raise RuntimeError("Native message is too large.")
    data = sys.stdin.buffer.read(message_length)
    if len(data) != message_length:
        raise RuntimeError("Incomplete native message.")
    message = json.loads(data.decode("utf-8"))
    if not isinstance(message, dict): raise RuntimeError("Native message must be an object")
    return message


def send_message(payload):
    encoded = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    try:
        sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()
    except (BrokenPipeError, OSError) as error:
        raise NativePipeClosed(str(error))


def job_log_path(job_id):
    return state_path(job_id).with_suffix(".jsonl")


@contextmanager
def job_log(job_id):
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(job_log_path(job_id), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8", buffering=1) as log:
        def record(event, **fields):
            log.write(json.dumps({"time": time.time(), "event": event,
                                  "attemptId": JOB_CONTEXT.get(job_id, {}).get("attemptId", ""),
                                  **fields}, ensure_ascii=False) + "\n")
        yield record


def diagnostic_page(job_id, offset):
    try:
        with job_log_path(job_id).open(encoding="utf-8") as log:
            log.seek(offset)
            data = log.read(32 * 1024)
            return {"data": data, "offset": log.tell(), "done": not log.read(1)}
    except FileNotFoundError:
        return {"data": "", "offset": 0, "done": True}


def diagnostic_details(details=""):
    items = [str(details).strip()] if details else []
    items.append(f"Native host log: {LOG_PATH}")
    return "\n".join(item for item in items if item)


def progress(job_id, message, percent=None, speed="", eta="", line="", stage="downloading"):
    if job_id in TERMINAL_JOB_TYPES:
        LOGGER.info(
            "job=%s ignored late progress after terminal=%s",
            job_id,
            TERMINAL_JOB_TYPES[job_id],
        )
        return False
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
    emit_event(payload)
    return True


def complete(job_id, output_path, probe, notify=True):
    if JOB_CONTEXT.get(job_id, {}).get("publishRoot"):
        output_path = publish_legacy_output(job_id, output_path, probe)
    if job_id in TERMINAL_JOB_TYPES:
        LOGGER.info(
            "job=%s ignored duplicate complete after terminal=%s",
            job_id,
            TERMINAL_JOB_TYPES[job_id],
        )
        return False
    emit_event({
        "type": "complete",
        "event": "completed",
        "jobId": job_id,
        "message": "下载完成，已输出 MP4。",
        "outputPath": str(output_path),
        "fileSize": probe.get("fileSize", 0),
        "duration": probe.get("duration", 0),
        "width": probe.get("width", 0),
        "height": probe.get("height", 0),
        "videoStreams": probe.get("videoStreams", 0),
        "audioStreams": probe.get("audioStreams", 0),
        "hasAudio": probe.get("hasAudio", False),
        "videoCodec": probe.get("videoCodec", ""),
        "audioCodec": probe.get("audioCodec", ""),
        "fragmentsDone": probe.get("fragmentsDone", 0),
        "fragmentsTotal": probe.get("fragmentsTotal", 0),
        "integrityVerified": True,
        "canResume": False,
        "phase": "completed",
        "warningCount": probe.get("warningCount", 0),
        "warnings": probe.get("warnings", []),
        "unverifiedOutput": False,
        "validationPending": False,
        "error": "",
        "details": "",
    }, notify=notify)
    TERMINAL_JOB_TYPES[job_id] = "complete"
    LOGGER.info("JOB_TERMINAL: job=%s -> COMPLETED attempt=%s", job_id,
                JOB_CONTEXT.get(job_id, {}).get("attemptId"))
    return True


def fail(job_id, message, reason="", details=""):
    if job_id in TERMINAL_JOB_TYPES:
        LOGGER.info(
            "job=%s ignored late error after terminal=%s error=%s",
            job_id,
            TERMINAL_JOB_TYPES[job_id],
            str(reason or message).split("\n", 1)[0],
        )
        return False
    emit_event({
        "type": "error",
        "event": "failed",
        "jobId": job_id,
        "message": message,
        "error": reason or message,
        "details": diagnostic_details(details or reason or message),
    })
    TERMINAL_JOB_TYPES[job_id] = "error"
    LOGGER.info("JOB_TERMINAL: job=%s -> FAILED attempt=%s", job_id,
                JOB_CONTEXT.get(job_id, {}).get("attemptId"))
    return True


def sanitize_filename(value):
    value = value or "video"
    value = re.sub(r"[\x00-\x1f]", " ", value)
    value = re.sub(r'[\\/:*?"<>|]+', " ", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    if not value:
        value = "video"
    return value.encode("utf-8")[:180].decode("utf-8", errors="ignore")


def validate_url(url):
    parsed = urlparse(url or "")
    if parsed.scheme not in ("http", "https"):
        raise RuntimeError("站点不支持或 yt-dlp 无法解析当前页面/视频流。")
    return url


def tool_path(name):
    if name in TOOL_CACHE:
        return TOOL_CACHE[name]
    candidates = []
    if name == "yt-dlp" and os.environ.get("VIDEO_HELPER_YTDLP_PATH"):
        candidates.append(Path(os.environ["VIDEO_HELPER_YTDLP_PATH"]))
    candidates += list(bundled_tool_candidates(name))
    found = shutil.which(name)
    if found:
        candidates.append(Path(found))
    candidates += [Path(prefix) / name for prefix in ("/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin")]
    for candidate in dict.fromkeys(candidates):
        if not candidate.is_file() or not os.access(candidate, os.X_OK):
            continue
        try:
            check = subprocess.run([str(candidate), "-version" if name in ("ffmpeg", "ffprobe") else "--version"],
                                   capture_output=True, timeout=15)
            if check.returncode != 0:
                LOGGER.warning("tool=%s unusable candidate=%s exit=%s", name, candidate, check.returncode)
                continue
        except (OSError, subprocess.TimeoutExpired):
            continue
        TOOL_CACHE[name] = str(candidate)
        output = getattr(check, "stdout", None)
        TOOL_VERSIONS[name] = output.decode(errors="replace").splitlines()[0] if output and isinstance(output, bytes) else ""
        LOGGER.info("tool=%s verified path=%s version=%s", name, candidate, TOOL_VERSIONS[name])
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
    direct_media = message.get("kind") in ("hls_master", "hls_media", "mp4", "webm")
    auto_cookies = settings.get("autoCookies", False) is True and not direct_media and not headers.get("cookie")
    selected_quality = message.get("qualityPreference") or settings.get("defaultQuality") or "best"
    selector = quality_selector(selected_quality)
    if message.get("renditionUrl"):
        url_value = validate_url(message["renditionUrl"]).replace('"', '%22')
        video = f'bv*[url="{url_value}"]'
        audio_value = validate_url(message["renditionAudioUrl"]).replace('"', '%22')
        selector = f'{video}+ba[url="{audio_value}"]'

    command = [
        ytdlp,
        "--ignore-config",
        "--newline",
        "--ffmpeg-location",
        tool_path("ffmpeg"),
        "--no-playlist",
        "--no-continue",
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
        selector,
        "-P",
        str(output_dir),
        "-P",
        f"temp:{job_temp_dir(output_dir, Path(output_name).stem)}",
        "-o",
        output_name.replace("%", "%%"),
    ]

    command.append("--abort-on-unavailable-fragments")
    settings = message.get("settings") or {}
    retries = max(0, min(8, int(settings.get("networkRetries", 4))))
    timeout = max(2, min(60, int(settings.get("networkTimeout", 20))))
    command[command.index("--retries") + 1] = str(retries)
    command[command.index("--fragment-retries") + 1] = str(retries)
    command[command.index("--socket-timeout") + 1] = str(timeout)
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
        add_headers.append(f"Cookie: {clean_header_value(cookie)}")
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
    # Literal matching: titles may contain [brackets], which are glob syntax.
    return [p for p in output_dir.iterdir() if p.is_file() and not p.is_symlink()
            and any(p.name == stem + ".mp4" or p.name.startswith(stem + ".") for stem in stems)]


def exact_mp4_file(output_dir, stem, since):
    # Ownership comes from the fixed job ledger, never filesystem mtime.
    path = output_dir / f"{stem}.mp4"
    return path if path.is_file() and not path.is_symlink() else None


def job_temp_dir(output_dir, stem):
    return output_dir / ".darren-video-helper" / hashlib.sha256(stem.encode()).hexdigest()[:24]


def resume_sidecar(suffix):
    return re.fullmatch(r"(?:\.f[\w-]+)?\.(?:mp4|m4a|webm)\.(?:part|ytdl)", suffix)


def cleanup_sidecars(output_dir, stems, since, keep_path=None, discard_resume=False):
    removed = []
    for stem in set(stems):
        temp = job_temp_dir(output_dir, stem)
        candidates = matching_files(output_dir, [stem], since)
        if temp.is_dir() and not temp.is_symlink() and not temp.parent.is_symlink():
            candidates.extend(matching_files(temp, [stem], since))
        for path in candidates:
            suffix = path.name[len(stem):]
            fragment = re.fullmatch(r"(?:\.f[\w-]+)?\.(?:mp4|m4a|webm)\.part-Frag\d+(?:\.part)?", suffix)
            success_temp = resume_sidecar(suffix) or re.fullmatch(r"(?:\.f[\w-]+)?\.(?:mp4|m4a|webm)\.(?:temp|tmp)", suffix)
            intermediate = re.fullmatch(r"\.f[\w-]+\.(?:mp4|m4a|webm)", suffix)
            disposable = success_temp or intermediate or suffix == ".temp.mp4" or (path.parent == temp and suffix == ".mp4")
            if not (fragment or ((keep_path or discard_resume) and disposable)):
                continue
            try:
                path.unlink()
                removed.append(path.name)
            except OSError as error:
                LOGGER.warning("cleanup failed basename=%s error=%s", path.name, error)
        if not temp.parent.is_symlink():
            for folder in (temp, temp.parent):
                try:
                    folder.rmdir()
                except OSError:
                    pass
    LOGGER.info("cleanup stems=%s success=%s removed=%s", stems, bool(keep_path), removed)
    return removed


def ffprobe_info(path):
    if not path.is_file() or path.is_symlink():
        raise RuntimeError("输出文件不存在或不是普通文件。")
    if path.stat().st_size < 32:
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
            "-show_packets",
            "-show_entries",
            "packet=stream_index",
            "-read_intervals",
            "%+#128",
            str(path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        timeout=60,
    )
    if process.returncode != 0 or process.stderr.strip():
        raise RuntimeError(process.stderr or process.stdout or "ffprobe failed.")

    data = json.loads(process.stdout or "{}")
    video_streams = [
        stream for stream in data.get("streams", [])
        if stream.get("codec_type") == "video" and not stream.get("disposition", {}).get("attached_pic")
    ]
    if not video_streams:
        raise RuntimeError("输出文件没有 video stream，不能算下载成功。")

    video = video_streams[0]
    if not any(packet.get("stream_index") == video.get("index") for packet in data.get("packets", [])):
        raise RuntimeError("MP4 开头没有可读取的视频数据。")
    audio_streams = [
        stream for stream in data.get("streams", [])
        if stream.get("codec_type") == "audio"
    ]
    fmt = data.get("format") or {}
    if not any(x in (fmt.get("format_name") or "").split(",") for x in ("mov", "mp4")):
        raise RuntimeError("输出容器不是已封装的 MP4。")
    duration = float(fmt.get("duration") or video.get("duration") or 0)
    size = int(fmt.get("size") or path.stat().st_size)
    if duration <= 0.5:
        raise RuntimeError("输出文件时长无效，不能算下载成功。")
    return {
        "fileSize": size,
        "duration": duration,
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "videoStreams": len(video_streams),
        "audioStreams": len(audio_streams),
        "hasAudio": bool(audio_streams),
        "videoCodec": str(video.get("codec_name") or ""),
        "audioCodec": str(audio_streams[0].get("codec_name") or "") if audio_streams else "",
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


def requires_audio(message):
    return bool(message.get("renditionAudioUrl") or message.get("kind") == "bilibili_dash")


def verify_video_decode(job_id, path, duration):
    ffmpeg = tool_path("ffmpeg")
    positions = (0, max(0, duration - min(3, duration * 0.2))) if duration >= 10 else (0,)
    with job_log(job_id) as record:
        for position in positions:
            command = [ffmpeg, "-v", "error", "-xerror", "-nostdin", "-threads", "2",
                       "-an", "-sn", "-dn", "-ss", str(position), "-i", str(path),
                       "-map", "0:V:0", "-frames:v", "1", "-progress", "pipe:1", "-f", "null", "-"]
            for timeout in (15, 45):
                try:
                    checked = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True,
                                             text=True, errors="replace", timeout=timeout)
                except subprocess.TimeoutExpired:
                    record("decode_timeout", position=position, seconds=timeout)
                    if timeout == 45:
                        raise OutputValidationTimeout(f"成品已保存，FFmpeg 在 {position:.1f}s 取样两次超时。可重新校验。")
                    continue
                record("decode_sample", position=position, exitCode=checked.returncode,
                       stderr=redacted_output(checked.stderr))
                if checked.returncode or not re.search(r"^frame=\s*1\s*$", checked.stdout, re.M):
                    raise RuntimeError(checked.stderr.strip() or f"无法解码 {position:.1f}s 的视频帧。")
                break


def legacy_decode_timeout(error):
    return "成品视频解码失败" in error and "timed out after 45 seconds" in error


def verify_saved_output(job_id, saved, notify=True):
    legacy_timeout = saved.get("verifyDecode") and legacy_decode_timeout(saved.get("error") or "")
    if not saved.get("outputPath") or not (saved.get("validationPending") or legacy_timeout):
        return False
    target = Path(saved["outputPath"])
    if target.suffix.lower() != ".mp4" or not target.parent.is_dir():
        return False
    existing = exact_mp4_file(target.parent, target.stem, 0)
    exit_code = saved.get("exitCode")
    if not existing and legacy_timeout and job_log_path(job_id).is_file():
        # Older retries renamed the verifiable MP4 before starting another download.
        prefix = target.stem + ".unverified-"
        archives = [path for path in target.parent.iterdir()
                    if path.name.startswith(prefix) and re.fullmatch(r"\d+\.mp4", path.name[len(prefix):])
                    and path.is_file() and not path.is_symlink()]
        # Multiple retained outputs are ambiguous. Leave them all available to the user.
        if len(archives) == 1:
            existing = archives[0]
            with job_log_path(job_id).open(encoding="utf-8") as log:
                successful = set()
                for line in log:
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    attempt = entry.get("attemptId")
                    if entry.get("event") == "process_exit" and entry.get("exitCode") == 0:
                        successful.add(attempt)
                    if attempt in successful and entry.get("event") == "incomplete" and legacy_decode_timeout(entry.get("error") or ""):
                        exit_code = 0
                        break

    if not existing or (saved.get("verifyDecode") and exit_code != 0):
        return False

    if notify:
        emit_event({"type": "finalizing", "jobId": job_id, "message": "正在重新校验已下载的 MP4…", "outputPath": str(target)})
    _, probe = validate_final_output(job_id, existing, saved.get("expectedDuration"), saved.get("requireAudio"),
                                     saved.get("enforceDuration", False), saved.get("expectedHeight", 0),
                                     saved.get("verifyDecode", False))
    if existing != target:
        os.link(existing, target)
        existing.unlink()
    cleanup_sidecars(target.parent, [target.stem], 0, keep_path=target)
    write_state(job_id, {"exitCode": exit_code})
    complete(job_id, target, probe, notify=notify)
    return True


def recover_legacy_outputs():
    recovered = 0
    for ledger in STATE_DIR.glob("*.json"):
        if not re.fullmatch(r"[0-9a-f]{64}\.json", ledger.name) or ledger.is_symlink():
            continue
        try:
            saved = json.loads(ledger.read_text())
            if not isinstance(saved, dict):
                continue
            job_id = saved.get("jobId")
            if not job_id or state_path(job_id) != ledger or not legacy_decode_timeout(saved.get("error") or ""):
                continue
            with job_lock(job_id):
                saved = read_state(job_id)
                if saved.get("status") == "incomplete" and verify_saved_output(job_id, saved, notify=False):
                    print(f"Recovered verified MP4: {saved['outputPath']}")
                    recovered += 1
        except (OSError, ValueError, JobBusy, OutputValidationError) as error:
            LOGGER.warning("Skipped legacy recovery ledger=%s: %s", ledger.name, error)
    if recovered:
        print(f"Recovered {recovered} download(s) from earlier validation timeouts.")


def validate_final_output(job_id, output_path, expected_duration=0, require_audio=False, enforce_duration=False, expected_height=0, verify_decode=False):
    # Never delete a final artifact on validation/tool failure.
    if output_path.suffix.lower() != ".mp4":
        raise OutputValidationError("下载结果不是最终 MP4，文件已保留。")
    try:
        probe = ffprobe_info(output_path)
    except subprocess.TimeoutExpired as error:
        write_state(job_id, {"validationPending": True})
        raise OutputValidationTimeout("成品已保存，ffprobe 读取超时。可重新校验。") from error
    except Exception as error:
        if output_path.is_file():
            write_state(job_id, {"unverifiedOutput": True, "validationPending": False})
        raise OutputValidationError(f"MP4 校验未通过，文件已保留；请检查 ffprobe/文件：{error}") from error
    if require_audio and not probe.get("hasAudio"):
        write_state(job_id, {"unverifiedOutput": True, "validationPending": False})
        raise OutputValidationError("成品没有音频，文件已保留。")
    if expected_height and probe.get("height") != expected_height:
        write_state(job_id, {"unverifiedOutput": True, "validationPending": False})
        raise OutputValidationError(f"成品高度 {probe.get('height', 0)}p 与所选资源 {expected_height}p 不符，文件已保留。")
    expected = float(expected_duration or 0)
    actual = float(probe.get("duration") or 0)
    warnings = []
    if enforce_duration and expected > 0 and abs(actual - expected) > max(1, min(3, expected * 0.01)):
        write_state(job_id, {"unverifiedOutput": True, "validationPending": False})
        raise OutputValidationError(f"成品时长 {actual:.1f}s 与选定资源 {expected:.1f}s 不符，文件已保留。")
    if expected > 0 and abs(actual - expected) > max(5, expected * 0.08):
        warning = f"网页时长与最终 MP4 不一致（网页 {expected:.1f}s，成品 {actual:.1f}s）；以 ffprobe 成品校验为准。"
        warnings.append(warning)
        LOGGER.warning("job=%s completed_with_warning duration_mismatch expected=%s actual=%s",
                       job_id, expected, actual)
    if verify_decode:
        try:
            verify_video_decode(job_id, output_path, actual)
        except OutputValidationTimeout:
            write_state(job_id, {"validationPending": True})
            raise
        except OSError as error:
            write_state(job_id, {"validationPending": True})
            raise OutputValidationTimeout("成品已保存，FFmpeg 无法启动。请检查安装后重新校验。") from error
        except RuntimeError as error:
            write_state(job_id, {"unverifiedOutput": True, "validationPending": False})
            raise OutputValidationError(f"成品视频解码失败，文件已保留。{error}") from error
    probe["warnings"] = warnings
    probe["warningCount"] = len(warnings)
    LOGGER.info("job=%s final_exists=true basename=%s size=%s ffprobe=ok duration=%s expected=%s",
                job_id, output_path.name, probe.get("fileSize"), actual, expected)
    return output_path, probe


def cookie_store_failed(output):
    return bool(re.search(
        r"(?im)^ERROR:.*(?:cookies? database|could not copy chrome cookie|failed to decrypt|CookieLoadError)",
        output or "",
    ))


def http_failure_status(output):
    failures = re.findall(r"(?:HTTP(?: Error)?[ :]+|server returned[ :]+)([45]\d\d)\b", output or "", re.I)
    return int(failures[-1]) if failures else None


def classify_failure(output, fallback="下载失败。"):
    output = output or ""
    errors = [line.strip() for line in output.splitlines() if line.lstrip().startswith("ERROR:")]
    text = "\n".join(errors).lower() if errors else output.lower()
    if cookie_store_failed(output):
        return "本地助手无法读取 Chrome Cookie 数据库。请在原页面重新播放后重试。"
    if re.search(r"\bdrm(?:[- ]protected)?\b|widevine|fairplay|playready|unsupported encryption", text):
        return "此媒体使用 DRM 或不受支持的加密，无法下载。"
    status = http_failure_status(text)
    http_messages = {
        401: "服务器要求授权（HTTP 401）。请确认你能在原页面播放该视频。",
        403: "服务器拒绝媒体请求（HTTP 403）。请确认播放权限及当前链接是否仍有效。",
        404: "服务器找不到媒体资源（HTTP 404）。请重新播放并检测。",
        410: "媒体链接已过期（HTTP 410）。请重新播放并检测。",
        429: "服务器限制请求频率（HTTP 429）。请稍后重试。",
    }
    if status:
        return http_messages.get(status, f"媒体服务器请求失败（HTTP {status}）。")
    if re.search(r"timed out|timeout|connection reset|remote end closed|connection refused|"
                 r"temporary failure|name resolution|nodename nor servname|network is unreachable", text):
        return "网络连接失败或超时，请稍后重试。"
    if any(marker in text for marker in ("ffmpeg: command not found", "unable to execute ffmpeg", "no such file or directory: 'ffmpeg")):
        return "ffmpeg 无法运行，请检查本地安装。"
    if any(marker in text for marker in ("requested format is not available", "unsupported url", "no video formats", "unable to extract")):
        return "yt-dlp 无法解析当前视频流或所选格式。"
    if errors:
        return errors[-1][:360]
    exit_code = re.search(r"yt-dlp exited with code (-?\d+)", output)
    if exit_code:
        return f"yt-dlp 退出（退出码 {exit_code.group(1)}），未生成有效的 MP4。"
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
    expected_output_path = output_dir / output_name
    command = build_ytdlp_command(message, target_url, output_dir, output_name)
    temp = job_temp_dir(output_dir, stem)
    if temp.is_symlink() or temp.parent.is_symlink():
        raise OSError("下载临时目录是符号链接。")
    temp.mkdir(parents=True, exist_ok=True, mode=0o700)
    for path in matching_files(output_dir, [stem], 0):
        destination = temp / path.name
        if resume_sidecar(path.name[len(stem):]) and not (destination.exists() or destination.is_symlink()):
            path.rename(destination)
    started_at = time.time()

    progress(job_id, f"{label}：调用 yt-dlp 下载并合并为 MP4...")
    output_lines = []
    last_progress_sent = 0.0
    process = None

    return_code = None
    pending = queue.Queue(maxsize=512)
    readers_stop = threading.Event()
    readers = []
    with job_log(job_id) as record:
        record("process_start", command=redacted_command(command), toolVersions=TOOL_VERSIONS)
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
                start_new_session=(os.name != "nt"),
            )
            LOGGER.info("job=%s yt-dlp started pid=%s", job_id, process.pid)

            def offer(item):
                while not readers_stop.is_set():
                    try: pending.put(item, timeout=0.1); return True
                    except queue.Full: continue
                return False
            def drain(source, pipe):
                try:
                    for line in pipe:
                        if not offer((source,line)): break
                finally:
                    if hasattr(pipe, "close"): pipe.close()
                    offer((source,None))

            pipes = {"stdout": process.stdout, "stderr": getattr(process, "stderr", None)}
            active = {source for source, pipe in pipes.items() if pipe is not None}
            readers = [threading.Thread(target=drain, args=(source, pipes[source]), daemon=True) for source in active]
            for reader in readers:
                reader.start()

            last_output = time.monotonic()
            while active:
                if os.name != "nt" and NATIVE_INPUT is not None and select.select([NATIVE_INPUT], [], [], 0)[0]:
                    # A download owns its port. Chrome closes stdin on cancellation.
                    if not NATIVE_INPUT.peek(1):
                        raise NativePipeClosed("Chrome disconnected during download.")
                try:
                    source, line = pending.get(timeout=0.25)
                except queue.Empty:
                    if time.monotonic() - last_output >= DOWNLOAD_IDLE_TIMEOUT:
                        raise DownloadTimedOut(f"yt-dlp produced no output for {DOWNLOAD_IDLE_TIMEOUT}s (timeout).")
                    continue
                if line is None:
                    active.remove(source)
                    continue
                last_output = time.monotonic()
                line = redacted_output(line)
                record(source, line=line)
                # Progress stays out of the failure tail while remaining available in the full log.
                if not line.lstrip().startswith("[download]") or re.search(r"error|fail|timed out", line, re.I):
                    output_lines.append(line)
                    if len(output_lines) > 300:
                        del output_lines[0]
                percent, speed, eta = parse_progress_line(line)
                stage = "merging" if re.search(
                    r"\[(?:Merger|FixupM3u8|VideoRemuxer)\]|merging formats|remuxing video", line, re.I
                ) else "downloading"
                now = time.monotonic()
                if source == "stdout" and percent and now - last_progress_sent >= 0.5:
                    last_progress_sent = now
                    progress(job_id, f"下载中... {percent}%", percent=percent,
                             speed=speed, eta=eta, line=line, stage=stage)
                elif source == "stdout" and not line.lstrip().startswith("WARNING:") and now - last_progress_sent >= 1.8:
                    last_progress_sent = now
                    progress(job_id, line.strip()[:240] or "yt-dlp 正在处理...", line=line, stage=stage)

            return_code = process.wait(timeout=5) if hasattr(process, "poll") else process.wait()
        except (DownloadTimedOut, subprocess.TimeoutExpired, OSError) as error:
            stop_process(process)
            return_code = process.returncode if process else None
            error_line = redacted_output(f"ERROR: {error}\n")
            record("process_error", line=error_line)
            output_lines.append(error_line)
        except BaseException as error:
            stop_process(process)
            return_code = process.returncode if process else None
            record("process_interrupted", reason=str(error))
            cleanup_sidecars(output_dir, [stem], started_at)
            if isinstance(error, NativePipeClosed):
                write_state(job_id, {"status": "incomplete", "message": "下载连接中断，已保留临时数据；该旧引擎不能验证分片续传。"})
            raise
        finally:
            # The child has exited. Stop bounded reader queues before joining.
            readers_stop.set()
            # Preserve any last lines buffered during cancellation.
            for reader in readers:
                reader.join(timeout=0.25)
            while not pending.empty():
                source, line = pending.get_nowait()
                if line is not None:
                    record(source, line=redacted_output(line))
            record("process_exit", exitCode=return_code)
            write_state(job_id, {"exitCode": return_code})
            LOGGER.info("job=%s yt-dlp exited code=%s", job_id, return_code)

    combined_output = "".join(output_lines)
    output_path = exact_mp4_file(output_dir, stem, started_at)
    if output_path:
        if return_code != 0:
            write_state(job_id, {"unverifiedOutput": True, "validationPending": False})
            raise OutputValidationError(f"yt-dlp 退出码为 {return_code}，无法确认所选资源完整。文件已保留。")
        emit_event({"type": "finalizing", "event": "finalizing", "jobId": job_id,
                    "message": "正在校验最终 MP4…", "outputPath": str(output_path)})
        _, probe = validate_final_output(job_id, output_path, message.get("expectedDuration") or 0,
                                        requires_audio(message), message.get("enforceDuration", False),
                                        message.get("expectedHeight", 0))
        if return_code != 0 and probe["warningCount"] and message.get("kind") in ("hls_master", "hls_media"):
            write_state(job_id, {"unverifiedOutput": True})
            raise OutputValidationError("yt-dlp 失败，成品与预期时长不符。文件已保留，可重试。")
        if return_code != 0:
            progress(job_id, "末尾报错，但最终 MP4 已通过校验。", percent="100", stage="merging")
        return output_path, combined_output, started_at

    LOGGER.info("job=%s final_exists=false output=%s", job_id, expected_output_path)
    if return_code is not None and return_code != 0:
        combined_output += f"\nyt-dlp exited with code {return_code} and no valid MP4 was found."
    else:
        combined_output += "\nDownload finished, but no valid MP4 video output was found."
    return None, combined_output, started_at


def expired_media_status(output):
    status = http_failure_status(output)
    return status if status in (403, 410) else None


def media_url_diagnostics(url):
    parsed = urlsplit(url)
    expiry = {key: value if value.isdigit() else "present" for key, value in parse_qsl(parsed.query)
              if key.lower() in ("e", "exp", "expire", "expires", "expiry")}
    return {"host": parsed.hostname, "expiry": expiry,
            "urlHash": hashlib.sha256(url.encode("utf-8")).hexdigest()[:16]}


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
    allow_cookie_fallback = (message.get("settings") or {}).get("autoCookies", False) is True and message.get("kind") not in ("hls_master", "hls_media", "mp4", "webm")
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
        if allow_cookie_fallback and cookie_store_failed(output):
            allow_cookie_fallback = False
            progress(job_id, "无法读取 Chrome Cookie，正在尝试使用页面已捕获的请求上下文…")
            message = {**message, "settings": {**(message.get("settings") or {}), "autoCookies": False}}
            output_path, output, _ = run_ytdlp_attempt(job_id, message, target_url, output_dir, stem, "页面请求上下文")
            combined.append(output)
            if output_path:
                return output_path, "\n".join(combined), earliest_started_at
            # Keep all attempts on disk and classify the actual request failure after fallback.
            combined = [output]
        if http_failure_status(output) in (401, 403, 404, 410) or attempt >= attempts or not is_retryable_failure(output):
            break
        progress(job_id, f"网络或 HLS 分片暂时失败，准备重试 {attempt + 1}/{attempts}...")
        time.sleep(min(2, attempt))
    return None, "\n".join(combined), earliest_started_at


def clean_header_value(value):
    return re.sub(r"[\r\n]+", " ", str(value or "")).strip()


def ffmpeg_http_headers(message):
    headers = message.get("headers") or {}
    page_url = message.get("pageUrl") or ""
    values = {
        "Referer": headers.get("referer") or message.get("referer") or page_url,
        "User-Agent": headers.get("user-agent") or "Mozilla/5.0 DarrenVideoHelper/1.2.0",
        "Cookie": headers.get("cookie") or "",
        "Origin": headers.get("origin") or "",
        "Accept-Language": headers.get("accept-language") or "",
    }
    return "".join(
        f"{name}: {clean_header_value(value)}\r\n"
        for name, value in values.items()
        if clean_header_value(value)
    )


def build_ffmpeg_dash_command(message, video_url, audio_url, output_path):
    ffmpeg = tool_path("ffmpeg")
    video_url = validate_url(video_url)
    audio_url = validate_url(audio_url)
    header_block = ffmpeg_http_headers(message)
    command = [ffmpeg, "-hide_banner", "-y", "-loglevel", "info"]
    if header_block:
        command.extend(["-headers", header_block])
    command.extend(["-i", video_url])
    if header_block:
        command.extend(["-headers", header_block])
    command.extend([
        "-i", audio_url,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c", "copy",
        "-movflags", "+faststart",
        str(output_path),
    ])
    return command


def run_bilibili_dash_attempt(job_id, message, output_dir, stem):
    direct = message.get("directMedia") or {}
    video_urls = [direct.get("videoUrl"), *(direct.get("videoBackupUrls") or [])]
    audio_urls = [direct.get("audioUrl"), *(direct.get("audioBackupUrls") or [])]
    video_urls = list(dict.fromkeys(url for url in video_urls if url))[:3]
    audio_urls = list(dict.fromkeys(url for url in audio_urls if url))[:3]
    if not video_urls or not audio_urls:
        return None, "Bilibili playinfo did not contain both video and audio DASH URLs.", time.time()

    output_path = output_dir / f"{stem}.mp4"
    started_at = time.time()
    outputs = []
    attempt_count = max(len(video_urls), len(audio_urls))
    for index in range(attempt_count):
        video_url = video_urls[min(index, len(video_urls) - 1)]
        audio_url = audio_urls[min(index, len(audio_urls) - 1)]
        try:
            output_path.unlink()
        except OSError:
            pass
        progress(
            job_id,
            f"正在下载并合并 Bilibili DASH 音视频（线路 {index + 1}/{attempt_count}）...",
            stage="merging",
        )
        command = build_ffmpeg_dash_command(message, video_url, audio_url, output_path)
        LOGGER.info(
            "job=%s bilibili ffmpeg command=%s",
            job_id,
            json.dumps(redacted_command(command), ensure_ascii=False),
        )
        process = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
        )
        output = process.stdout or ""
        outputs.append(output)
        if process.returncode == 0 and output_path.is_file():
            try:
                probe = ffprobe_info(output_path)
                if not probe.get("hasAudio"):
                    raise RuntimeError("merged MP4 does not contain audio")
            except Exception as error:
                outputs.append(f"Bilibili DASH output validation failed: {error}")
            else:
                return output_path, "\n".join(outputs), started_at
        try:
            output_path.unlink()
        except OSError:
            pass
    return None, "\n".join(outputs), started_at


def legacy_download(message):
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

    LOGGER.info("job=%s url_lifecycle detectedAt=%s downloadStartedAt=%s context=%s beforeHash=%s afterHash=%s",
                job_id, message.get("detectedAt"), message.get("downloadStartedAt") or int(time.time() * 1000),
                json.dumps(media_url_diagnostics(message.get("url") or "")),
                message.get("refreshBeforeHash"), message.get("refreshAfterHash"))
    title = message.get("sourceTitle") or message.get("pageTitle") or "video"
    stem = sanitize_filename(title)
    saved = read_state(job_id)
    if verify_saved_output(job_id, saved):
        return
    if saved.get("outputPath"):
        output_path = Path(saved["outputPath"])
        output_dir, stem = output_path.parent, output_path.stem
    else:
        stem = f"{stem.encode('utf-8')[:160].decode('utf-8', errors='ignore')} {hashlib.sha256(job_id.encode()).hexdigest()[:24]}"
    write_state(job_id, {"outputPath": str(output_dir / (stem + ".mp4")),
                         "expectedDuration": message.get("expectedDuration") or 0,
                         "enforceDuration": message.get("enforceDuration", False),
                         "expectedHeight": message.get("expectedHeight", 0),
                         "verifyDecode": message.get("exactSelection", False),
                         "requireAudio": requires_audio(message)})
    emit_event({"type": "download_started", "event": "download_started", "jobId": job_id,
                "outputPath": str(output_dir / (stem + ".mp4")), "message": "开始下载或续传…"})

    progress(job_id, "Checking yt-dlp, ffmpeg and ffprobe...")
    tool_path("yt-dlp")
    tool_path("ffmpeg")
    tool_path("ffprobe")

    stream_url = validate_url(message.get("url"))
    if message.get("renditionMasterUrl"):
        stream_url = validate_url(message["renditionMasterUrl"])
        message = {**message, "headers": message.get("renditionMasterHeaders") or {}}

    page_url = message.get("pageUrl") or ""
    kind = message.get("kind") or ""
    prefer_page = bool(message.get("preferPageUrl"))

    existing = exact_mp4_file(output_dir, stem, 0)
    if existing and (saved.get("unverifiedOutput") or saved.get("verifyDecode") and saved.get("exitCode") not in (None, 0)):
        preserved = existing.with_name(f"{existing.stem}.unverified-{time.time_ns()}.mp4")
        existing.rename(preserved)
        write_state(job_id, {"unverifiedOutput": False, "validationPending": False})
        existing = None
    if existing:
        existing, probe = validate_final_output(job_id, existing, message.get("expectedDuration") or 0,
                                                requires_audio(message), message.get("enforceDuration", False),
                                        message.get("expectedHeight", 0), message.get("exactSelection", False))
        cleanup_sidecars(output_dir, [stem], 0, keep_path=existing)
        complete(job_id, existing, probe)
        return
    output_path = None
    write_state(job_id, {"exitCode": None, "validationPending": False})
    first_output = ""
    first_started_at = time.time()
    first_target = page_url if (prefer_page or kind == "segment") and page_url else stream_url
    if kind == "bilibili_dash" and message.get("directMedia"):
        output_path, first_output, first_started_at = run_bilibili_dash_attempt(
            job_id,
            message,
            output_dir,
            stem,
        )
    else:
        output_path, first_output, first_started_at = run_ytdlp_with_retries(
            job_id,
            message,
            first_target,
            output_dir,
            stem,
            "第一步",
            attempts=1 if message.get("refreshAttempt") else 2
        )

    if not output_path and message.get("exactSelection") and kind in ("hls_master", "hls_media") and expired_media_status(first_output):
        cleanup_sidecars(output_dir, [stem], first_started_at)
        incomplete(job_id, classify_failure(first_output) + " 请刷新检测后重新选择该资源。", first_output[-8000:])
        return

    if not output_path and kind in ("hls_master", "hls_media") and expired_media_status(first_output):
        status = expired_media_status(first_output)
        cleanup_sidecars(output_dir, [stem], first_started_at)
        LOGGER.warning("job=%s media_url_expired status=%s detectedAt=%s downloadStartedAt=%s context=%s refreshAttempt=%s",
                       job_id, status, message.get("detectedAt"), message.get("downloadStartedAt"),
                       json.dumps(media_url_diagnostics(first_target)), message.get("refreshAttempt", 0))
        if message.get("refreshAttempt", 0) >= 1:
            incomplete(job_id, "重新获取链接后仍失败。" + classify_failure(first_output))
        else:
            write_state(job_id, {"status": "incomplete", "message": "等待新媒体链接以续传。"})
            send_message({"type": "refresh_required", "jobId": job_id, "status": status,
                          "exitCode": read_state(job_id).get("exitCode"), "details": classify_failure(first_output),
                          "message": "正在重新检测播放器的 HLS 链接…"})
        return

    used_stems = [stem]
    allow_page_fallback = message.get("allowPageFallback") is True
    if (
        not output_path
        and allow_page_fallback
        and page_url
        and (page_url != first_target or kind == "bilibili_dash")
    ):
        progress(job_id, "视频流 URL 失败，回退使用当前页面 URL...")
        fallback_stem = stem
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
        temp = job_temp_dir(output_dir, stem)
        if any(resume_sidecar(p.name[len(stem):]) for p in matching_files(output_dir, [stem], 0)
               + (matching_files(temp, [stem], 0) if temp.is_dir() else [])):
            incomplete(job_id, "下载未完成，临时数据已保留；可重新尝试。" + classify_failure(first_output), first_output[-8000:])
            return
        raise RuntimeError(classify_failure(first_output) + "\n\n" + first_output[-8000:])

    output_path, probe = validate_final_output(
        job_id,
        output_path,
        expected_duration=message.get("expectedDuration") or 0,
        require_audio=requires_audio(message),
        enforce_duration=message.get("enforceDuration", False),
        expected_height=message.get("expectedHeight", 0),
        verify_decode=message.get("exactSelection", False),
    )
    cleanup_sidecars(output_dir, used_stems, first_started_at, keep_path=output_path)
    complete(job_id, output_path, probe)
    LOGGER.info(
        "job=%s completed output=%s size=%s duration=%s video_streams=%s audio_streams=%s",
        job_id,
        output_path,
        probe.get("fileSize", 0),
        probe.get("duration", 0),
        probe.get("videoStreams", 0),
        probe.get("audioStreams", 0),
    )


def guarded_download(message):
    job_id = message.get("jobId") or "job"
    try:
        run_download(message)
        return True
    except NativePipeClosed:
        LOGGER.warning("job=%s response pipe closed", job_id)
        return False
    except OutputValidationError as error:
        saved = read_state(job_id)
        path = Path(saved.get("outputPath") or "")
        if path.parent.is_dir() and saved.get("outputPath"):
            cleanup_sidecars(path.parent, [path.stem], 0)
        incomplete(job_id, str(error))
        return True
    except FileNotFoundError as error:
        missing = str(error)
        LOGGER.exception("job=%s required tool missing: %s", job_id, missing)
        if missing in ("yt-dlp", "ffmpeg", "ffprobe"):
            fail(job_id, "yt-dlp、ffmpeg 或 ffprobe 缺失。请重新安装 Darren Video Helper。", details=missing)
        else:
            fail(job_id, f"内置下载工具缺失：{missing}", details=missing)
        return True
    except OSError as error:
        text="磁盘空间不足，任务已停止，临时数据已保留。" if error.errno in (28,122) else "输出文件不可写或媒体工具无法运行，请检查目录及依赖。"
        saved=read_state(job_id);summary=checkpoint_summary(saved.get("workDir") or "") if saved.get("engine")=="checkpoint-hls" else {"canResume":False}
        write_state(job_id,{"status":"failed","errorCode":"DISK_FULL" if error.errno in (28,122) else "FILE_IO",**summary})
        fail(job_id,text,details=text)
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


def handle_message(message):
    validate_native_message(message)
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
        if action == "diagnostics":
            page = diagnostic_page(job_id, max(0, int(message.get("offset") or 0)))
            send_message({"type": "job_diagnostics", "jobId": job_id, **page})
            return True
        if action == "open":
            saved=read_state(job_id);target=Path(saved.get("outputPath") or "")
            if sys.platform!="darwin" or saved.get("status")!="completed" or not target.is_file() or target.is_symlink():
                raise RuntimeError("Only verified completed macOS outputs can be opened")
            subprocess.run(["/usr/bin/open","-R",str(target)],check=True,timeout=10)
            send_message({"type":"open_ack","jobId":job_id})
            return True
        if action == "cancel":
            control = state_path(job_id).with_suffix(".control.json")
            STATE_DIR.mkdir(parents=True,exist_ok=True,mode=0o700)
            keep_data = message.get("keepData") is not False
            atomic_json(control,{"cancel": True, "keepData": keep_data, "attemptId": message.get("attemptId")})
            if not keep_data:
                try:
                    with job_lock(job_id): clear_inactive_data(job_id)
                except JobBusy: pass  # The active engine consumes the same cancellation marker.
            send_message({"type": "cancel_ack", "jobId": job_id})
            return True
        if action == "status":
            saved = read_state(job_id)
            active = False
            try:
                with job_lock(job_id):
                    saved = read_state(job_id)
                    # Query never removes media or starts a downloader.
                    if saved.get("engine") == "checkpoint-hls":
                        saved = inspect_hls_state(job_id, saved)
                    elif saved and saved.get("status") != "completed":
                        path = Path(saved.get("outputPath") or "")
                        can_verify = not (saved.get("unverifiedOutput") or saved.get("validationPending")
                                          or legacy_decode_timeout(saved.get("error") or ""))
                        successful_exit = saved.get("exitCode") == 0
                        if can_verify and successful_exit and (path.is_file() or saved.get("status") not in ("failed", "incomplete")):
                            try:
                                _, probe = validate_final_output(job_id, path, saved.get("expectedDuration"),
                                                                 saved.get("requireAudio"), saved.get("enforceDuration", False),
                                                                 saved.get("expectedHeight", 0), saved.get("verifyDecode", False))
                                saved = write_state(job_id, {**probe, "status": "completed", "message": "已校验最终 MP4。",
                                                             "error": "", "details": ""})
                            except Exception as error:
                                saved = write_state(job_id, {"status": "incomplete", "message": str(error)})
            except JobBusy:
                active = True
            send_message({"type": "job_status", "jobId": job_id, "state": saved, "active": active})
            return True
        if action != "download":
            raise RuntimeError("Unknown native host action.")
        with job_lock(job_id):
            control = state_path(job_id).with_suffix(".control.json")
            if control.exists():
                try: pending_control=json.loads(control.read_text())
                except ValueError: pending_control={}
                if pending_control.get("attemptId") and pending_control.get("attemptId")==message.get("attemptId"):
                    send_message({"type":"cancelled","jobId":job_id,"attemptId":message.get("attemptId"),"canResume":False,"message":"此派发已被用户取消，未启动下载。"})
                    return True
                control.unlink()
            JOB_CONTEXT[job_id] = {"attemptId": message.get("attemptId") or str(time.time_ns())}
            write_state(job_id, {"currentAttemptId": JOB_CONTEXT[job_id]["attemptId"]})
            TERMINAL_JOB_TYPES.pop(job_id, None)
            return guarded_download(message)
    except JobBusy as error:
        send_message({"type": "job_busy", "jobId": job_id, "message": str(error), "active": True})
        return True
    except NativePipeClosed:
        return False
    except Exception as error:
        fail(job_id, str(error))
        return True


def main():
    global NATIVE_INPUT
    for origin in sys.argv[1:]:
        if origin.startswith("chrome-extension://") and origin != "chrome-extension://mabnjnddplpelefjgohbjcoajnimpgna/":
            raise RuntimeError("Unexpected extension origin")
    setup_logging()
    def interrupted(_signum, _frame):
        raise NativePipeClosed("Native host stopped")
    signal.signal(signal.SIGTERM, interrupted)
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
            "toolVersions": TOOL_VERSIONS,
            "outputDir": str(DEFAULT_OUTPUT_DIR),
            "logPath": str(LOG_PATH),
        }))
        LOGGER.info("host exit reason=self-test")
        return
    if len(sys.argv) > 1 and sys.argv[1] == "--recover-legacy-outputs":
        recover_legacy_outputs()
        return

    NATIVE_INPUT = sys.stdin.buffer
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
    finally:
        NATIVE_INPUT = None


def validate_native_message(message):
    if not isinstance(message, dict): raise RuntimeError("Native message must be an object")
    action = message.get("action")
    if action not in ("ping", "status", "diagnostics", "download", "cancel", "open"):
        raise RuntimeError("Unknown native action")
    job_id = message.get("jobId")
    if action != "ping" and (not isinstance(job_id,str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9:._-]{0,127}",job_id)):
        raise RuntimeError("Invalid job ID")
    if action == "download":
        remote_url(message.get("url"))
        for field in ("pageUrl","renditionUrl","renditionAudioUrl","renditionMasterUrl","masterUrl"):
            if message.get(field): remote_url(message[field])
        if not isinstance(message.get("settings",{}),dict) or not isinstance(message.get("headers",{}),dict):
            raise RuntimeError("Invalid native download settings")
        for container in ("headers","renditionMasterHeaders"):
            headers=message.get(container) or {}
            if not isinstance(headers,dict) or len(headers)>50:raise RuntimeError("Invalid request headers")
            for key,value in headers.items():
                if not isinstance(key,str) or not isinstance(value,str) or len(value)>16384 or re.search(r"[\r\n\x00]",key+value):
                    raise RuntimeError("Invalid request header")
        direct=message.get("directMedia") or {}
        if not isinstance(direct,dict):raise RuntimeError("Invalid direct media")
        for field in ("videoUrl","audioUrl"):
            if direct.get(field):remote_url(direct[field])
        for field in ("videoBackupUrls","audioBackupUrls"):
            values=direct.get(field) or []
            if not isinstance(values,list) or len(values)>30:raise RuntimeError("Invalid backup media")
            for url in values:remote_url(url)
        for key in ("expectedDuration","expectedHeight","selectedHeight"):
            if key in message:
                value=message[key]
                if not isinstance(value,(int,float)) or not math.isfinite(value) or value<0 or value>604800:raise RuntimeError("Invalid media dimensions or duration")
        for key in ("sourceTitle","pageTitle"):
            if key in message and (not isinstance(message[key],str) or len(message[key])>2000): raise RuntimeError("Invalid title")


def native_cancel_check(job_id):
    control = state_path(job_id).with_suffix(".control.json")
    if control.is_file() and not control.is_symlink():
        try: saved=json.loads(control.read_text())
        except ValueError: saved={}
        if saved.get("cancel") and (not saved.get("attemptId") or saved.get("attemptId")==JOB_CONTEXT.get(job_id,{}).get("attemptId")): raise HlsCancelled(saved.get("keepData",True))
    if os.name != "nt" and NATIVE_INPUT is not None:
        try:
            if select.select([NATIVE_INPUT],[],[],0)[0] and not NATIVE_INPUT.peek(1):raise HlsCancelled(True,True)
        except (ValueError,OSError): raise HlsCancelled(True,True)


def checkpoint_summary(root, verify=True):
    try:
        root=Path(root)
        if root.is_symlink() or not root.is_dir(): return {"canResume":False}
        path=root/"checkpoint.json"
        if path.is_symlink() or path.stat().st_size>32*1024*1024:return {"canResume":False}
        data=json.loads(path.read_text());entries=data.get("completed",{}).copy()
        receipts=root/"receipts.jsonl"
        if receipts.is_file() and not receipts.is_symlink():
            for line in receipts.open():
                try:
                    receipt=json.loads(line);entries[receipt["key"]]=receipt["record"]
                except (ValueError,KeyError,TypeError):continue
        count=0;size=0
        for key,record in entries.items():
            if not re.fullmatch(r"\d+:\d+",key):continue
            path=root/("segment-"+key.replace(":","-")+".bin")
            if path.is_file() and not path.is_symlink() and path.stat().st_size==record.get("bytes"):
                if not verify or sha_file(path)==record.get("sha256"):count+=1;size+=path.stat().st_size
        return {"canResume":bool(count) and not data.get("resumeBlocked") and data.get("state")!="completed",
                "fragmentsDone":count,"fragmentsTotal":sum(len(t["segments"]) for t in data.get("tracks",[])),
                "downloadedBytes":size,"checkpointState":data.get("state"),"errorCode":data.get("lastError")}
    except (OSError,ValueError,KeyError,TypeError):return {"canResume":False}


def clear_inactive_data(job_id):
    saved=read_state(job_id)
    if saved.get("status")=="completed": return
    work=Path(saved.get("workDir") or "")
    token=hashlib.sha256(job_id.encode()).hexdigest()[:32]
    if saved.get("engine")=="checkpoint-hls":
        if work.name!=token or work.parent.name!=".darren-video-helper" or work.is_symlink(): return
        safe_directory(work)
        path=work/"checkpoint.json"
        if path.is_symlink() or not path.is_file(): return
        data=json.loads(path.read_text())
        if data.get("jobId")!=job_id: return
        for item in work.iterdir():
            if item.name!="checkpoint.json" and item.is_file() and not item.is_symlink(): item.unlink()
        data.update(completed={},assets={},muxReady=False,state="cancelled",canResume=False)
        atomic_json(path,data)
    elif saved.get("engine")=="legacy-isolated":
        if work.parent.name!=token or work.parent.parent.name!=".darren-video-helper" or not re.fullmatch(r"legacy-[0-9a-f]{32}",work.name): return
        safe_directory(work);shutil.rmtree(work)
    write_state(job_id,{"status":"cancelled","canResume":False,"fragmentsDone":0,"downloadedBytes":0,"message":"本任务恢复数据已清理。"})


def inspect_hls_state(job_id, saved):
    if saved.get("status") == "completed": return saved
    summary=checkpoint_summary(saved.get("workDir") or "",verify=True)
    if saved.get("errorCode") in ("IDENTITY_CHANGED","CONTENT_CHANGED","PLAYLIST_CHANGED","CHECKPOINT_INVALID"):
        summary["canResume"]=False
    status=saved.get("status")
    if status in ("downloading","recovering","verifying","merging","resuming","diagnosing"):
        status="attention" if summary.get("canResume") else "incomplete"
    return write_state(job_id,{**summary,"status":status or "incomplete","phase":status,
        "message":saved.get("message") if saved.get("status") in ("failed","attention","completed","cancelled") else
            ("连接已中断，已找到可验证分片；可验证后续传。" if summary.get("canResume") else "连接已中断，没有可验证的续传数据；可重试。")})


def publish_legacy_output(job_id, candidate, probe):
    context=JOB_CONTEXT[job_id];root=safe_directory(context["publishRoot"])
    candidate=Path(candidate)
    work=Path(context["workDir"])
    if work not in candidate.parents or candidate.is_symlink(): raise OutputValidationError("Unexpected output location")
    title=safe_title(context.get("sourceTitle"));digest=sha_file(candidate)
    for n in range(1,10000):
        final=root/(title+(f" ({n})" if n>1 else "")+".mp4")
        write_state(job_id,{"publishingPath":str(final),"candidateSha256":digest})
        try:os.link(candidate,final)
        except FileExistsError:continue
        candidate.unlink()
        shutil.rmtree(work)
        write_state(job_id,{"outputPath":str(final),"canResume":False,"integrityVerified":True})
        context.pop("publishRoot",None)
        return final
    raise OutputValidationError("Too many filename conflicts")


def run_download(message):
    job_id=message['jobId'];settings=message.get('settings') or {}
    configured=str(settings.get('outputDir') or DEFAULT_OUTPUT_DIR)
    if '..' in Path(configured).parts or not Path(configured).expanduser().is_absolute(): raise RuntimeError('输出目录必须为绝对路径，且不能包含 ..')
    output=safe_directory(Path(configured).expanduser())
    if message.get('kind') in ('hls_master','hls_media'):
        work=output/'.darren-video-helper'/hashlib.sha256(job_id.encode()).hexdigest()[:32]
        prior=read_state(job_id)
        if prior.get('outputPath') and prior.get('engine')!='checkpoint-hls' and not (work/'checkpoint.json').is_file() and prior.get('status')!='completed':
            text='旧版任务没有可验证的分片检查点，不能承诺续传。旧文件已保留；请重新检测并从资源卡片创建新任务。'
            write_state(job_id,{'status':'attention','canResume':False,'errorCode':'LEGACY_CHECKPOINT_MISSING','message':text})
            emit_event({'type':'attention','jobId':job_id,'message':text,'error':text,'canResume':False,'errorCode':'LEGACY_CHECKPOINT_MISSING'})
            return
        write_state(job_id,{'engine':'checkpoint-hls','workDir':str(work),'status':'diagnosing','phase':'diagnosing','canResume':False})
        emit_event({'type':'download_started','jobId':job_id,'message':'正在检查 HLS 清单与本地检查点…','canResume':False})
        def notify(**fields):
            stage=fields.pop('stage');text=fields.pop('message')
            if stage in ('attention','failed'): return
            with job_log(job_id) as record:
                record('hls_progress',stage=stage,fragmentsDone=fields.get('fragmentsDone'),fragmentsTotal=fields.get('fragmentsTotal'),
                       downloadedBytes=fields.get('downloadedBytes'),httpStatus=fields.get('httpStatus'))
            status=stage if stage in ('downloading','recovering','diagnosing','resuming','verifying','attention','failed') else 'merging' if stage=='merging' else 'downloading'
            write_state(job_id,{'status':status,'phase':stage,'message':text,**fields})
            emit_event({'type':'progress','jobId':job_id,'stage':stage,'message':text,**fields})
        engine=None
        try:
            engine=HlsEngine(message,output,tool_path,notify,lambda:native_cancel_check(job_id))
            path,probe=engine.execute()
            write_state(job_id,{'exitCode':0,'integrityVerified':True,'canResume':False,'phase':'completed'})
            complete(job_id,path,probe)
        except HlsCancelled as error:
            summary=checkpoint_summary(work)
            state='incomplete' if error.disconnected else 'cancelled'
            write_state(job_id,{'status':state,'phase':state,'message':str(error),**summary})
            if not error.disconnected:emit_event({'type':'cancelled','jobId':job_id,'message':str(error),**summary})
            return
        except HlsError as error:
            summary=checkpoint_summary(work)
            summary.update(errorCode=error.code,httpStatus=error.status)
            if error.code in ('IDENTITY_CHANGED','CONTENT_CHANGED','PLAYLIST_CHANGED','CHECKPOINT_INVALID'):summary['canResume']=False
            status='attention' if error.refresh else 'failed'
            write_state(job_id,{'status':status,'phase':status,'error':str(error),'message':str(error),'exitCode':None,**summary})
            if error.refresh and not message.get('refreshAttempt'):
                send_message({'type':'refresh_required','jobId':job_id,'attemptId':JOB_CONTEXT[job_id]['attemptId'],
                    'status':error.status,'message':str(error),'details':str(error),'errorCode':error.code,**summary})
            else:
                emit_event({'type':'attention' if error.refresh else 'failed','jobId':job_id,'message':str(error),
                    'error':str(error),'errorCode':error.code,**summary})
                TERMINAL_JOB_TYPES[job_id]='failed'
        return
    # Existing page/DASH/MP4 pipeline remains, isolated from final user-visible output.
    saved=read_state(job_id)
    if saved.get('status')=='completed' and saved.get('outputPath') and saved.get('candidateSha256'):
        path=Path(saved['outputPath'])
        if path.parent==output and path.is_file() and not path.is_symlink() and sha_file(path)==saved['candidateSha256']:
            _,probe=validate_final_output(job_id,path,verify_decode=True);complete(job_id,path,probe);return
        raise OutputValidationError('已完成文件已移除或改变，未自动覆盖。')
    work=safe_directory(output/'.darren-video-helper'/hashlib.sha256(job_id.encode()).hexdigest()[:32]/('legacy-'+uuid.uuid4().hex))
    JOB_CONTEXT[job_id].update(publishRoot=str(output),workDir=str(work),sourceTitle=message.get('sourceTitle') or message.get('pageTitle'))
    # Legacy extraction cannot prove fragment identity across URL refresh; retry in a new attempt directory.
    write_state(job_id,{'outputPath':'','engine':'legacy-isolated','workDir':str(work),'canResume':False})
    isolated={**message,'settings':{**settings,'outputDir':str(work)},'enforceDuration':bool(message.get('expectedDuration'))}
    legacy_download(isolated)



if __name__ == "__main__":
    main()
