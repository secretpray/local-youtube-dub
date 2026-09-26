"""Download a YouTube audio track and produce timed local ASR segments.

    transcribe_video.py VIDEO_ID [START] [WINDOW] [auto|en|es|de]

Prints one JSON object: the segments, or {"error", "code", "params"} where
code names a cause the extension can explain (see DubError below).
"""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


PROJECT = Path(__file__).resolve().parent.parent
CACHE = PROJECT / "cache"
os.environ.setdefault("HF_HOME", str(CACHE / "huggingface"))


LANGUAGES = {"en", "es", "de"}
# The sherpa-onnx engine (Windows): Whisper small as int8 ONNX, pinned to a
# revision so setup.ps1's checksums keep matching, and Silero VAD for timing.
SHERPA_WHISPER = ("csukuangfj/sherpa-onnx-whisper-small",
                  "8f3c18b358db4d1f2fc1eae49d75cd20989e4309")
SILERO_VAD = CACHE / "models" / "silero_vad.onnx"
MODEL_SHERPA = "sherpa-onnx/whisper-small-int8"
RATE = 16000


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


@contextmanager
def exclusive(path):
    """Holds an exclusive lock on path, waiting for another process to let go."""
    with open(path, "w") as handle:
        if os.name != "nt":
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX)
            yield
            return
        import msvcrt
        # msvcrt.LK_LOCK gives up after ten seconds; a download takes minutes.
        while True:
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except OSError:
                time.sleep(0.5)
        try:
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def audio_source(video_id):
    # Two recognition requests for one video must not download it twice at once.
    with exclusive(CACHE / f"{video_id}.download.lock"):
        return _audio_source(video_id)


AUDIO_SUFFIXES = {".m4a", ".webm", ".opus", ".mp3", ".mp4", ".ogg"}


def prune_audio(keep, limit_mb=None):
    """Keep downloaded soundtracks under a size limit, oldest first, and
    drop clips that cancelled recognitions left behind.

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
        size = path.stat().st_size
        try:
            path.unlink(missing_ok=True)
        except OSError:
            # On Windows a file another recognition is reading can't be removed.
            continue
        total -= size
    # recognise() deletes its clip in `finally`, which never runs when the
    # host cancels recognition by killing the worker's process tree: each
    # cancelled section used to leave ~6 MB in the cache for good. No
    # recognition takes an hour, so an older clip is one of those.
    for path in CACHE.glob("*.clip-*.wav"):
        try:
            if time.time() - path.stat().st_mtime > 3600:
                path.unlink()
        except OSError:
            continue


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


def recognise(source, start_seconds, window_seconds, language_tag):
    """Speech to timed segments, relative to the section's start. MLX Whisper
    on Apple Silicon, faster-whisper on Linux and Intel Macs (the host sets
    DUB_ASR_ENGINE), both from a WAV clip cut by ffmpeg."""
    wav_path = CACHE / f"{source.stem}.clip-{start_seconds}-{window_seconds}.wav"
    if not wav_path.is_file():
        run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-ss", str(start_seconds),
             "-i", str(source), "-t", str(window_seconds), "-vn", "-ac", "1", "-ar", str(RATE),
             "-c:a", "pcm_s16le", str(wav_path)], 120)
    try:
        return recognise_wav(wav_path, language_tag)
    finally:
        wav_path.unlink(missing_ok=True)


def recognise_wav(wav_path, language_tag):
    options = {"language": language_tag} if language_tag != "auto" else {}
    if os.environ.get("DUB_ASR_ENGINE", "mlx") == "mlx":
        import mlx_whisper

        model = os.environ.get("DUB_ASR_MODEL", "mlx-community/whisper-small-mlx")
        result = mlx_whisper.transcribe(str(wav_path), path_or_hf_repo=model,
                                       verbose=None, task="transcribe", **options)
        return {"language": result.get("language"), "model": model,
                "segments": result["segments"]}
    from faster_whisper import WhisperModel

    model = os.environ.get("DUB_ASR_MODEL", "Systran/faster-whisper-small")
    whisper = WhisperModel(model, device="cpu", compute_type="int8",
                           cpu_threads=os.cpu_count() or 4)
    parts, info = whisper.transcribe(str(wav_path), vad_filter=True, **options)
    segments = [{"start": part.start, "end": part.end, "text": part.text} for part in parts]
    return {"language": info.language, "model": model, "segments": segments}


def decode_clip(source, start_seconds, window_seconds):
    """The section as 16 kHz mono float samples, decoded by PyAV: the sherpa
    engine runs where there is no ffmpeg to call (Windows)."""
    import av
    import numpy as np

    chunks, first = [], None
    end = start_seconds + window_seconds
    with av.open(str(source)) as container:
        stream = container.streams.audio[0]
        # Lands on the keyframe before the start; earlier frames are skipped
        # here and the rest of the gap is trimmed below.
        container.seek(int(start_seconds / stream.time_base), stream=stream, backward=True)
        resampler = av.AudioResampler(format="flt", layout="mono", rate=RATE)
        for frame in container.decode(stream):
            if frame.time is not None:
                if frame.time + frame.samples / frame.sample_rate <= start_seconds:
                    continue
                if frame.time >= end:
                    break
            if first is None:
                first = frame.time if frame.time is not None else start_seconds
            chunks.extend(out.to_ndarray().reshape(-1) for out in resampler.resample(frame))
        chunks.extend(out.to_ndarray().reshape(-1) for out in resampler.resample(None))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    skip = int(round(max(0.0, start_seconds - first) * RATE))
    return np.concatenate(chunks)[skip:skip + window_seconds * RATE]


def speech_pieces(audio):
    """(offset, samples) for every stretch of speech, at most 15 s long."""
    import numpy as np
    import sherpa_onnx

    vad = sherpa_onnx.VoiceActivityDetector(
        sherpa_onnx.VadModelConfig(
            silero_vad=sherpa_onnx.SileroVadModelConfig(
                model=str(SILERO_VAD), min_silence_duration=0.3, max_speech_duration=15),
            sample_rate=RATE),
        buffer_size_in_seconds=len(audio) / RATE + 10)
    pieces = []

    def collect():
        while not vad.empty():
            pieces.append((vad.front.start, np.asarray(vad.front.samples, dtype=np.float32)))
            vad.pop()
    window = 512  # Silero's frame at 16 kHz
    for offset in range(0, len(audio), window):
        vad.accept_waveform(audio[offset:offset + window])
        collect()
    vad.flush()
    collect()
    return pieces


def recognise_sherpa(source, start_seconds, window_seconds, language_tag):
    """Speech to timed segments with sherpa-onnx, the engine on Windows.

    Whisper there takes at most 30 s at a time, so Silero VAD first cuts the
    section into stretches of speech; Whisper's own segment timestamps then
    split each stretch into sentences, as faster-whisper's segments are.
    """
    from collections import Counter
    import sherpa_onnx
    from huggingface_hub import hf_hub_download

    repo, revision = SHERPA_WHISPER
    threads = int(os.environ.get("DUB_ASR_THREADS") or os.cpu_count() or 4)

    def whisper(language):
        def path(name):
            return hf_hub_download(repo, f"small-{name}", revision=revision,
                                   local_files_only=True)
        return sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=path("encoder.int8.onnx"), decoder=path("decoder.int8.onnx"),
            tokens=path("tokens.txt"), language="" if language == "auto" else language,
            num_threads=threads, enable_segment_timestamps=True)

    def decode(recognizer, pieces):
        streams = []
        for _, samples in pieces:
            stream = recognizer.create_stream()
            stream.accept_waveform(RATE, samples)
            streams.append(stream)
        recognizer.decode_streams(streams)
        return [stream.result for stream in streams]

    audio = decode_clip(source, start_seconds, window_seconds)
    pieces = speech_pieces(audio)
    recognizer = whisper(language_tag)
    if not pieces:
        if language_tag != "auto":
            return {"language": language_tag, "model": MODEL_SHERPA, "segments": []}
        # No speech to go by: let Whisper guess from the opening, as the other
        # engines do on a silent section, and dub nothing here.
        language = decode(recognizer, [(0, audio[:30 * RATE])])[0].lang if len(audio) else None
        return {"language": language, "model": MODEL_SHERPA, "segments": []}
    results = decode(recognizer, pieces)
    language = language_tag
    if language_tag == "auto":
        spoken = Counter()
        for (_, samples), result in zip(pieces, results):
            spoken[result.lang] += len(samples)
        language = spoken.most_common(1)[0][0]
        # Whisper guesses per stretch here, and a short one now and then comes
        # out as a neighbouring language. Those are decoded again in the
        # language of the rest instead of being translated from gibberish.
        stray = [index for index, result in enumerate(results) if result.lang != language]
        if language in LANGUAGES and stray:
            recognizer = None  # one Whisper in memory at a time
            again = decode(whisper(language), [pieces[index] for index in stray])
            for index, result in zip(stray, again):
                results[index] = result
    segments = []
    for (offset, samples), result in zip(pieces, results):
        begin, length = offset / RATE, len(samples) / RATE
        starts = [min(max(0.0, value), length) for value in result.segment_timestamps]
        texts = list(result.segment_texts)
        if not texts or len(starts) != len(texts):
            starts, texts = [0.0], [result.text]
        pending, pending_start = "", None
        for index, text in enumerate(texts):
            start = starts[index] if pending_start is None else pending_start
            end = starts[index + 1] if index + 1 < len(starts) else length
            if end - starts[index] < 0.05 and index + 1 < len(texts):
                # Two sentences stamped at the same moment: the next one carries
                # these words instead of an empty span dropping them.
                pending, pending_start = pending + text, start
                continue
            segments.append({"start": begin + start, "end": begin + end, "text": pending + text})
            pending, pending_start = "", None
    return {"language": language, "model": MODEL_SHERPA, "segments": segments}


def transcribe(video_id, start_seconds=0, window_seconds=180, language=None):
    import shutil
    engine = os.environ.get("DUB_ASR_ENGINE", "mlx")
    if engine != "sherpa" and not shutil.which("ffmpeg"):
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
    engine_for = recognise_sherpa if engine == "sherpa" else recognise
    result = engine_for(source, start_seconds, window_seconds, language_tag)
    language = result["language"]
    if language not in LANGUAGES:
        raise DubError("language_unsupported", f"detected {language or 'unknown'}",
                       language=language or "?")
    segments = [{"start": item["start"] + start_seconds,
                 "end": item["end"] + start_seconds,
                 "text": item["text"].strip()} for item in result["segments"]
                if item.get("text", "").strip() and item["end"] > item["start"]]
    payload = {"language": language, "segments": segments,
               "source": "audio-recognition", "model": result["model"],
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
