"""Local macOS Russian voice with the same JSON protocol as Piper worker."""

import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import wave


def synthesize(text, rate, directory):
    aiff = directory / "speech.aiff"
    wav_path = directory / "speech.wav"
    subprocess.run(["say", "-v", "Milena", "-r", str(rate), "-o", str(aiff), text],
                   check=True, capture_output=True, text=True)
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", str(aiff),
                    "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", str(wav_path)],
                   check=True, capture_output=True, text=True)
    with wave.open(str(wav_path), "rb") as wav:
        duration = wav.getnframes() / wav.getframerate()
    return wav_path.read_bytes(), duration


def main():
    cache = Path(__file__).resolve().parent.parent / "cache"
    cache.mkdir(exist_ok=True)
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            target = max(1.0, min(30.0, float(request.get("targetDuration", 8.0))))
            with tempfile.TemporaryDirectory(dir=cache) as directory:
                directory = Path(directory)
                data, duration = synthesize(request["text"], 180, directory)
                if duration > target * 1.05:
                    rate = max(180, min(300, round(180 * duration / target)))
                    data, duration = synthesize(request["text"], rate, directory)
            response = {"wav": base64.b64encode(data).decode("ascii"),
                        "duration": duration}
        except Exception as error:
            response = {"error": str(error)}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
