"""Download a YouTube audio track and produce timed local ASR segments.

    transcribe_video.py VIDEO_ID [START] [WINDOW] [auto|en|es|de]

Prints one JSON object: the segments, or {"error", "code", "params"} where
code names a cause the extension can explain (see DubError below).
"""

import json
import os
from pathlib import Path
import re
import subprocess
import sys


PROJECT = Path(__file__).resolve().parent.parent
CACHE = PROJECT / "cache"
os.environ.setdefault("HF_HOME", str(CACHE / "huggingface"))


LANGUAGES = {"en", "es", "de"}


class DubError(Exception):
    """A failure with a code from the extension's message catalogue."""

    def __init__(self, code, detail, **params):
        super().__init__(detail)
        self.code = code
        self.params = params


def run(command, timeout):
    result = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout).strip()
                           or f"exit code {result.returncode}")


def download_failure(output):
    """Turns yt-dlp's log into one cause. Its warnings are long and mostly
    noise; the last ERROR line is what went wrong."""
    errors = [line for line in output.splitlines() if line.startswith("ERROR:")]
    lines = errors or output.strip().splitlines() or ["?"]
    detail = lines[-1].removeprefix("ERROR: ").strip()[:300]
    if "Sign in to confirm" in output or "not a bot" in output:
        return DubError("youtube_blocked", detail)
    if "No supported JavaScript runtime" in output and "403" in output:
        return DubError("js_runtime_missing", detail)
    return DubError("download_failed", detail)


def audio_source(video_id):
    # Two recognition requests for one video must not download it twice at once.
    import fcntl
    with open(CACHE / f"{video_id}.download.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _audio_source(video_id)


AUDIO_SUFFIXES = {".m4a", ".webm", ".opus", ".mp3", ".mp4", ".ogg"}


def prune_audio(keep, limit_mb=None):
    """Keep downloaded soundtracks under a size limit, oldest first.

    Transcripts are small and stay; a soundtrack is only needed while its
    video is being recognised and is downloaded again if it is ever missing.
    """
    limit = int(limit_mb or os.environ.get("DUB_AUDIO_CACHE_MB", "1024")) * 1024 * 1024
    files = sorted((path for path in CACHE.iterdir()
                    if path.suffix in AUDIO_SUFFIXES and path.is_file()),
                   key=lambda path: path.stat().st_mtime)
    total = sum(path.stat().st_size for path in files)
    for path in files:
        if total <= limit:
            break
        if path.stem == keep:
            continue
        total -= path.stat().st_size
        path.unlink(missing_ok=True)


def _audio_source(video_id):
    candidates = [path for path in CACHE.glob(f"{video_id}.*")
                  if path.suffix not in {".json", ".wav", ".part", ".ytdl", ".lock"}
                  and path.is_file()]
    if candidates:
        return candidates[0]
    template = str(CACHE / f"{video_id}.%(ext)s")
    url = f"https://www.youtube.com/watch?v={video_id}"
    try:
        run([sys.executable, "-m", "yt_dlp", "--no-playlist", "--no-progress",
             "--format", "bestaudio/best", "--output", template, url], 900)
    except RuntimeError as error:
        raise download_failure(str(error)) from None
    candidates = [path for path in CACHE.glob(f"{video_id}.*")
                  if path.suffix not in {".json", ".wav", ".part", ".ytdl", ".lock"}
                  and path.is_file()]
    if not candidates:
        raise DubError("download_failed", "no audio file after download")
    prune_audio(keep=video_id)
    return candidates[0]


def transcribe(video_id, start_seconds=0, window_seconds=180, language=None):
    import shutil
    if not shutil.which("ffmpeg"):
        raise DubError("ffmpeg_missing", "ffmpeg not found")
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise ValueError("invalid video id")
    start_seconds = max(0, int(start_seconds))
    window_seconds = max(30, min(300, int(window_seconds)))
    end_seconds = start_seconds + window_seconds
    CACHE.mkdir(exist_ok=True)
    full_path = CACHE / f"{video_id}.asr.json"
    if full_path.is_file():
        full = json.loads(full_path.read_text(encoding="utf-8"))
        if language in LANGUAGES and full.get("language") != language:
            raise DubError("language_unsupported", f"transcript is {full.get('language')}",
                           language=full.get("language"))
        return {**full, "segments": [segment for segment in full["segments"]
                                    if segment["start"] >= start_seconds
                                    and segment["start"] < end_seconds],
                "windowStart": start_seconds, "windowEnd": end_seconds}
    language_tag = language if language in LANGUAGES else "auto"
    transcript_path = CACHE / f"{video_id}.asr-{start_seconds}-{window_seconds}-{language_tag}.json"
    if transcript_path.is_file():
        return json.loads(transcript_path.read_text(encoding="utf-8"))
    source = audio_source(video_id)
    wav_path = CACHE / f"{video_id}.clip-{start_seconds}-{window_seconds}.wav"
    if not wav_path.is_file():
        run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-ss", str(start_seconds),
             "-i", str(source), "-t", str(window_seconds), "-vn", "-ac", "1", "-ar", "16000",
             "-c:a", "pcm_s16le", str(wav_path)], 120)
    import mlx_whisper

    model = os.environ.get("DUB_ASR_MODEL", "mlx-community/whisper-small-mlx")
    options = {"language": language_tag} if language_tag != "auto" else {}
    try:
        result = mlx_whisper.transcribe(str(wav_path), path_or_hf_repo=model,
                                       verbose=None, task="transcribe", **options)
    finally:
        wav_path.unlink(missing_ok=True)
    language = result.get("language")
    if language not in LANGUAGES:
        raise DubError("language_unsupported", f"detected {language or 'unknown'}",
                       language=language or "?")
    segments = [{"start": item["start"] + start_seconds,
                 "end": item["end"] + start_seconds,
                 "text": item["text"].strip()} for item in result["segments"]
                if item.get("text", "").strip() and item["end"] > item["start"]]
    payload = {"language": language, "segments": segments,
               "source": "audio-recognition", "model": model,
               "windowStart": start_seconds, "windowEnd": end_seconds}
    transcript_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return payload


if __name__ == "__main__":
    try:
        start = int(sys.argv[2]) if len(sys.argv) > 2 else 0
        window = int(sys.argv[3]) if len(sys.argv) > 3 else 180
        language = sys.argv[4] if len(sys.argv) > 4 else "auto"
        print(json.dumps(transcribe(sys.argv[1], start, window, language),
                         ensure_ascii=False), flush=True)
    except DubError as error:
        print(json.dumps({"error": str(error), "code": error.code, "params": error.params},
                         ensure_ascii=False), flush=True)
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), flush=True)
